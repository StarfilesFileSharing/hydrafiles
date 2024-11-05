import type Hydrafiles from "../hydrafiles.ts";
import HTTPClient, { HTTPPeer } from "./peers/http.ts";
import RTCClient from "./peers/rtc.ts";
import File from "../file.ts";
import Utils, { type Sha256 } from "../utils.ts";

export default class RPCClient {
	private _client: Hydrafiles;
	http!: HTTPClient;
	rtc!: RTCClient;

	constructor(client: Hydrafiles) {
		this._client = client;
	}
	async start(): Promise<void> {
		this.http = await HTTPClient.init(this._client);
		this.rtc = await RTCClient.init(this._client);
	}

	public async fetch(input: RequestInfo, init?: RequestInit): Promise<Promise<Response | false>[]> {
		return [...await this.http.fetch(input, init), ...this.rtc.fetch(input, init)];
	}

	async downloadFile(hash: Sha256, size = 0): Promise<{ file: Uint8Array; signal: number } | false> {
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
		const peers = await this.http.getPeers(true);
		for (const peer of peers) {
			let fileContent: { file: Uint8Array; signal: number } | false = false;
			try {
				fileContent = await (await HTTPPeer.init(peer, this.http.db, this._client)).downloadFile(file);
			} catch (e) {
				console.error(e);
			}
			if (fileContent) return fileContent;
		}

		console.log(`  ${hash}  Downloading from WebRTC`);
		const responses = this.rtc.fetch(`http://localhost/download/${hash}`);
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
