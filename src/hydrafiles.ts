import { encode as base32Encode } from "https://deno.land/std@0.194.0/encoding/base32.ts";
import type WebTorrent from "https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js";
import getConfig, { type Config } from "./config.ts";
import Files, { FileAttributes } from "./file.ts";
import Utils from "./utils.ts";
// import Blockchain, { Block } from "./block.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";
import RPCServer from "./rpc/server.ts";
import RPCClient from "./rpc/client.ts";
import FileSystem from "./filesystem/filesystem.ts";
import Events from "./events.ts";
import Wallet from "./wallet.ts";
import { processingRequests } from "./rpc/routes.ts";

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
	events: Events;
	s3: S3Client | undefined;
	keyPair!: CryptoKeyPair;
	rpcServer!: RPCServer;
	rpcClient!: RPCClient;
	wallet!: Wallet;
	files!: Files;
	webtorrent?: WebTorrent;
	handleCustomRequest = async (req: Request) => {
		console.log(req);
		await new Promise<void>((resolve) => resolve()); // We do this so the function is async, for devs using the lib
		return new Response("Hello World!");
	};

	constructor(customConfig: Partial<Config> = {}) {
		this.config = getConfig(customConfig);
		this.fs = new FileSystem(this);
		this.utils = new Utils(this.config, this.fs);
		this.events = new Events();

		if (this.config.s3Endpoint.length) {
			console.log("Startup: Populating S3");
			this.s3 = new S3Client({ endPoint: this.config.s3Endpoint, region: "us-east-1", bucket: "uploads", accessKey: this.config.s3AccessKeyId, secretKey: this.config.s3SecretAccessKey, pathStyle: false });
		}
	}

	public async start(opts: { onUpdateFileListProgress?: (progress: number, total: number) => void; webtorrent?: WebTorrent } = {}): Promise<void> {
		console.log("Startup: Populating KeyPair");
		this.keyPair = await this.utils.getKeyPair();
		console.log("Startup: Populating FileDB");
		this.files = await Files.init(this);
		console.log("Startup: Populating RPC Client & Server");
		this.rpcClient = await RPCClient.init(this);
		this.rpcServer = new RPCServer(this);
		console.log("Startup: Populating Wallet");
		this.wallet = await Wallet.init(this);
		console.log("Startup: Starting WebTorrent");
		this.webtorrent = opts.webtorrent;

		this.startBackgroundTasks(opts.onUpdateFileListProgress);
	}

	startBackgroundTasks(onUpdateFileListProgress?: (progress: number, total: number) => void): void {
		if (this.config.summarySpeed !== -1) setInterval(() => this.logState(), this.config.summarySpeed);
		if (this.config.comparePeersSpeed !== -1) {
			this.rpcClient.http.updatePeers();
			setInterval(() => this.rpcClient.http.updatePeers(), this.config.comparePeersSpeed);
		}
		if (this.config.compareFilesSpeed !== -1) {
			this.files.updateFileList(onUpdateFileListProgress);
			setInterval(() => this.files.updateFileList(onUpdateFileListProgress), this.config.compareFilesSpeed);
		}
		if (this.config.backfill) this.files.backfillFiles();
	}

	public async getHostname(): Promise<string> {
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
			"\n| Uptime:",
			Utils.convertTime(+new Date() - this.startTime),
			"\n| Known HTTP Peers:",
			this.rpcClient.http.getPeers().length,
			"\n| Known RTC Peers:",
			Object.keys(this.rpcClient.rtc.peerConnections).length,
			"\n| Known (Network) Files:",
			await this.files.db.count(),
			`(${Math.round((100 * (await this.files.db.sum("size"))) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Stored Files:",
			(await this.fs.readDir("files/")).length,
			`(${Math.round((100 * await this.utils.calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Downloads Served:",
			(await this.files.db.sum("downloadCount")) + ` (${Math.round((((await this.files.db.sum("downloadCount * size")) / 1024 / 1024 / 1024) * 100) / 100)}GB)`,
			"\n| Hostname:",
			`${await this.getHostname()}`,
			"\n| Address:",
			this.wallet.address(),
			"\n| Balance:",
			await this.wallet.balance(),
			"\n| Processing Files:",
			processingRequests.size,
			// '\n| Seeding Torrent Files:',
			// (await webtorrentClient()).torrents.length,
			"\n===============================================\n",
		);
	}

	public search = async <T extends keyof FileAttributes>(where?: { key: T; value: NonNullable<FileAttributes[T]> }, orderBy?: "RANDOM" | { key: T; direction: "ASC" | "DESC" }): Promise<FileAttributes[]> => {
		return await this.files.db.select(where, orderBy);
	};
}

export default Hydrafiles;
