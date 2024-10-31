import Base32 from "npm:base32";
// import WebTorrent from "npm:webtorrent";
import getConfig, { type Config } from "./config.ts";
import Peers, { PeerDB } from "./peer.ts";
import File, { type FileAttributes, FileDB } from "./file.ts";
import startServer, { hashLocks } from "./server.ts";
import Utils from "./utils.ts";
// import Blockchain, { Block } from "./block.ts";
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";
import WebRTC from "./rtc.ts";

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
	utils: Utils;
	config: Config;
	s3: S3Client | undefined;
	// webtorrent: WebTorrent = new WebTorrent();
	// blockchain = new Blockchain(this);
	keyPair!: CryptoKeyPair;
	fileDB!: FileDB;
	peers!: Peers;
	peerDB!: PeerDB;
	webRTC!: WebRTC;
	handleRequest?: (req: Request) => Promise<string>;

	constructor(customConfig: Partial<Config> = {}) {
		console.log("Startup: Populating Utils");
		this.utils = new Utils(this);
		console.log("Startup: Populating Config");
		this.config = getConfig(customConfig);

		if (this.config.s3Endpoint.length) {
			console.log("Startup: Populating S3");
			this.s3 = new S3Client({ endPoint: this.config.s3Endpoint, region: "us-east-1", bucket: "uploads", accessKey: this.config.s3AccessKeyId, secretKey: this.config.s3SecretAccessKey, pathStyle: false });
		}
	}

	public async start(onCompareFileListProgress?: (progress: number, total: number) => void): Promise<void> {
		console.log("Startup: Populating KeyPair");
		this.keyPair = await this.utils.getKeyPair();
		console.log("Startup: Populating FileDB");
		this.fileDB = await FileDB.init(this);
		console.log("Startup: Populating PeerDB");
		this.peerDB = await PeerDB.init(this);
		console.log("Startup: Populating Peers");
		this.peers = await Peers.init(this);
		console.log("Startup: Populating webRTC");
		this.webRTC = await WebRTC.init(this);

		this.startBackgroundTasks(onCompareFileListProgress);
	}

	private startBackgroundTasks(onCompareFileListProgress?: (progress: number, total: number) => void): void {
		startServer(this);

		if (this.config.summarySpeed !== -1) setInterval(() => this.logState(), this.config.summarySpeed);
		if (this.config.comparePeersSpeed !== -1) {
			this.peers.fetchPeers();
			setInterval(() => this.peers.fetchPeers(), this.config.comparePeersSpeed);
		}
		if (this.config.compareFilesSpeed !== -1) {
			this.peers.compareFileList(onCompareFileListProgress);
			setInterval(() => this.peers.compareFileList(onCompareFileListProgress), this.config.compareFilesSpeed);
		}
		if (this.config.backfill) this.backfillFiles();
	}

	private backfillFiles = async (): Promise<void> => {
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

	getHostname = async () => {
		const pubKey = await Utils.exportPublicKey(this.keyPair.publicKey);
		return Base32.encode(pubKey.x).toLowerCase().replaceAll("=", "") + "." + Base32.encode(pubKey.y).toLowerCase().replaceAll("=", "");
	};

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
			await this.utils.countFilesInDir("files/"),
			`(${Math.round((100 * await this.utils.calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`,
			"\n| Processing Files:",
			hashLocks.size,
			"\n| Known Nodes:",
			(await this.peers.getPeers()).length,
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
