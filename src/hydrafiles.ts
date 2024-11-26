import type WebTorrent from "https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js";
import getConfig, { type Config } from "./config.ts";
import Files from "./file.ts";
import Utils from "./utils.ts";
// import Blockchain, { Block } from "./block.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";
import RPCServer from "./rpc/server.ts";
import RPCClient from "./rpc/client.ts";
import FileSystem from "./filesystem/filesystem.ts";
import Events from "./events.ts";
import Wallet from "./wallet.ts";
import { processingDownloads } from "./rpc/routes.ts";
import Services from "./services/services.ts";
import NameService from "./services/NameService.ts";

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
	rpcServer!: RPCServer;
	rpcClient!: RPCClient;
	files!: Files;
	filesWallet!: Wallet;
	rtcWallet!: Wallet;
	services!: Services;
	nameService!: NameService;
	webtorrent?: WebTorrent;

	constructor(customConfig: Partial<Config> = {}) {
		Wallet._client = this;
		Services._client = this;
		Files._client = this;
		RPCClient._client = this;
		RPCServer._client = this;

		this.config = getConfig(customConfig);
		this.fs = new FileSystem(this);
		this.utils = new Utils(this.config, this.fs);
		this.events = new Events();
		this.filesWallet = new Wallet();
		this.rtcWallet = new Wallet(1);
		this.services = new Services();
		this.services.addHostname((_req: Request) => new Response("Hello World!"), 0);

		if (this.config.s3Endpoint.length) {
			console.log("Startup:  Populating S3");
			this.s3 = new S3Client({ endPoint: this.config.s3Endpoint, region: "us-east-1", bucket: "uploads", accessKey: this.config.s3AccessKeyId, secretKey: this.config.s3SecretAccessKey, pathStyle: false });
		}
	}

	public async start(opts: { onUpdateFileListProgress?: (progress: number, total: number) => void; webtorrent?: WebTorrent } = {}): Promise<void> {
		if (!await this.fs.exists("/")) await this.fs.mkdir("/"); // In case of un-initiated base dir
		if (!await this.fs.exists("/files/")) await this.fs.mkdir("/files/");

		console.log("Startup:  Populating FileDB");
		this.files = await Files.init();
		console.log("Startup:  Populating RPC Client & Server");
		this.rpcClient = await RPCClient.init();
		this.rpcServer = new RPCServer();
		console.log("Startup:  Starting HTTP Server");
		await this.rpcServer.listenHTTP();
		console.log("Startup:  Starting WebTorrent");
		this.webtorrent = opts.webtorrent;
		NameService._client = this;
		this.nameService = await NameService.init();

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

		this.nameService.fetchBlocks();
		setInterval(() => this.nameService.fetchBlocks(), 60000);
	}

	async logState(): Promise<void> {
		const files = await this.fs.readDir("files/");
		const usedStorage = await this.utils.calculateUsedStorage();
		console.log(
			"\n===============================================\n========",
			new Date().toUTCString(),
			"========\n===============================================",
			"\n| Uptime:",
			Utils.convertTime(+new Date() - this.startTime),
			"\n| Known HTTP Peers:",
			this.rpcClient.http.getPeers().length,
			"\n| Known RTC Peers:",
			Object.keys(this.rpcClient.rtc.peers).length,
			"\n| Known (Network) Files:",
			await this.files.db.count(),
			`(${Math.round((100 * (await this.files.db.sum("size"))) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Stored Files:",
			files instanceof Error ? files.toString() : files.length,
			`(${Math.round((100 * (usedStorage instanceof Error ? 0 : usedStorage)) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Downloads Served:",
			(await this.files.db.sum("downloadCount")) + ` (${Math.round((((await this.files.db.sum("downloadCount * size")) / 1024 / 1024 / 1024) * 100) / 100)}GB)`,
			"\n| Files Wallet:",
			`${this.filesWallet.address()} ${await this.filesWallet.balance()}`,
			"\n| RTC Wallet:",
			`${this.rtcWallet.address()}`, // ${await this.rtcWallet.balance()}`,
			"\n| Processing Files:",
			processingDownloads.size,
			// '\n| Seeding Torrent Files:',
			// (await webtorrentClient()).torrents.length,
			"\n===============================================\n",
		);
	}
}

export default Hydrafiles;
