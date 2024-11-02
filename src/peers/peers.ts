import type { FileAttributes } from "../file.ts";
import type Hydrafiles from "../hydrafiles.ts";
import { HTTPPeer } from "./HTTPPeers.ts";
import File from "../file.ts";
import Utils from "../utils.ts";

export default class Peers {
	_client: Hydrafiles;

	constructor(client: Hydrafiles) {
		this._client = client;
	}

	public async fetch(input: RequestInfo, init?: RequestInit): Promise<Promise<Response | false>[]> {
		return [...await this._client.http.fetch(input, init), ...this._client.rtc.fetch(input, init)];
	}

	async announceHTTP(): Promise<void> {
		await Promise.all([...await this._client.http.fetch(`http://localhost/announce?host=${this._client.config.publicHostname}`), ...this._client.rtc.fetch(`http://localhost/announce?host=${this._client.config.publicHostname}`)]);
	}

	// TODO: Compare list between all peers and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
	async fetchHTTPPeers(): Promise<void> {
		console.log(`Fetching peers`);
		const responses = await Promise.all(await this.fetch("http://localhost/peers"));
		for (let i = 0; i < responses.length; i++) {
			try {
				if (!(responses[i] instanceof Response)) continue;
				const response = responses[i];
				if (response instanceof Response) {
					const remotePeers = (await response.json()) as HTTPPeer[];
					for (const remotePeer of remotePeers) {
						this._client.http.add(remotePeer.host).catch((e) => {
							if (this._client.config.logLevel === "verbose") console.error(e);
						});
					}
				}
			} catch (e) {
				if (this._client.config.logLevel === "verbose") console.error(e);
			}
		}
	}

	// TODO: Compare list between all peers and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
	async compareFileList(onProgress?: (progress: number, total: number) => void): Promise<void> {
		console.log(`Comparing file list`);
		let files: FileAttributes[] = [];
		const responses = await Promise.all(await this.fetch("http://localhost/files"));
		for (let i = 0; i < responses.length; i++) {
			if (responses[i] !== false) files = files.concat((await (responses[i] as Response).json()) as FileAttributes[]);
		}

		const uniqueFiles = new Set<string>();
		files = files.filter((file) => {
			const fileString = JSON.stringify(file);
			if (!uniqueFiles.has(fileString)) {
				uniqueFiles.add(fileString);
				return true;
			}
			return false;
		});

		for (let i = 0; i < files.length; i++) {
			if (onProgress) onProgress(i, files.length);
			const newFile = files[i];
			try {
				if (typeof files[i].hash === "undefined") continue;
				const fileObj: Partial<FileAttributes> = { hash: files[i].hash };
				if (files[i].infohash) fileObj.infohash = files[i].infohash;
				const currentFile = await File.init(fileObj, this._client);
				if (!currentFile) continue;

				const keys = Object.keys(newFile) as unknown as (keyof File)[];
				for (let i = 0; i < keys.length; i++) {
					const key = keys[i] as keyof FileAttributes;
					if (["downloadCount", "voteHash", "voteNonce", "voteDifficulty"].includes(key)) continue;
					if (newFile[key] !== undefined && newFile[key] !== null && newFile[key] !== 0 && (currentFile[key] === undefined || currentFile[key] === null || currentFile[key] === 0)) {
						// @ts-expect-error:
						currentFile[key] = newFile[key];
					}
					if (newFile.voteNonce !== 0 && newFile.voteDifficulty > currentFile.voteDifficulty) {
						console.log(`  ${newFile.hash}  Checking vote nonce`);
						currentFile.checkVoteNonce(newFile["voteNonce"]);
					}
				}
				currentFile.save();
			} catch (e) {
				console.error(e);
			}
		}
		if (onProgress) onProgress(files.length, files.length);
	}

	async downloadFile(hash: string, size = 0): Promise<{ file: Uint8Array; signal: number } | false> {
		if (!this._client.utils.hasSufficientMemory(size)) {
			console.log("Reached memory limit, waiting");
			await new Promise(() => {
				const intervalId = setInterval(async () => {
					if (await this._client.utils.hasSufficientMemory(size)) clearInterval(intervalId);
				}, this._client.config.memoryThresholdReachedWait);
			});
		}

		const file = await File.init({ hash }, this._client);
		if (!file) return false;
		const peers = await this._client.http.getPeers();
		for (const peer of peers) {
			let fileContent: { file: Uint8Array; signal: number } | false = false;
			try {
				fileContent = await this._client.http.downloadFromPeer(await HTTPPeer.init(peer, this._client.http._db), file);
			} catch (e) {
				console.error(e);
			}
			if (fileContent) return fileContent;
		}

		console.log(`  ${hash}  Downloading from WebRTC`);
		const responses = this._client.rtc.fetch(`http://localhost/download/${hash}`);
		for (let i = 0; i < responses.length; i++) {
			const hash = file.hash;
			const response = await responses[i];
			const peerContent = new Uint8Array(await response.arrayBuffer());
			console.log(`  ${hash}  Validating hash`);
			const verifiedHash = await Utils.hashUint8Array(peerContent);
			console.log(`  ${hash}  Done Validating hash`);
			if (hash !== verifiedHash) return false;
			console.log(`  ${hash}  Valid hash`);

			if (file.name === undefined || file.name === null || file.name.length === 0) {
				file.name = String(response.headers.get("Content-Disposition")?.split("=")[1].replace(/"/g, "").replace(" [HYDRAFILES]", ""));
				file.save();
			}
		}

		return false;
	}
}
