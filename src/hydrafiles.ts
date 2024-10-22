// import WebTorrent from "npm:webtorrent";
import getConfig, { type Config } from "./config.ts";
import Nodes from "./nodes.ts";
import File, { type FileAttributes, FileManager } from "./file.ts";
import startServer, { hashLocks } from "./server.ts";
import Utils from "./utils.ts";
// import Blockchain, { Block } from "./block.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";
import { Database } from "jsr:@db/sqlite@0.11";

// TODO: IDEA: HydraTorrent - New Github repo - "Hydrafiles + WebTorrent Compatibility Layer" - Hydrafiles noes can optionally run HydraTorrent to seed files via webtorrent
// Change index hash from sha256 to infohash, then allow nodes to leech files from webtorrent + normal torrent
// HydraTorrent is a WebTorrent hybrid client that plugs into Hydrafiles
// Then send a PR to WebTorrent for it to connect to the Hydrafiles network as default webseeds
// HydraTorrent is 2-way, allowing for fetching-seeding files via both hydrafiles and torrent
//
// ALSO THIS ALLOWS FOR PLAUSIBLE DENIABLITY FOR NORMAL TORRENTS
// Torrent clients can connect to the Hydrafiles network and claim they dont host any of the files they seed
// bittorrent to http proxy
// starfiles.co would use webtorrent to download files

class Hydrafiles {
	startTime: number;
	config: Config;
	nodes: Nodes;
	s3: S3Client | undefined;
	utils: Utils;
	// webtorrent: WebTorrent = new WebTorrent();
	// blockchain: Blockchain;
	keyPair: Promise<CryptoKeyPair>;
	db: Database = new Database("filemanager.db");
	fileManager: FileManager = new FileManager(this);
	constructor(customConfig: Partial<Config> = {}) {
		this.startTime = +new Date();
		this.config = getConfig(customConfig);
		this.utils = new Utils(this.config);
		if (this.config.s3Endpoint.length) {
			this.s3 = new S3Client({
				endPoint: this.config.s3Endpoint,
				port: 443,
				useSSL: true,
				region: "us-east-1",
				bucket: "uploads",
				accessKey: this.config.s3AccessKeyId,
				secretKey: this.config.s3SecretAccessKey,
				pathStyle: false,
			});
		}

		this.keyPair = this.utils.generateKeyPair(); // TODO: Save keypair to fs

		this.nodes = new Nodes(this);

		startServer(this);
		// this.blockchain = new Blockchain(this);

		if (this.config.summarySpeed !== -1) {
			this.logState();
			setInterval(() => {
				this.logState();
			}, this.config.summarySpeed);
		}

		if (this.config.compareSpeed !== -1) {
			setInterval(this.backgroundTasks, this.config.compareSpeed);
			this.backgroundTasks();
		}
		// if (this.config.backfill) this.backfillFiles().catch(console.error)
	}

	backgroundTasks = (): void => {
		const nodes = this.nodes;
		if (this.config.compareNodes) nodes.compareNodeList();
		if (this.config.compareFiles) {
			const knownNodes = nodes.getNodes({ includeSelf: false });
			for (let i = 0; i < knownNodes.length; i++) {
				nodes.compareFileList(knownNodes[i]).catch(console.error);
			}
		}
	};

	backfillFiles = async (): Promise<void> => {
		if (this.fileManager !== undefined) {
			const file = this.fileManager.select({ orderBy: "RANDOM()" })[0];
			console.log(`  ${file.hash}  Backfilling file`);
			try {
				await file.getFile({ logDownloads: false });
			} catch (e) {
				if (this.config.logLevel === "verbose") throw e;
			}
		}
		this.backfillFiles().catch(console.error);
	};

	logState(): void {
		console.log("aaaaaaaa");
		try {
			console.log(
				"\n===============================================\n========",
				new Date().toUTCString(),
				"========\n===============================================",
				"\n| Uptime: ",
				this.utils.convertTime(+new Date() - this.startTime),
				"\n| Known (Network) Files:",
				this.fileManager !== undefined ? this.fileManager.count() : 0,
				`(${Math.round((100 * (this.fileManager !== undefined ? this.fileManager.sum("size") : 0)) / 1024 / 1024 / 1024) / 100}GB)`,
				"\n| Stored Files:",
				this.utils.countFilesInDir("files/"),
				`(${Math.round((100 * this.utils.calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`,
				"\n| Processing Files:",
				hashLocks.size,
				"\n| Known Nodes:",
				this.nodes.getNodes({ includeSelf: false }).length,
				// '\n| Seeding Torrent Files:',
				// (await webtorrentClient()).torrents.length,
				"\n| Downloads Served:",
				(this.fileManager !== undefined ? this.fileManager.sum("downloadCount") : 0) + ` (${Math.round((((this.fileManager !== undefined ? this.fileManager.sum("downloadCount * size") : 0) / 1024 / 1024 / 1024) * 100) / 100)}GB)`,
				"\n===============================================\n",
			);
		} catch (e) {
			console.error(e);
		}
	}

	search = <T>(where: { where?: { key: keyof FileAttributes; value: NonNullable<keyof FileAttributes> } | undefined; orderBy?: string } | undefined): File[] => {
		return this.fileManager !== undefined ? this.fileManager.select(where) : [];
	};

	getFile = (hash: string): File => {
		return new File({ hash }, this);
	};
}

export default Hydrafiles;
