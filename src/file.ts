import type Hydrafiles from "./hydrafiles.ts";
import Utils, { type NonEmptyString, type NonNegativeNumber, type Sha256 } from "./utils.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { EthAddress } from "./wallet.ts";
import { delay } from "https://deno.land/std@0.170.0/async/delay.ts";
import { ErrorChecksumMismatch, ErrorNotFound, ErrorNotInitialised, ErrorUnreachableCodeReached } from "./errors.ts";
import Database, { type DatabaseModal } from "./database.ts";

const seeding: string[] = [];

export interface FileAttributes {
	hash: Sha256;
	infohash: string;
	downloadCount: NonNegativeNumber;
	id: string;
	name: string;
	found: boolean;
	size: NonNegativeNumber;
	voteHash: string;
	voteNonce: number;
	voteDifficulty: number;
	updatedAt: string;
	createdAt: string;
}

interface Metadata {
	name: string;
	size: NonNegativeNumber;
	type: string;
	hash: { sha256: Sha256 };
	id: string;
	infohash: string;
}

const FILESPATH = "files/";

const fileModel = {
	tableName: "file",
	columns: {
		hash: { type: "TEXT" as const, primary: true },
		infohash: { type: "TEXT" as const, isNullable: true },
		downloadCount: { type: "INTEGER" as const, default: 0 },
		id: { type: "TEXT" as const, isNullable: true },
		name: { type: "TEXT" as const, isNullable: true },
		found: { type: "BOOLEAN" as const, default: 1 },
		size: { type: "INTEGER" as const, default: 0 },
		voteHash: { type: "TEXT" as const, isNullable: true },
		voteNonce: { type: "INTEGER" as const, default: 0 },
		voteDifficulty: { type: "REAL" as const, default: 0 },
		createdAt: { type: "DATETIME" as const, default: "CURRENT_TIMESTAMP" },
		updatedAt: { type: "DATETIME" as const, default: "CURRENT_TIMESTAMP" },
	},
};

export class File implements FileAttributes {
	hash!: Sha256;
	infohash = "";
	downloadCount = Utils.createNonNegativeNumber(0);
	id = "";
	name = "";
	found = true;
	size = Utils.createNonNegativeNumber(0);
	voteHash = "";
	voteNonce = 0;
	voteDifficulty = 0;
	updatedAt: NonEmptyString = new Date().toISOString();
	createdAt: NonEmptyString = new Date().toISOString();

	private constructor(hash: Sha256, vote = false) {
		this.hash = hash;

		if (vote) {
			console.log(`File:     ${this.hash}  Voting for file`);
			this.checkVoteNonce();
		}
	}

	/**
	 * Initializes an instance of File.
	 * @returns {File} A new instance of File.
	 * @default
	 */
	static async init(values: Partial<DatabaseModal<typeof fileModel>>, vote = false): Promise<File> {
		let hash: string | undefined = values.hash;
		if (!hash && values.id) {
			const files = await Files._client.files.db.select({ key: "id", value: values.id });
			hash = files[0].hash;
		}
		if (!hash && values.id) {
			console.log(`Fetching file metadata`); // TODO: Merge with getMetadata
			const responses = await Files._client.rpcClient.fetch(`http://localhost/file/${values.id}`);
			for (let i = 0; i < responses.length; i++) {
				const response = await responses[i];
				if (response instanceof Error) continue;
				try {
					const body = await JSON.parse(response.text()) as { result: Metadata } | FileAttributes;
					hash = "result" in body ? body.result.hash.sha256 : body.hash;
				} catch (e) {
					if (Files._client.config.logLevel === "verbose") console.error(e);
				}
			}
			throw new Error("No hash found for the provided id");
		}
		if (!hash && values.infohash !== undefined && values.infohash !== null && Utils.isValidInfoHash(values.infohash)) {
			hash = (await Files._client.files.db.select({ key: "infohash", value: values.infohash }))[0].hash;
		}
		if (!hash) throw new Error("File not found");

		let fileModel = (await Files._client.files.db.select({ key: "hash", value: hash }))[0];
		if (fileModel === undefined) {
			Files._client.files.db.insert(values);
			fileModel = (await Files._client.files.db.select({ key: "hash", value: hash }))[0] ?? { hash: hash };
		}
		const file = new File(Utils.sha256(hash), vote);
		Object.assign(file, fileModel);
		return file;
	}

