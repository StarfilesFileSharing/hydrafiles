import Base32 from "npm:base32";
// import WebTorrent from "npm:webtorrent";
import getConfig, { type Config } from "./config.ts";
import Nodes from "./nodes.ts";
import File, { type FileAttributes, FileDB } from "./file.ts";
import startServer, { hashLocks } from "./server.ts";
import Utils from "./utils.ts";
// import Blockchain, { Block } from "./block.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";
import FileSystem from "./fs.ts";
import { delay } from "https://deno.land/std@0.170.0/async/delay.ts";

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
	startTime: number = +new Date();
	utils = new Utils(this);
	config: Config;
	s3: S3Client | undefined;
	// webtorrent: WebTorrent = new WebTorrent();
	// blockchain = new Blockchain(this);
	fs = new FileSystem();
	keyPair = this.utils.getKeyPair();
	FileDB = new FileDB(this);
	nodes = Nodes.init(this);
	constructor(customConfig: Partial<Config> = {}) {
		this.config = getConfig(customConfig);
		if (this.config.s3Endpoint.length) {
			this.s3 = new S3Client({
				endPoint: this.config.s3Endpoint,
				region: "us-east-1",
				bucket: "uploads",
				accessKey: this.config.s3AccessKeyId,
				secretKey: this.config.s3SecretAccessKey,
				pathStyle: false,
			});
		}

		startServer(this);

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
		if (this.config.backfill) this.backfillFiles().catch(console.error);
	}

	backgroundTasks = async (): Promise<void> => {
		const nodes = this.nodes;
		if (this.config.compareNodes) (await nodes).compareNodeList();
		if (this.config.compareFiles) {
			const knownNodes = (await nodes).getNodes({ includeSelf: false });
			for (let i = 0; i < knownNodes.length; i++) {
				await (await nodes).compareFileList(knownNodes[i]);
			}
		}
		await delay(600000);
		this.backgroundTasks();
	};

	backfillFiles = async (): Promise<void> => {
		if (this.FileDB !== undefined) {
			const file = (await this.FileDB.select({ orderBy: "RANDOM()" }))[0];
			if (file === undefined) return;
			console.log(`  ${file.hash}  Backfilling file`);
			try {
				await file.getFile({ logDownloads: false });
			} catch (e) {
				if (this.config.logLevel === "verbose") throw e;
			}
		}
		this.backfillFiles().catch(console.error);
	};

	async logState(): Promise<void> {
		const pubKey = await Utils.exportPublicKey((await this.keyPair).publicKey);

		console.log(
			"\n===============================================\n========",
			new Date().toUTCString(),
			"========\n===============================================",
			"\n| Uptime: ",
			Utils.convertTime(+new Date() - this.startTime),
			"\n| Hostname: ",
			`${Base32.encode(pubKey.x).toLowerCase().replaceAll("=", "")}.${Base32.encode(pubKey.y).toLowerCase().replaceAll("=", "")}`,
			"\n| Known (Network) Files:",
			this.FileDB !== undefined ? await this.FileDB.count() : 0,
			`(${Math.round((100 * (this.FileDB !== undefined ? await this.FileDB.sum("size") : 0)) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Stored Files:",
			await this.utils.countFilesInDir("files/"),
			`(${Math.round((100 * await this.utils.calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Processing Files:",
			hashLocks.size,
			"\n| Known Nodes:",
			(await this.nodes).getNodes({ includeSelf: false }).length,
			// '\n| Seeding Torrent Files:',
			// (await webtorrentClient()).torrents.length,
			"\n| Downloads Served:",
			(this.FileDB !== undefined ? await this.FileDB.sum("downloadCount") : 0) + ` (${Math.round((((this.FileDB !== undefined ? await this.FileDB.sum("downloadCount * size") : 0) / 1024 / 1024 / 1024) * 100) / 100)}GB)`,
			"\n===============================================\n",
		);
	}

	search = async <T>(where: { where?: { key: keyof FileAttributes; value: NonNullable<keyof FileAttributes> } | undefined; orderBy?: string } | undefined): Promise<File[]> => {
		return this.FileDB !== undefined ? await this.FileDB.select(where) : [];
	};

	getFile = (hash: string): File => {
		return new File({ hash }, this);
	};
}

export default Hydrafiles;
