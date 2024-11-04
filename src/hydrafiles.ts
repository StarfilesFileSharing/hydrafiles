import { encode as base32Encode } from "https://deno.land/std@0.194.0/encoding/base32.ts";
// import WebTorrent from "npm:webtorrent";
import getConfig, { type Config } from "./config.ts";
import File, { type FileAttributes, FileDB } from "./file.ts";
import Utils from "./utils.ts";
// import Blockchain, { Block } from "./block.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";
import RPCServer from "./rpc/server.ts";
import RPCClient from "./rpc/client.ts";
import FileSystem from "./filesystem/filesystem.ts";

// TODO: IDEA: HydraTorrent - New Github repo - "Hydrafiles + WebTorrent Compatibility Layer" - Hydrafiles noes can optionally run HydraTorrent to seed files via webtorrent
// Change index hash from sha256 to infohash, then allow peers to leech files from webtorrent + normal torrent
// HydraTorrent is a WebTorrent hybrid client that plugs into Hydrafiles
// Then send a PR to WebTorrent for it to connect to the Hydrafiles network as default webseeds
// HydraTorrent is 2-way, allowing for fetching-seeding files via both hydrafiles and torrent
//
// ALSO THIS ALLOWS FOR PLAUSIBLE DENIABLITY FOR NORMAL TORRENTS
// Torrent clients can connect to the Hydrafiles network and claim they dont host any of the files they seed
// bittorrent to http proxy
// starfiles.co would use webtorrent to download files

class Hydrafiles {
	startTime: number = +new Date();
	fs: FileSystem;
	utils: Utils;
	config: Config;
	s3: S3Client | undefined;
	keyPair!: CryptoKeyPair;
	rpcServer!: RPCServer;
	rpcClient!: RPCClient;
	fileDB!: FileDB;
	// webtorrent: WebTorrent = new WebTorrent();

	constructor(customConfig: Partial<Config> = {}) {
		this.utils = new Utils(this);
		this.config = getConfig(customConfig);
		this.fs = new FileSystem(this);

		if (this.config.s3Endpoint.length) {
			console.log("Startup: Populating S3");
			this.s3 = new S3Client({ endPoint: this.config.s3Endpoint, region: "us-east-1", bucket: "uploads", accessKey: this.config.s3AccessKeyId, secretKey: this.config.s3SecretAccessKey, pathStyle: false });
		}
	}

	public async start(onUpdateFileListProgress?: (progress: number, total: number) => void): Promise<void> {
		console.log("Startup: Populating KeyPair");
		this.keyPair = await this.utils.getKeyPair();
		console.log("Startup: Populating FileDB");
		this.fileDB = await FileDB.init(this);
		console.log("Startup: Populating RPC Client & Server");
		this.rpcClient = new RPCClient(this);
		this.rpcClient.start().then(() => {
			this.rpcServer = new RPCServer(this);
			this.startBackgroundTasks(onUpdateFileListProgress);
		});
	}

	startBackgroundTasks(onUpdateFileListProgress?: (progress: number, total: number) => void): void {
		if (this.config.summarySpeed !== -1) setInterval(() => this.logState(), this.config.summarySpeed);
		if (this.config.comparePeersSpeed !== -1) {
			this.rpcClient.http.updatePeers();
			setInterval(() => this.rpcClient.http.updatePeers(), this.config.comparePeersSpeed);
		}
		if (this.config.compareFilesSpeed !== -1) {
			this.updateFileList(onUpdateFileListProgress);
			setInterval(() => this.updateFileList(onUpdateFileListProgress), this.config.compareFilesSpeed);
		}
		if (this.config.backfill) this.backfillFiles();
	}

	backfillFiles = async (): Promise<void> => {
		while (true) {
			try {
				const fileAttributes = (await this.fileDB.select(undefined, "RANDOM"))[0];
				if (!fileAttributes) return;
				const file = await this.initFile(fileAttributes, false);
				if (file) {
					console.log(`  ${file.hash}  Backfilling file`);
					await file.getFile({ logDownloads: false });
				}
			} catch (e) {
				if (this.config.logLevel === "verbose") throw e;
			}
		}
	};

	// TODO: Compare list between all peers and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
	async updateFileList(onProgress?: (progress: number, total: number) => void): Promise<void> {
		console.log(`Comparing file list`);
		let files: FileAttributes[] = [];
		const responses = await Promise.all(await this.rpcClient.fetch("http://localhost/files"));
		for (let i = 0; i < responses.length; i++) {
			if (responses[i] !== false) {
				try {
					files = files.concat((await (responses[i] as Response).json()) as FileAttributes[]);
				} catch (e) {
					if (this.config.logLevel === "verbose") console.log(e);
				}
			}
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
				const currentFile = await File.init(fileObj, this);
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

	async getHostname(): Promise<string> {
		const pubKey = await Utils.exportPublicKey(this.keyPair.publicKey);
		const xEncoded = base32Encode(new TextEncoder().encode(pubKey.x)).toLowerCase().replace(/=+$/, "");
		const yEncoded = base32Encode(new TextEncoder().encode(pubKey.y)).toLowerCase().replace(/=+$/, "");
		return `${xEncoded}.${yEncoded}`;
	}

	async logState(): Promise<void> {
		console.log(
			"\n===============================================\n========",
			new Date().toUTCString(),
			"========\n===============================================",
			"\n| Uptime: ",
			Utils.convertTime(+new Date() - this.startTime),
			"\n| Hostname: ",
			`${await this.getHostname()}`,
			"\n| Known (Network) Files:",
			await this.fileDB.count(),
			`(${Math.round((100 * (await this.fileDB.sum("size"))) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Stored Files:",
			(await this.fs.readDir("files/")).length,
			`(${Math.round((100 * await this.utils.calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Processing Files:",
			this.rpcServer.hashLocks.size,
			"\n| Known HTTP Peers:",
			(await this.rpcClient.http.getPeers()).length,
			// '\n| Seeding Torrent Files:',
			// (await webtorrentClient()).torrents.length,
			"\n| Downloads Served:",
			(await this.fileDB.sum("downloadCount")) + ` (${Math.round((((await this.fileDB.sum("downloadCount * size")) / 1024 / 1024 / 1024) * 100) / 100)}GB)`,
			"\n===============================================\n",
		);
	}

	public search = async <T extends keyof FileAttributes>(where?: { key: T; value: NonNullable<File[T]> }, orderBy?: "RANDOM" | { key: T; direction: "ASC" | "DESC" }): Promise<FileAttributes[]> => {
		return await this.fileDB.select(where, orderBy);
	};

	public async initFile(values: Partial<File>, vote = false): Promise<File | false> {
		return await File.init(values, this, vote);
	}
}

export default Hydrafiles;