	public async getMetadata(): Promise<this | ErrorNotFound> {
		if (this.size > 0 && this.name !== undefined && this.name !== null && this.name.length > 0) return this;

		const hash = this.hash;

		console.log(`File:     ${hash}  Getting file metadata`);

		const id = this.id;
		if (id !== undefined && id !== null && id.length > 0) {
			const responses = await Files._client.rpcClient.fetch(`http://localhost/file/${this.id}`);

			for (let i = 0; i < responses.length; i++) {
				try {
					const response = await responses[i];
					if (response instanceof Error) continue;
					const body = JSON.parse(response.text());
					const metadata = body.result as Metadata ?? body as FileAttributes;
					this.name = metadata.name;
					this.size = Utils.createNonNegativeNumber(metadata.size);
					if (this.infohash?.length === 0) this.infohash = metadata.infohash;
					this.save();
					return this;
				} catch (e) {
					if (Files._client.config.logLevel === "verbose") console.log(e);
				}
			}
		}

		const filePath = join(FILESPATH, hash.toString());
		if (await Files._client.fs.exists(filePath)) {
			const fileSize = await Files._client.fs.getFileSize(filePath);
			if (!(fileSize instanceof Error)) {
				this.size = Utils.createNonNegativeNumber(fileSize);
				this.save();
			}
			return this;
		}

		if (Files._client.s3 !== undefined) {
			try {
				const data = await Files._client.s3.statObject(`${hash}.stuf`);
				if (typeof data.size !== "undefined") {
					this.size = Utils.createNonNegativeNumber(data.size);
					this.save();
					return this;
				}
			} catch (error) {
				console.error(error);
			}
		}

		return new ErrorNotFound();
	}

	async cacheFile(file: Uint8Array): Promise<true | ErrorNotInitialised | ErrorNotFound | ErrorUnreachableCodeReached> {
		const hash = this.hash;
		const filePath = join(FILESPATH, hash.toString());
		if (await Files._client.fs.exists(filePath)) return true;

		let size = this.size;
		if (size === 0) {
			size = Utils.createNonNegativeNumber(file.byteLength);
			this.size = size;
			this.save();
		}
		const remainingSpace = await Files._client.utils.remainingStorage();
		if (remainingSpace instanceof ErrorNotInitialised) return remainingSpace;
		if (Files._client.config.maxCache !== -1 && size > remainingSpace) Files._client.utils.purgeCache(size, remainingSpace);

		Files._client.fs.writeFile(filePath, file);
		const fileContent = await Files._client.fs.readFile(filePath);
		if (fileContent instanceof Error) return fileContent;
		const savedHash = await Utils.hashUint8Array(fileContent);
		if (savedHash !== hash) await Files._client.fs.remove(filePath); // In case of broken file
		return true;
	}

	async fetchFromCache(): Promise<{ file: Uint8Array; signal: number } | ErrorNotFound | ErrorNotInitialised | ErrorChecksumMismatch> {
		const hash = this.hash;
		console.log(`File:     ${hash}  Checking Cache`);
		const filePath = join(FILESPATH, hash.toString());
		this.seed();
		if (!await Files._client.fs.exists(filePath)) return new ErrorNotFound();
		const fileContents = await Files._client.fs.readFile(filePath);
		if (fileContents instanceof Error) return fileContents;
		const savedHash = await Utils.hashUint8Array(fileContents);
		if (savedHash !== this.hash) {
			await Files._client.fs.remove(filePath).catch(console.error);
			return new ErrorChecksumMismatch();
		}
		return {
			file: fileContents,
			signal: Utils.interfere(100),
		};
	}

