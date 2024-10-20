import fs from "node:fs";

import type WebTorrent from "npm:webtorrent";
import init from "./init.ts";
import getConfig, { type Config } from "./config.ts";
import Nodes from "./nodes.ts";
import File, { type FileAttributes, FileManager } from "./file.ts";
import startServer, { hashLocks } from "./server.ts";
import Utils from "./utils.ts";
// import Blockchain, { Block } from "./block.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";

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
	s3: S3Client | null;
	utils: Utils;
	webtorrent: WebTorrent;
	// blockchain: Blockchain;
	keyPair: Promise<CryptoKeyPair>;
	fileManager = new FileManager(this);
	constructor(customConfig: Partial<Config> = {}) {
		this.startTime = +new Date();
		this.config = getConfig(customConfig);
		this.utils = new Utils(this.config);
		this.s3 = this.config.s3Endpoint.length !== 0
			? new S3Client({
				endPoint: this.config.s3Endpoint,
				port: 443,
				useSSL: true,
				region: "us-east-1",
				bucket: "uploads",
				accessKey: this.config.s3AccessKeyId,
				secretKey: this.config.s3SecretAccessKey,
				pathStyle: false,
			})
			: null;

		this.keyPair = this.utils.generateKeyPair(); // TODO: Save keypair to fs
		init(this.config);

		this.nodes = new Nodes(this);

		startServer(this);
		// this.webtorrent = new WebTorrent()
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
		const file = this.fileManager.select({ orderBy: "RANDOM()" })[0];
		console.log(`  ${file.hash}  Backfilling file`);
		try {
			await file.getFile({ logDownloads: false });
		} catch (e) {
			if (this.config.logLevel === "verbose") throw e;
		}
		this.backfillFiles().catch(console.error);
	};

	logState(): void {
		try {
			console.log(
				"\n===============================================\n========",
				new Date().toUTCString(),
				"========\n===============================================",
				"\n| Uptime: ",
				this.utils.convertTime(+new Date() - this.startTime),
				"\n| Known (Network) Files:",
				this.fileManager.count(),
				`(${Math.round((100 * this.fileManager.sum("size")) / 1024 / 1024 / 1024) / 100}GB)`,
				"\n| Stored Files:",
				fs.readdirSync("files/").length,
				`(${Math.round((100 * this.utils.calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`,
				"\n| Processing Files:",
				hashLocks.size,
				"\n| Known Nodes:",
				this.nodes.getNodes({ includeSelf: false }).length,
				// '\n| Seeding Torrent Files:',
				// (await webtorrentClient()).torrents.length,
				"\n| Downloads Served:",
				this.fileManager.sum("downloadCount") + ` (${Math.round(((this.fileManager.sum("downloadCount * size") / 1024 / 1024 / 1024) * 100) / 100)}GB)`,
				"\n===============================================\n",
			);
		} catch (e) {
			console.error(e);
		}
	}

	search = <T>(where: { where?: { key: keyof FileAttributes; value: NonNullable<keyof FileAttributes> } | undefined; orderBy?: string } | undefined): File[] => {
		return this.fileManager.select(where);
	};
}

export default Hydrafiles;
