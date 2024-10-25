import { Database } from "jsr:@db/sqlite@0.11";
import type Hydrafiles from "./hydrafiles.ts";
import Utils from "./utils.ts";
import { IDBKeyRange, indexedDB } from "https://deno.land/x/indexeddb@v1.1.0/ponyfill.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const Deno: typeof globalThis.Deno | undefined = globalThis.Deno ?? undefined;

type NonNegativeNumber = number & { readonly brand: unique symbol };

function createNonNegativeNumber(n: number): NonNegativeNumber {
	if (Number.isInteger(n) && n >= 0) return n as NonNegativeNumber;
	throw new Error("Number is not a positive integer");
}

interface Metadata {
	name: string;
	size: number;
	type: string;
	hash: { sha256: string };
	id: string;
	infohash: string;
}

export interface FileAttributes {
	hash: string;
	infohash: string | null;
	downloadCount: number;
	id: string | null;
	name: string | null;
	found: boolean;
	size: number;
	voteHash: string | null;
	voteNonce: number;
	voteDifficulty: number;
	updatedAt: string;
}

const FILESPATH = "files/";

function addColumnIfNotExists(db: Database, tableName: string, columnName: string, columnDefinition: string): void {
	const result = db.prepare(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name = ?`).value<[number]>(tableName, columnName);
	const columnExists = result && result[0] === 1;

	if (!columnExists) {
		db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
		console.log(`Column '${columnName}' added to table '${tableName}'.`);
	}
}

export function fileAttributesDefaults(values: Partial<FileAttributes>): FileAttributes {
	if (values.hash === undefined) throw new Error("Hash is required");

	return {
		hash: values.hash,
		infohash: values.infohash ?? null,
		downloadCount: createNonNegativeNumber(values.downloadCount ?? 0),
		id: values.id ?? null,
		name: values.name ?? null,
		found: values.found !== undefined ? values.found : true,
		size: createNonNegativeNumber(values.size ?? 0),
		voteHash: values.voteHash ?? null,
		voteNonce: values.voteNonce ?? 0,
		voteDifficulty: values.voteDifficulty ?? 0,
		updatedAt: values.updatedAt ?? new Date().toISOString(),
	};
}

async function createIDBDatabase(): Promise<IDBDatabase> {
	const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("MyDatabase", 1);

		request.onupgradeneeded = (_event) => {
			const db = request.result;
			db.createObjectStore("MyStore", { keyPath: "id" });
		};

		request.onsuccess = () => resolve(request.result as unknown as IDBDatabase);
		request.onerror = () => reject(request.error);
	});

	return await dbPromise;
}

export class FileDB {
	private _client: Hydrafiles;
	objectStore: IDBObjectStore | undefined;
	db: Database | IDBDatabase | undefined;

	constructor(client: Hydrafiles) {
		this._client = client;

		this.initialize().catch(console.error);
	}

	private async initialize(): Promise<void> {
		if (Deno !== undefined && !await this._client.fs.exists("files/")) this._client.fs.mkdir("files");

		if (typeof window === "undefined") {
			this.db = new Database("filemanager.db");
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS file (
					hash TEXT PRIMARY KEY,
					infohash TEXT,
					downloadCount INTEGER DEFAULT 0,
					id TEXT,
					name TEXT,
					found BOOLEAN DEFAULT 1,
					size INTEGER DEFAULT 0,
					voteHash STRING,
					voteNonce INTEGER DEFAULT 0,
					voteDifficulty REAL DEFAULT 0,
					createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
					updatedAt DATETIME
				)
			`);
			this.db.exec("UPDATE file SET size = 0 WHERE size < 0");
			this.db.exec("UPDATE file SET name = null WHERE name = 'File");
			addColumnIfNotExists(this.db, "file", "voteHash", "STRING");
			addColumnIfNotExists(this.db, "file", "voteNonce", "INTEGER");
			addColumnIfNotExists(this.db, "file", "voteDifficulty", "REAL DEFAULT 0");
			addColumnIfNotExists(this.db, "file", "updatedAt", "DATETIME");
		} else {
			this.db = await createIDBDatabase();
			if (!this.db.objectStoreNames.contains("file")) {
				const objectStore = this.db.createObjectStore("file", { keyPath: "hash" });
				objectStore.createIndex("infohash", "infohash", { unique: false });
				objectStore.createIndex("id", "id", { unique: false });
				objectStore.createIndex("name", "name", { unique: false });
				objectStore.createIndex("found", "found", { unique: false });
				objectStore.createIndex("size", "size", { unique: false });
				objectStore.createIndex("voteHash", "voteHash", { unique: false });
				objectStore.createIndex("voteNonce", "voteNonce", { unique: false });
				objectStore.createIndex("voteDifficulty", "voteDifficulty", { unique: false });
				objectStore.createIndex("createdAt", "createdAt", { unique: false });
				objectStore.createIndex("updatedAt", "updatedAt", { unique: false });
			}
			this.objectStore = this.db.transaction("file", "readwrite").objectStore("file");
		}
	}

	select<T extends keyof FileAttributes>(opts: { where?: { key: T; value: NonNullable<File[T]> }; orderBy?: string } = {}): Promise<File[]> {
		if (this.db === undefined) return new Promise((resolve) => resolve([]));

		if (this.db instanceof Database) {
			let query = "SELECT * FROM file";
			const params: (string | number | boolean)[] = [];

			if (opts.where) {
				query += ` WHERE ${opts.where.key} = ?`;
				params.push(opts.where.value);
			}

			if (opts.orderBy) query += ` ORDER BY ${opts.orderBy}`;
			const results = this.db.prepare(query).all(params) as unknown as File[];
			return new Promise((resolve) => resolve(results));
		} else {
			return new Promise((resolve, reject) => {
				if (this.objectStore === undefined) return [];
				const request = opts.where ? this.objectStore.index(opts.where.key).openCursor(IDBKeyRange.only(opts.where.value)) : this.objectStore.openCursor();
				const results: File[] = [];

				request.onsuccess = (event) => {
					const cursor: IDBCursorWithValue | null = (event.target as IDBRequest).result;
					if (cursor) {
						results.push(cursor.value);
						cursor.continue();
					} else {
						if (opts.orderBy) {
							results.sort((a, b) => {
								const orderBy = (opts.orderBy ?? "hash") as keyof FileAttributes;
								if ((a[orderBy] ?? "") < (b[orderBy] ?? "")) return -1;
								if ((a[orderBy] ?? "") > (b[orderBy] ?? "")) return 1;
								return 0;
							});
						}
						resolve(results);
					}
				};

				request.onerror = (event) => {
					reject((event.target as IDBRequest).error);
				};
			});
		}
	}

	insert(values: Partial<FileAttributes>): void {
		if (typeof this.db === "undefined") return;
		const file = fileAttributesDefaults(values) as File;
		console.log(`  ${file.hash}  File INSERTing`);
		if (this.db instanceof Database) {
			const query = `INSERT INTO file (hash, infohash, downloadCount, id, name, found, size)VALUES (?, ?, ?, ?, ?, ?, ?)`;

			this.db.exec(
				query,
				file.hash,
				file.infohash,
				file.downloadCount,
				file.id,
				file.name,
				file.found ? 1 : 0,
				file.size,
			);
		} else if (this.objectStore) this.objectStore.add(file).onerror = console.error;
	}

	async update(hash: string, updates: Partial<FileAttributes>): Promise<void> {
		if (this.db === undefined) return;
		updates.updatedAt = new Date().toISOString();
		const newFile = fileAttributesDefaults(updates);

		if (this.db instanceof Database) {
			const currentFile = fileAttributesDefaults((await this.select({ where: { key: "hash", value: hash } }))[0] ?? { hash });
			if (!currentFile) {
				console.error(`File with hash ${hash} not found.`);
				return;
			}

			const updatedColumn: string[] = [];
			const params: (string | number | boolean)[] = [];
			const keys = Object.keys(newFile);
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i] as keyof FileAttributes;
				if (newFile[key] !== undefined && newFile[key] !== null && newFile[key] !== currentFile[key]) {
					updatedColumn.push(key);
					params.push(newFile[key]);
				}
			}
			if (updatedColumn.length < 2) return;
			params.push(hash);
			"";
			const query = `UPDATE file SET ${updatedColumn.map((column) => `${column} = ?`).join(", ")} WHERE hash = ?`;

			this.db.prepare(query).values(params);
			console.log(`  ${hash}  File UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._client.config.logLevel === "verbose" ? ` - Query: ${query} - Params: ${params.join(", ")}` : ""));
		} else {
			if (this.objectStore) this.objectStore.put(newFile).onerror = console.error;
			console.log(`  ${hash}  File UPDATEd`);
		}
	}

	delete(hash: string): void {
		if (this.db === undefined) return;
		const query = `DELETE FROM file WHERE hash = ?`;

		if (this.db instanceof Database) {
			this.db.exec(query, hash);
		} else if (this.objectStore) this.objectStore.delete(hash).onerror = console.error;
		console.log(`${hash} File DELETEd`);
	}

	increment<T>(hash: string, column: keyof FileAttributes): void {
		if (this.db === undefined) return;
		if (this.db instanceof Database) this.db.prepare(`UPDATE file set ${column} = ${column}+1 WHERE hash = ?`).values(hash);
		else if (this.objectStore) {
			const request = this.objectStore.get(hash);
			request.onsuccess = (event) => {
				const target = event.target;
				if (!target) return;
				const file = (target as IDBRequest).result;
				if (file && this.objectStore) {
					file[column] = (file[column] || 0) + 1;
					this.objectStore.put(file).onsuccess = () => console.log(`Incremented ${column} for hash ${hash}`);
				}
			};
		}
	}

	count(): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db === undefined) return resolve(0);
			else if (this.db instanceof Database) {
				const result = this.db.prepare("SELECT COUNT(*) FROM file").value() as number[];
				return resolve(result[0]);
			}

			if (!this.objectStore) return resolve(0);
			const request = this.objectStore.count();
			request.onsuccess = () => resolve(request.result);
			request.onerror = (event) => reject((event.target as IDBRequest).error);
		});
	}

	sum(column: string, where = ""): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db === undefined) return resolve(0);
			if (this.db instanceof Database) {
				const result = this.db.prepare(`SELECT SUM(${column}) FROM file${where.length !== 0 ? ` WHERE ${where}` : ""}`).value() as number[];
				return resolve(result === undefined ? 0 : result[0]);
			} else {
				if (!this.objectStore) return resolve(0);
				let sum = 0;
				const request = this.objectStore.openCursor();

				request.onsuccess = (event) => {
					const target = event.target;
					if (!target) {
						reject(new Error("Event target is null"));
						return;
					}
					const cursor = (target as IDBRequest).result;
					if (cursor) {
						sum += cursor.value[column] || 0;
						cursor.continue();
					} else {
						resolve(sum);
					}
				};

				request.onerror = (event) => reject((event.target as IDBRequest).error);
			}
		}) as Promise<number>;
	}
}

class File implements FileAttributes {
	hash!: string;
	infohash: string | null = null;
	downloadCount = createNonNegativeNumber(0);
	id: string | null = null;
	name: string | null = null;
	found = true;
	size = createNonNegativeNumber(0);
	voteHash: string | null = null;
	voteNonce = 0;
	voteDifficulty = 0;
	updatedAt: string = new Date().toISOString();
	_client: Hydrafiles;

	constructor(values: { hash?: string; infohash?: string; id?: string }, client: Hydrafiles, vote = true) {
		this._client = client;

		if (values.hash) this.hash = values.hash;
		const hashPromise = new Promise<string>((resolve, reject) => {
			if (values.hash !== undefined) {
				// If hash exists, resolve it directly
				return resolve(values.hash);
			}

			if (values.id !== undefined) {
				// If id exists, attempt to fetch the corresponding hash
				const filesPromise = this._client.FileDB?.select({ where: { key: "id", value: values.id } });
				if (filesPromise !== undefined) {
					filesPromise.then(async (files) => {
						const fileHash = files[0]?.hash;
						if (fileHash) {
							resolve(fileHash);
						} else {
							const promises: (() => Promise<void>)[] = [];

							const nodes = this._client.nodes.getNodes({ includeSelf: false });
							for (let i = 0; i < nodes.length; i++) {
								try {
									const promise = async () => {
										try {
											console.log(`Fetching metadata by id from ${nodes[i].host}/file/${values.id}`);
											const response = await fetch(`${nodes[i].host}/file/${values.id}`);
											const body = await response.json() as { result: Metadata } | FileAttributes;
											const hash = "result" in body ? body.result.hash.sha256 : body.hash;
											if (Utils.isValidSHA256Hash(hash)) resolve(hash);
										} catch (e) {
											if (this._client.config.logLevel === "verbose") console.error(e);
										}
									};
									promises.push(promise);
								} catch (e) {
									if (this._client.config.logLevel === "verbose") console.error(e);
								}
							}
							await Utils.parallelAsync(promises, 4);
							throw new Error("No hash found for the provided id");
						}
					}).catch(reject); // Catch and reject on DB error
				} else {
					reject(new Error("FileDB not available or unable to fetch files"));
				}
			} else if (values.infohash !== undefined) {
				// If infohash exists, validate it
				if (!Utils.isValidInfoHash(values.infohash)) {
					return reject(new Error(`Invalid infohash provided: ${values.infohash}`));
				}
				const filesPromise = this._client.FileDB?.select({ where: { key: "infohash", value: values.infohash } });
				if (filesPromise !== undefined) {
					filesPromise.then((files) => {
						const fileHash = files[0]?.hash;
						if (fileHash) {
							resolve(fileHash);
						} else {
							reject(new Error("No hash found for the provided infohash"));
						}
					}).catch(reject); // Catch and reject on DB error
				} else {
					reject(new Error("FileDB not available or unable to fetch files"));
				}
			} else {
				// Reject if neither hash, id, nor infohash is provided
				reject(new Error("No hash, id, or infohash provided"));
			}
		});

		hashPromise.then(async (hash) => {
			if (hash === undefined || !Utils.isValidSHA256Hash(hash)) throw new Error(`  ${hash}  Invalid hash provided`);

			this.hash = hash;

			let fileAttributes = (await this._client.FileDB.select({ where: { key: "hash", value: hash } }))[0];
			if (fileAttributes === undefined) {
				this._client.FileDB.insert(this);
				fileAttributes = (await this._client.FileDB.select({ where: { key: "hash", value: hash } }))[0] ?? { hash };
			}
			const file = fileAttributesDefaults(fileAttributes);
			this.infohash = file.infohash;
			this.downloadCount = createNonNegativeNumber(file.downloadCount);
			this.id = file.id;
			this.name = file.name;
			this.found = file.found;
			this.size = createNonNegativeNumber(file.size);
			this.voteHash = file.voteHash;
			this.voteNonce = file.voteNonce;
			this.voteDifficulty = file.voteDifficulty;
			this.updatedAt = file.updatedAt;

			if (vote) this.vote().catch(console.error);
		});
	}

	public async getMetadata(): Promise<this | false> {
		if (this.size > 0 && this.name !== undefined && this.name !== null && this.name.length > 0) return this;

		const hash = this.hash;

		console.log(`  ${hash}  Getting file metadata`);

		const id = this.id;
		if (id !== undefined && id !== null && id.length > 0) {
			const nodes = this._client.nodes.getNodes({ includeSelf: false });
			for (let i = 0; i < nodes.length; i++) {
				try {
					const response = await fetch(`${nodes[i]}/file/${id}`);
					if (response.ok) {
						const body = await response.json();
						const metadata = body.result as Metadata ?? body as FileAttributes;
						this.name = metadata.name;
						this.size = createNonNegativeNumber(metadata.size);
						if (this.infohash?.length === 0) this.infohash = metadata.infohash;
						this.save();
						return this;
					}
				} catch (e) {
					if (this._client.config.logLevel === "verbose") console.error(e);
				}
			}
		}

		const filePath = join(FILESPATH, hash);
		if (Deno !== undefined && await this._client.fs.exists(filePath)) {
			this.size = createNonNegativeNumber(await this._client.fs.getFileSize(filePath));
			this.save();
			return this;
		}

		if (this._client.s3 !== undefined) {
			try {
				const data = await this._client.s3.statObject(`${hash}.stuf`);
				if (typeof data.size !== "undefined") {
					this.size = createNonNegativeNumber(data.size);
					this.save();
					return this;
				}
			} catch (error) {
				console.error(error);
			}
		}

		return false;
	}

	async cacheFile(file: Uint8Array): Promise<void> {
		const hash = this.hash;
		const filePath = join(FILESPATH, hash);
		if (Deno === undefined || await this._client.fs.exists(filePath)) return;

		let size = this.size;
		if (size === 0) {
			size = createNonNegativeNumber(file.byteLength);
			this.size = size;
			this.save();
		}
		const remainingSpace = await this._client.utils.remainingStorage();
		if (this._client.config.maxCache !== -1 && size > remainingSpace) this._client.utils.purgeCache(size, remainingSpace);

		if (Deno !== undefined) {
			this._client.fs.writeFile(filePath, file);
			const savedHash = await Utils.hashUint8Array(await this._client.fs.readFile(filePath));
			if (savedHash !== hash) await this._client.fs.remove(filePath); // In case of broken file
		}
	}

	private async fetchFromCache(): Promise<{ file: Uint8Array; signal: number } | false> {
		const hash = this.hash;
		console.log(`  ${hash}  Checking Cache`);
		const filePath = join(FILESPATH, hash);
		this.seed();
		if (Deno === undefined || !await this._client.fs.exists(filePath)) return false;
		const fileContents = await this._client.fs.readFile(filePath);
		const savedHash = await Utils.hashUint8Array(fileContents);
		if (savedHash !== this.hash) {
			if (Deno !== undefined) await this._client.fs.remove(filePath).catch(console.error);
			return false;
		}
		return {
			file: fileContents,
			signal: Utils.interfere(100),
		};
	}

	async fetchFromS3(): Promise<{ file: Uint8Array; signal: number } | false> {
		console.log(`  ${this.hash}  Checking S3`);
		if (this._client.s3 === undefined) return false;
		try {
			const data = (await this._client.s3.getObject(`${this.hash}.stuf`)).body;
			if (data === null) return false;

			const chunks: Uint8Array[] = [];
			const reader = data.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
			}

			const length = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
			const file = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				file.set(chunk, offset);
				offset += chunk.length;
			}

			if (this._client.config.cacheS3) await this.cacheFile(file);

			const hash = await Utils.hashUint8Array(file);
			if (hash !== this.hash) return false;
			return {
				file,
				signal: Utils.interfere(100),
			};
		} catch (e) {
			const err = e as { message: string };
			if (err.message !== "The specified key does not exist.") console.error(err);
			return false;
		}
	}

	// TODO: fetchFromTorrent
	// TODO: Connect to other hydrafiles nodes as webseed
	// TODO: Check other nodes file lists to find other claimed infohashes for the file, leech off all of them and copy the metadata from the healthiest torrent

	async getFile(opts: { logDownloads?: boolean } = {}): Promise<{ file: Uint8Array; signal: number } | false> {
		// const peer = await Utils.exportPublicKey((await this._client.keyPair).publicKey); // TODO: Replace this with actual peer
		// const receipt = await this._client.blockchain.mempoolBlock.signReceipt(
		//   peer,
		//   await this._client.keyPair,
		// );
		// await this._client.blockchain.mempoolBlock.addReceipt(receipt);
		// console.log(
		//   this._client.blockchain.blocks.length,
		//   this._client.blockchain.mempoolBlock.receipts.length,
		// );

		const hash = this.hash;
		console.log(`  ${hash}  Getting file`);
		if (!this.found && new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000)) {
			console.log(`  ${hash}  404 cached`);
			return false;
		}
		if (opts.logDownloads === undefined || opts.logDownloads) this.increment("downloadCount");
		this.save();

		// console.log(` ${this.hash}  Checking memory usage`);
		// if (this.size !== 0 && !Utils.hasSufficientMemory(this.size)) {
		// 	console.log(`  ${hash}  Reached memory limit, waiting`, this.size);
		// 	await Utils.promiseWithTimeout(
		// 		new Promise(() => {
		// 			const intervalId = setInterval(() => {
		// 				if (this._client.config.logLevel === "verbose") console.log(`  ${hash}  Reached memory limit, waiting`, this.size);
		// 				if (this.size === 0 || Utils.hasSufficientMemory(this.size)) clearInterval(intervalId);
		// 			}, this._client.config.memoryThresholdReachedWait);
		// 		}),
		// 		this._client.config.timeout / 2,
		// 	);
		// }

		let file = await this.fetchFromCache();
		if (file !== false) console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`);
		else {
			if (this._client.config.s3Endpoint.length > 0) file = await this.fetchFromS3();
			if (file !== false) console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`);
			else {
				file = await this._client.nodes.getFile(hash, this.size);
				if (file === false) {
					this.found = false;
					this.save();
				}
			}
		}

		if (file !== false) this.seed();

		return file;
	}

	save(): void {
		if (this._client.FileDB) {
			this._client.FileDB.update(this.hash, this);
		}
	}

	seed(): void {
		// TODO: webtorrent.add() all known files
		// if (seeding.includes(this.hash)) return;
		// seeding.push(this.hash);
		// const filePath = join(FILESPATH, this.hash);
		// if (Deno === undefined || !existsSync(filePath)) return;
		// this._client.webtorrent.seed(filePath, {
		//   createdBy: "Hydrafiles/0.1",
		//   name: (this.name ?? this.hash).replace(/(\.\w+)$/, " [HYDRAFILES]$1"),
		//   destroyStoreOnDestroy: true,
		//   addUID: true,
		//   comment: "Anonymously seeded with Hydrafiles",
		// }, async (torrent: { infoHash: string }) => {
		//   console.log(`  ${this.hash}  Seeding with infohash ${torrent.infoHash}`);
		//   this.infohash = torrent.infoHash;
		//   await this.save();
		// });
	}

	increment(column: keyof FileAttributes): void {
		if (this._client.FileDB) {
			this._client.FileDB.increment(this.hash, column);
		}
		this[column]++;
	}

	async checkVoteNonce(nonce: number): Promise<void> {
		const voteHash = await Utils.hashString(this.hash + nonce);
		const decimalValue = BigInt("0x" + voteHash).toString(10);
		const difficulty = Number(decimalValue) / Number(BigInt("0x" + "f".repeat(64)));
		if (difficulty > this.voteDifficulty) {
			console.log(`  ${this.hash}  Found Difficulty ${difficulty}`);
			this.voteNonce = nonce;
			this.voteHash = voteHash;
			this.voteDifficulty = difficulty;
			this.save();
		}
	}

	async vote(): Promise<void> {
		const nonce = Number(crypto.getRandomValues(new Uint32Array(1)));
		await this.checkVoteNonce(nonce);
	}
}

export default File;