	async fetchFromS3(): Promise<{ file: Uint8Array; signal: number } | ErrorNotInitialised | ErrorNotFound | ErrorChecksumMismatch> {
		console.log(`File:     ${this.hash}  Checking S3`);
		if (Files._client.s3 === undefined) return new ErrorNotInitialised();
		const chunks: Uint8Array[] = [];
		try {
			const data = (await Files._client.s3.getObject(`${this.hash}.stuf`)).body;
			if (data === null) return new ErrorNotFound();
			const reader = data.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
			}
		} catch (e) {
			if (typeof e === "object" && e !== null && "code" in e && e.code === "NoSuchKey") return new ErrorNotFound();
		}

		const length = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
		const file = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			file.set(chunk, offset);
			offset += chunk.length;
		}

		if (Files._client.config.cacheS3) await this.cacheFile(file);

		const hash = await Utils.hashUint8Array(file);
		if (hash.toString() !== this.hash.toString()) return new ErrorChecksumMismatch();
		return {
			file,
			signal: Utils.interfere(100),
		};
	}

	// TODO: fetchFromTorrent
	// TODO: Connect to other hydrafiles nodes as webseed
	// TODO: Check other nodes file lists to find other claimed infohashes for the file, leech off all of them and copy the metadata from the healthiest torrent

	async getFile(opts: { logDownloads: boolean }): Promise<{ file: Uint8Array; signal: number } | ErrorNotFound | ErrorNotInitialised | ErrorChecksumMismatch> {
		// const peer = await Utils.exportPublicKey((await Files._client.keyPair).publicKey); // TODO: Replace this with actual peer
		// const receipt = await Files._client.blockchain.mempoolBlock.signReceipt(
		//   peer,
		//   await Files._client.keyPair,
		// );
		// await Files._client.blockchain.mempoolBlock.addReceipt(receipt);
		// console.log(
		//   Files._client.blockchain.blocks.length,
		//   Files._client.blockchain.mempoolBlock.receipts.length,
		// );

		const hash = this.hash;
		console.log(`File:     ${hash}  Getting file`);
		if (!this.found && new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000)) {
			console.log(`File:     ${hash}  404 cached`);
			return new ErrorNotFound();
		}
		if (opts.logDownloads === undefined || opts.logDownloads) this.increment("downloadCount");

		// console.log(` ${this.hash}  Checking memory usage`);
		// if (this.size !== 0 && !Utils.hasSufficientMemory(this.size)) {
		// 	console.log(`File:     ${hash}  Reached memory limit, waiting`, this.size);
		// 	await Utils.promiseWithTimeout(
		// 		new Promise(() => {
		// 			const intervalId = setInterval(() => {
		// 				if (Files._client.config.logLevel === "verbose") console.log(`File:     ${hash}  Reached memory limit, waiting`, this.size);
		// 				if (this.size === 0 || Utils.hasSufficientMemory(this.size)) clearInterval(intervalId);
		// 			}, Files._client.config.memoryThresholdReachedWait);
		// 		}),
		// 		Files._client.config.timeout / 2,
		// 	);
		// }

		let file: { file: Uint8Array; signal: number } | ErrorNotFound | ErrorNotInitialised | ErrorChecksumMismatch = await this.fetchFromCache();
		if (!(file instanceof Error)) console.log(`File:     ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`);
		else {
			if (Files._client.config.s3Endpoint.length > 0) file = await this.fetchFromS3();
			if (!(file instanceof Error)) console.log(`File:     ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`);
			else {
				file = await this.download();
				if (file instanceof Error) {
					this.found = false;
					Files._client.events.log(Files._client.events.fileEvents.FileNotFound);
					this.save();
				}
			}
		}

		Files._client.events.log(Files._client.events.fileEvents.FileServed);
		if (!(file instanceof Error)) this.seed();

		return file;
	}

	save(): void {
		const file: DatabaseModal<typeof fileModel> = {
			...this,
			id: this.infohash ?? "",
			infohash: this.infohash ?? "",
			name: this.infohash ?? "",
			voteHash: this.infohash ?? "",
		};
		Files._client.files.db.update(this.hash, file);
	}

	async seed(): Promise<void> {
		// TODO: webtorrent.add() all known files
		if (!Files._client.webtorrent) return;
		if (seeding.includes(this.hash)) return;
		seeding.push(this.hash);
		const filePath = join(FILESPATH, this.hash);
		if (!Files._client.fs.exists(filePath)) return;
		Files._client.webtorrent.seed(typeof window === "undefined" ? filePath : await Files._client.fs.readFile(filePath), {
			createdBy: "Hydrafiles/0.1",
			name: (this.name ?? this.hash).replace(/(\.\w+)$/, " [HYDRAFILES]$1"),
			destroyStoreOnDestroy: true,
			addUID: true,
			comment: "Anonymously seeded with Hydrafiles",
		}, (torrent: { infoHash: string }) => {
			console.log(`File:     ${this.hash}  Seeding with infohash ${torrent.infoHash}`);
			this.infohash = torrent.infoHash;
			this.save();
		});
	}

	increment(column: keyof FileAttributes): void {
		Files._client.files.db.increment(this.hash, column);
		this[column]++;
	}

	async checkVoteNonce(nonce?: number): Promise<void> {
		const voteNonce = nonce || Number(crypto.getRandomValues(new Uint32Array(1)));
		const voteHash = await Utils.hashString(this.hash.toString() + voteNonce);
		const decimalValue = BigInt("0x" + voteHash).toString(10);
		const difficulty = Number(decimalValue) / Number(BigInt("0x" + "f".repeat(64)));
		if (difficulty > this.voteDifficulty) {
			console.log(`File:     ${this.hash}  ${nonce ? "Received" : "Mined"} Difficulty ${difficulty} - Prev: ${this.voteDifficulty}`);
			this.voteNonce = voteNonce;
			this.voteHash = voteHash;
			this.voteDifficulty = difficulty;
			this.save();
		}
	}

	async download(): Promise<{ file: Uint8Array; signal: number } | ErrorChecksumMismatch> {
		let size = this.size;
		if (size === 0) {
			this.getMetadata();
			size = this.size;
		}
		if (!Files._client.utils.hasSufficientMemory(size)) {
			console.log("Reached memory limit, waiting");
			await new Promise(() => {
				const intervalId = setInterval(async () => {
					if (await Files._client.utils.hasSufficientMemory(size)) clearInterval(intervalId);
				}, Files._client.config.memoryThresholdReachedWait);
			});
		}

		const peers = Files._client.rpcClient.http.getPeers(true);
		for (const peer of peers) {
			let fileContent: { file: Uint8Array; signal: number } | Error | undefined;
			try {
				fileContent = await peer.downloadFile(this);
			} catch (e) {
				console.error(e);
			}
			if (fileContent && !(fileContent instanceof Error)) return fileContent;
		}

		console.log(`File:     ${this.hash}  Downloading from WebRTC`);
		const responses = Files._client.rpcClient.rtc.fetch(new URL(`http://localhost/download/${this.hash}`));
		for (let i = 0; i < responses.length; i++) {
			const response = await responses[i];
			const fileContent = new Uint8Array(await response.arrayBuffer());
			console.log(`File:     ${this.hash}  Validating hash`);
			const verifiedHash = await Utils.hashUint8Array(fileContent);
			console.log(`File:     ${this.hash}  Done Validating hash`);
			if (this.hash !== verifiedHash) return new ErrorChecksumMismatch();
			console.log(`File:     ${this.hash}  Valid hash`);

			const ethAddress = response.headers["Ethereum-Address"];
			if (ethAddress) Files._client.filesWallet.transfer(ethAddress as EthAddress, 1_000_000n * BigInt(fileContent.byteLength));

			if (!this.name) {
				this.name = String(response.headers["Content-Disposition"]?.split("=")[1].replace(/"/g, "").replace(" [HYDRAFILES]", ""));
				this.save();
			}
		}

		return new ErrorNotFound();
	}
}

class Files {
	static _client: Hydrafiles;
	db!: Database<typeof fileModel>;
	public filesHash = new Map<string, File>(); // TODO: add inserts
	public filesInfohash = new Map<string, File>(); // TODO: add inserts
	public filesId = new Map<string, File>(); // TODO: add inserts

	private constructor(db: Database<typeof fileModel>) {
		this.db = db;

		setTimeout(async () => {
			const files = await this.db.select();
			for (const file of files) {
				this.add(file);
			}
		}, 1000); // Runs 1 sec late to ensure Files gets saves to Files._client
	}

	static async init(): Promise<Files> {
		return new Files(
			await Database.init<typeof fileModel>(fileModel, Files._client),
		);
	}

	public async add(values: Partial<DatabaseModal<typeof fileModel>>): Promise<File> {
		if (!values.hash) throw new Error("Hash not defined");
		const file = await File.init(values, false);
		this.filesHash.set(values.hash, file);
		if (values.infohash) this.filesInfohash.set(values.infohash, file);
		if (values.id) this.filesId.set(values.id, file);
		return file;
	}

	public getFiles(): File[] {
		const files = Array.from(this.filesHash.values())
			.sort((a, b) => (b.voteDifficulty ?? 0) - (a.voteDifficulty ?? 0));
		return files;
	}

	backfillFiles = (): void => {
		setTimeout(async () => {
			while (true) {
				console.log("Backfilling file");
				const keys = Array.from(this.filesHash.keys());
				if (keys.length === 0) {
					await delay(500);
					continue;
				}
				const randomKey = keys[Math.floor(Math.random() * keys.length)];
				const file = this.filesHash.get(randomKey);
				if (!file) continue;
				if (file) {
					console.log(`File:     ${file.hash}  Backfilling file`);
					await file.getFile({ logDownloads: false });
				}
			}
		}, 2000); // Run 2 secs late because of Files construct being async
	};

	// TODO: Compare list between all peers and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
	async updateFileList(onProgress?: (progress: number, total: number) => void): Promise<void> {
		console.log(`Comparing file list`);
		let files: FileAttributes[] = [];
		const responses = await Promise.all(await Files._client.rpcClient.fetch("http://localhost/files"));
		for (let i = 0; i < responses.length; i++) {
			const response = responses[i];
			if (!(response instanceof Error)) {
				try {
					files = files.concat(JSON.parse(response.text()) as FileAttributes[]);
				} catch (e) {
					if (Files._client.config.logLevel === "verbose") console.log(e);
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
				const file = this.db.withDefaults({ hash: files[i].hash, infohash: files[i].infohash ?? undefined });
				if (file instanceof Error) continue;
				const currentFile = await this.add(file);
				if (!currentFile) continue;

				let updated = false;
				const keys = Object.keys(newFile) as unknown as (keyof File)[];
				for (let i = 0; i < keys.length; i++) {
					const key = keys[i] as keyof FileAttributes;
					if (["downloadCount", "voteHash", "voteNonce", "voteDifficulty"].includes(key)) continue;
					if (newFile[key] !== undefined && newFile[key] !== null && newFile[key] !== 0 && (currentFile[key] === null || currentFile[key] === 0)) {
						// @ts-expect-error:
						currentFile[key] = newFile[key];
						updated = true;
					}
					if (newFile.voteNonce !== 0 && newFile.voteDifficulty > currentFile.voteDifficulty && newFile["voteNonce"] > 0) {
						console.log(`File:     ${newFile.hash}  Checking vote nonce ${newFile["voteNonce"]}`);
						currentFile.checkVoteNonce(newFile["voteNonce"]);
					}
				}
				if (updated) currentFile.save();
			} catch (e) {
				console.error(e);
			}
		}
		if (onProgress) onProgress(files.length, files.length);
	}
}

export default Files;
