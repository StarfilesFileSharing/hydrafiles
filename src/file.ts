import type Hydrafiles from "./hydrafiles.ts";
import Utils, { type NonNegativeNumber, type Sha256 } from "./utils.ts";
import type { indexedDB } from "https://deno.land/x/indexeddb@v1.1.0/ponyfill.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { Database } from "jsr:@db/sqlite";
import type { EthAddress } from "./wallet.ts";
import { delay } from "https://deno.land/std@0.170.0/async/delay.ts";
import { ErrorChecksumMismatch, ErrorMissingRequiredProperty, ErrorNotFound, ErrorNotInitialised, ErrorRequestFailed, ErrorUnreachableCodeReached } from "./errors.ts";

type DatabaseWrapper = { type: "UNDEFINED"; db: undefined } | { type: "SQLITE"; db: Database } | { type: "INDEXEDDB"; db: IDBDatabase };

const seeding: string[] = [];

export interface FileAttributes {
	hash: Sha256;
	infohash: string | null;
	downloadCount: NonNegativeNumber;
	id: string | null;
	name: string | null;
	found: boolean;
	size: NonNegativeNumber;
	voteHash: Sha256 | null;
	voteNonce: number;
	voteDifficulty: number;
	updatedAt: string;
}

interface Metadata {
	name: string;
	size: NonNegativeNumber;
	type: string;
	hash: { sha256: string };
	id: string;
	infohash: string;
}

const FILESPATH = "files/";

function addColumnIfNotExists(db: Database, tableName: string, columnName: string, columnDefinition: string): void {
	const result = db.prepare(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name = ?`).value<[number]>(tableName, columnName);
	const columnExists = result && result[0] === 1;

	if (!columnExists) {
		if (db !== undefined) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
		console.log(`Column '${columnName}' added to table '${tableName}'.`);
	}
}

function fileAttributesDefaults(values?: Partial<FileAttributes>): FileAttributes | ErrorMissingRequiredProperty {
	if (!values) values = { hash: "" as unknown as Sha256 };
	if (values.hash === undefined) return new ErrorMissingRequiredProperty();

	return {
		hash: values.hash,
		infohash: values.infohash ?? null,
		downloadCount: Utils.createNonNegativeNumber(values.downloadCount ?? 0),
		id: values.id ?? null,
		name: values.name ?? null,
		found: values.found !== undefined ? values.found : true,
		size: Utils.createNonNegativeNumber(values.size ?? 0),
		voteHash: values.voteHash ?? null,
		voteNonce: values.voteNonce ?? 0,
		voteDifficulty: values.voteDifficulty ?? 0,
		updatedAt: values.updatedAt ?? new Date().toISOString(),
	};
}

function createIDBDatabase(): Promise<IDBDatabase> {
	const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		console.log("Startup: FileDB: Opening IndexedDB Connection");
		// @ts-expect-error:
		const request = indexedDB.open("File", 1);
		request.onupgradeneeded = (event): void => {
			console.log("Startup: FileDB: On Upgrade Needed");
			// @ts-expect-error:
			if (!event.target.result.objectStoreNames.contains("file")) {
				// @ts-expect-error:
				const objectStore = event.target.result.createObjectStore("file", { keyPath: "hash" });
				objectStore.createIndex("hash", "hash", { unique: true });
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
		};
		request.onsuccess = () => {
			console.log("Startup: FileDB: On Success");
			resolve(request.result as unknown as IDBDatabase);
		};
		request.onerror = () => {
			console.error("Startup: FileDB error:", request.error);
			reject(request.error);
		};
		request.onblocked = () => {
			console.error("Startup: FileDB: Blocked. Close other tabs with this site open.");
		};
	});

	return dbPromise;
}

export class FileDB {
	private _client: Hydrafiles;
	db: DatabaseWrapper = { type: "UNDEFINED", db: undefined };

	private constructor(client: Hydrafiles) {
		this._client = client;
	}

	/**
	 * Initializes an instance of FileDB.
	 * @returns {FileDB} A new instance of FileDB.
	 * @default
	 */
	static async init(client: Hydrafiles): Promise<FileDB> {
		await client.fs.mkdir("files/");

		const fileDB = new FileDB(client);

		if (typeof window === "undefined") {
			const { Database } = await import("jsr:@db/sqlite");
			fileDB.db = { type: "SQLITE", db: new Database("filemanager.db") };
			fileDB.db.db.exec(`
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
			addColumnIfNotExists(fileDB.db.db, "file", "voteHash", "STRING");
			addColumnIfNotExists(fileDB.db.db, "file", "voteNonce", "INTEGER");
			addColumnIfNotExists(fileDB.db.db, "file", "voteDifficulty", "REAL DEFAULT 0");
			addColumnIfNotExists(fileDB.db.db, "file", "updatedAt", "DATETIME");
		} else {
			const db = await createIDBDatabase();
			fileDB.db = { type: "INDEXEDDB", db: db };
		}
		return fileDB;
	}

	objectStore(): IDBObjectStore {
		if (this.db.type !== "INDEXEDDB") throw new Error("Wrong DB type when calling objectStore");
		return this.db.db.transaction("file", "readwrite").objectStore("file");
	}

	select<T extends keyof FileAttributes>(where?: { key: T; value: NonNullable<FileAttributes[T]> } | undefined, orderBy?: { key: T; direction: "ASC" | "DESC" } | "RANDOM" | undefined): Promise<FileAttributes[]> {
		if (this.db.type === "SQLITE") {
			let query = "SELECT * FROM file";
			const params: (string | number | boolean)[] = [];

			if (where) {
				query += ` WHERE ${where.key} = ?`;
				params.push(where.value);
			}

			if (orderBy) {
				if (orderBy === "RANDOM") query += ` ORDER BY RANDOM()`;
				else query += ` ORDER BY ${orderBy.key} ${orderBy.direction}`;
			}
			const results = this.db.db.prepare(query).all(params) as unknown as FileAttributes[];
			return new Promise((resolve) => resolve(results));
		} else if (this.db.type === "INDEXEDDB") {
			return new Promise((resolve, reject) => {
				if (this.db.type !== "INDEXEDDB") return;
				const request = where
					// @ts-expect-error:
					? this.objectStore().index(where.key).openCursor(where.value)
					: this.objectStore().openCursor();
				const results: FileAttributes[] = [];

				// @ts-expect-error:
				request.onsuccess = (event: { target: IDBRequest }) => {
					const cursor: IDBCursorWithValue = event.target.result;
					if (cursor) {
						results.push(cursor.value);
						cursor.continue();
					} else {
						if (orderBy) {
							results.sort((a, b) => {
								if (!orderBy) return 0;
								if (orderBy === "RANDOM") return Math.random() - 0.5;
								const aValue = a[orderBy.key];
								const bValue = b[orderBy.key];

								if (orderBy.direction === "ASC") {
									return String(aValue ?? 0) > String(bValue ?? 0) ? 1 : -1;
								} else {
									return String(aValue ?? 0) < String(bValue ?? 0) ? 1 : -1;
								}
							});
						}
						resolve(results);
					}
				};

				// @ts-expect-error:
				request.onerror = (event: { target: IDBRequest }) => {
					reject((event.target as IDBRequest).error);
				};
			});
		} else return new Promise((resolve) => resolve([]));
	}

	insert(values: Partial<FileAttributes>): true | ErrorMissingRequiredProperty {
		if (typeof this.db === "undefined") return new ErrorNotInitialised();
		const file = fileAttributesDefaults(values);
		if (file instanceof ErrorMissingRequiredProperty) return new ErrorMissingRequiredProperty();
		console.log(`File:     ${file.hash}  File INSERTed`, values);
		if (this.db.type === "SQLITE") {
			const query = `INSERT INTO file (hash, infohash, downloadCount, id, name, found, size)VALUES (?, ?, ?, ?, ?, ?, ?)`;

			this.db.db.exec(
				query,
				file.hash.toString(),
				file.infohash,
				file.downloadCount,
				file.id,
				file.name,
				file.found ? 1 : 0,
				file.size,
			);
		} else if (this.db.type === "INDEXEDDB") {
			const request = this.objectStore().add(file);

			request.onerror = (event) => {
				// @ts-expect-error:
				throw event.target.error;
			};

			this.objectStore().add(file);
		}

		return true;
	}

	async update(hash: Sha256, updates: Partial<FileAttributes>): Promise<true | ErrorNotFound | ErrorMissingRequiredProperty> {
		updates.updatedAt = new Date().toISOString();
		updates.hash = hash;
		const newFile = fileAttributesDefaults(updates);
		if (newFile instanceof ErrorMissingRequiredProperty) return new ErrorMissingRequiredProperty();

		// Get the current file attributes before updating
		const currentFile = (await this.select({ key: "hash", value: hash }))[0] ?? fileAttributesDefaults({ hash });
		if (!currentFile) {
			console.error(`File:     ${hash}  Mot found when updating`);
			return new ErrorNotFound();
		}

		const updatedColumn: string[] = [];
		const params: (string | number | boolean)[] = [];
		const keys = Object.keys(newFile);
		const defaultValues = fileAttributesDefaults();
		if (defaultValues instanceof ErrorMissingRequiredProperty) return new ErrorMissingRequiredProperty();

		type BeforeAfter = Record<string, { before: FileAttributes[keyof FileAttributes]; after: FileAttributes[keyof FileAttributes] }>;
		const beforeAndAfter: BeforeAfter = {};

		for (let i = 0; i < keys.length; i++) {
			const key = keys[i] as keyof FileAttributes;
			if (newFile[key] !== undefined && newFile[key] !== null && newFile[key] !== currentFile[key] && newFile[key] !== defaultValues[key]) {
				if (key === "name" && newFile[key] === "File") continue;
				updatedColumn.push(key);
				params.push(newFile[key]);
				beforeAndAfter[key] = { before: currentFile[key], after: newFile[key] };
			}
		}

		if (updatedColumn.length <= 1) {
			console.warn("Unnecessary DB update");
			return true;
		}

		if (this.db.type === "SQLITE") {
			params.push(hash.toString());
			const query = `UPDATE file SET ${updatedColumn.map((column) => `${column} = ?`).join(", ")} WHERE hash = ?`;
			this.db.db.prepare(query).values(params);
			console.log(
				`File:     ${hash}  File UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._client.config.logLevel === "verbose" ? ` - Params: ${params.join(", ")}  - Query: ${query}` : ""),
				this._client.config.logLevel === "verbose" ? console.log(`File:     ${hash}  Updated Values:`, beforeAndAfter) : "",
			);
		} else {
			if (this.db.type === "INDEXEDDB") this.objectStore().put(newFile).onerror = console.error;
			console.log(
				`File:     ${hash}  File UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._client.config.logLevel === "verbose" ? ` - Params: ${params.join(", ")}` : ""),
				this._client.config.logLevel === "verbose" ? console.log(`File:     ${hash}  Updated Values:`, beforeAndAfter) : "",
			);
		}
		return true;
	}

	delete(hash: Sha256): void {
		const query = `DELETE FROM file WHERE hash = ?`;

		if (this.db.type === "SQLITE") {
			this.db.db.exec(query, hash.toString());
		} else if (this.db.type === "INDEXEDDB") this.objectStore().delete(hash.toString()).onerror = console.error;
		console.log(`File:     ${hash}  File DELETEd`);
	}

	increment<T>(hash: Sha256, column: keyof FileAttributes): void {
		if (this.db.type === "SQLITE") this.db.db.prepare(`UPDATE file set ${column} = ${column}+1 WHERE hash = ?`).values(hash.toString());
		else if (this.db.type === "INDEXEDDB") {
			const request = this.objectStore().get(hash.toString());
			request.onsuccess = (event) => {
				const target = event.target;
				if (!target) return;
				const file = (target as IDBRequest).result;
				if (file && this.db.type === "INDEXEDDB") {
					file[column] = (file[column] || 0) + 1;
					this.objectStore().put(file).onsuccess = () => console.log(`File:     ${hash}  Incremented ${column}`);
				}
			};
		}
	}

	count(): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db.type === "SQLITE") {
				const result = this.db.db.prepare("SELECT COUNT(*) FROM file").value() as number[];
				return resolve(result[0]);
			}

			if (this.db.type === "UNDEFINED") return resolve(0);
			const request = this.objectStore().count();
			request.onsuccess = () => resolve(request.result);
			request.onerror = (event) => reject((event.target as IDBRequest).error);
		});
	}

	sum(column: string, where = ""): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db.type === "SQLITE") {
				const result = this.db.db.prepare(`SELECT SUM(${column}) FROM file${where.length !== 0 ? ` WHERE ${where}` : ""}`).value() as number[];
				return resolve(result === undefined ? 0 : result[0]);
			} else {
				if (this.db.type === "UNDEFINED") return resolve(0);
				let sum = 0;
				const request = this.objectStore().openCursor();

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

export class File implements FileAttributes {
	hash!: Sha256;
	infohash: string | null = null;
	downloadCount = Utils.createNonNegativeNumber(0);
	id: string | null = null;
	name: string | null = null;
	found = true;
	size = Utils.createNonNegativeNumber(0);
	voteHash: Sha256 | null = null;
	voteNonce = 0;
	voteDifficulty = 0;
	updatedAt: string = new Date().toISOString();
	private _client: Hydrafiles;

	private constructor(hash: Sha256, client: Hydrafiles, vote = false) {
		this._client = client;
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
	static async init(values: Partial<FileAttributes>, client: Hydrafiles, vote = false): Promise<File> {
		if (!values.hash && values.id) {
			const files = await client.files.db.select({ key: "id", value: values.id });
			values.hash = files[0]?.hash;
		}
		if (!values.hash && values.id) {
			console.log(`Fetching file metadata`); // TODO: Merge with getMetadata
			const responses = client.rpcClient.fetch(`http://localhost/file/${values.id}`);
			for (let i = 0; i < responses.length; i++) {
				const response = await responses[i];
				if (response instanceof Error) continue;
				try {
					const body = await response.json() as { result: Metadata } | FileAttributes;
					const hash = "result" in body ? body.result.hash.sha256 : body.hash;
					values.hash = Utils.sha256(hash);
				} catch (e) {
					if (client.config.logLevel === "verbose") console.error(e);
				}
			}
			throw new Error("No hash found for the provided id");
		}
		if (values.infohash !== undefined && values.infohash !== null && Utils.isValidInfoHash(values.infohash)) {
			const files = await client.files.db.select({ key: "infohash", value: values.infohash });
			const fileHash = files[0]?.hash;
			if (fileHash) values.hash = fileHash;
		}
		if (!values.hash) throw new Error("File not found");

		let fileAttributes = (await client.files.db.select({ key: "hash", value: values.hash }))[0];
		if (fileAttributes === undefined) {
			client.files.db.insert(values);
			fileAttributes = (await client.files.db.select({ key: "hash", value: values.hash }))[0] ?? { hash: values.hash };
		}
		const file = new File(values.hash, client, vote);
		Object.assign(file, fileAttributesDefaults(fileAttributes));
		return file;
	}

	toFileAttributes(): FileAttributes {
		if (this.hash === undefined) throw new Error("Hash is required");

		return {
			hash: this.hash,
			infohash: this.infohash ?? null,
			downloadCount: Utils.createNonNegativeNumber(this.downloadCount ?? 0),
			id: this.id ?? null,
			name: this.name ?? null,
			found: this.found !== undefined ? this.found : true,
			size: Utils.createNonNegativeNumber(this.size ?? 0),
			voteHash: this.voteHash ?? null,
			voteNonce: this.voteNonce ?? 0,
			voteDifficulty: this.voteDifficulty ?? 0,
			updatedAt: this.updatedAt ?? new Date().toISOString(),
		};
	}

	public async getMetadata(): Promise<this | ErrorNotFound> {
		if (this.size > 0 && this.name !== undefined && this.name !== null && this.name.length > 0) return this;

		const hash = this.hash;

		console.log(`File:     ${hash}  Getting file metadata`);

		const id = this.id;
		if (id !== undefined && id !== null && id.length > 0) {
			const responses = this._client.rpcClient.fetch(`http://localhost/file/${this.id}`);

			for (let i = 0; i < responses.length; i++) {
				try {
					const response = await responses[i];
					if (response instanceof Error) continue;
					const body = await response.json();
					const metadata = body.result as Metadata ?? body as FileAttributes;
					this.name = metadata.name;
					this.size = Utils.createNonNegativeNumber(metadata.size);
					if (this.infohash?.length === 0) this.infohash = metadata.infohash;
					this.save();
					return this;
				} catch (e) {
					if (this._client.config.logLevel === "verbose") console.log(e);
				}
			}
		}

		const filePath = join(FILESPATH, hash.toString());
		if (await this._client.fs.exists(filePath)) {
			const fileSize = await this._client.fs.getFileSize(filePath);
			if (!(fileSize instanceof Error)) {
				this.size = Utils.createNonNegativeNumber(fileSize);
				this.save();
			}
			return this;
		}

		if (this._client.s3 !== undefined) {
			try {
				const data = await this._client.s3.statObject(`${hash}.stuf`);
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
		if (await this._client.fs.exists(filePath)) return true;

		let size = this.size;
		if (size === 0) {
			size = Utils.createNonNegativeNumber(file.byteLength);
			this.size = size;
			this.save();
		}
		const remainingSpace = await this._client.utils.remainingStorage();
		if (remainingSpace instanceof ErrorNotInitialised) return remainingSpace;
		if (this._client.config.maxCache !== -1 && size > remainingSpace) this._client.utils.purgeCache(size, remainingSpace);

		this._client.fs.writeFile(filePath, file);
		const fileContent = await this._client.fs.readFile(filePath);
		if (fileContent instanceof Error) return fileContent;
		const savedHash = await Utils.hashUint8Array(fileContent);
		if (savedHash !== hash) await this._client.fs.remove(filePath); // In case of broken file
		return true;
	}

	async fetchFromCache(): Promise<{ file: Uint8Array; signal: number } | ErrorNotFound | ErrorNotInitialised | ErrorChecksumMismatch> {
		const hash = this.hash;
		console.log(`File:     ${hash}  Checking Cache`);
		const filePath = join(FILESPATH, hash.toString());
		this.seed();
		if (!await this._client.fs.exists(filePath)) return new ErrorNotFound();
		const fileContents = await this._client.fs.readFile(filePath);
		if (fileContents instanceof Error) return fileContents;
		const savedHash = await Utils.hashUint8Array(fileContents);
		if (savedHash !== this.hash) {
			await this._client.fs.remove(filePath).catch(console.error);
			return new ErrorChecksumMismatch();
		}
		return {
			file: fileContents,
			signal: Utils.interfere(100),
		};
	}

	async fetchFromS3(): Promise<{ file: Uint8Array; signal: number } | ErrorNotInitialised | ErrorNotFound | ErrorChecksumMismatch> {
		console.log(`File:     ${this.hash}  Checking S3`);
		if (this._client.s3 === undefined) return new ErrorNotInitialised();
		const data = (await this._client.s3.getObject(`${this.hash}.stuf`)).body;
		if (data === null) return new ErrorNotFound();

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
		// 				if (this._client.config.logLevel === "verbose") console.log(`File:     ${hash}  Reached memory limit, waiting`, this.size);
		// 				if (this.size === 0 || Utils.hasSufficientMemory(this.size)) clearInterval(intervalId);
		// 			}, this._client.config.memoryThresholdReachedWait);
		// 		}),
		// 		this._client.config.timeout / 2,
		// 	);
		// }

		let file: { file: Uint8Array; signal: number } | ErrorNotFound | ErrorNotInitialised | ErrorChecksumMismatch = await this.fetchFromCache();
		if (!(file instanceof Error)) console.log(`File:     ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`);
		else {
			if (this._client.config.s3Endpoint.length > 0) file = await this.fetchFromS3();
			if (!(file instanceof Error)) console.log(`File:     ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`);
			else {
				file = await this.download();
				if (file instanceof Error) {
					this.found = false;
					this._client.events.log(this._client.events.fileEvents.FileNotFound);
					this.save();
				}
			}
		}

		this._client.events.log(this._client.events.fileEvents.FileServed);
		if (!(file instanceof Error)) this.seed();

		return file;
	}

	save(): void {
		this._client.files.db.update(this.hash, this);
	}

	async seed(): Promise<void> {
		// TODO: webtorrent.add() all known files
		if (!this._client.webtorrent) return;
		if (seeding.includes(this.hash)) return;
		seeding.push(this.hash);
		const filePath = join(FILESPATH, this.hash);
		if (!this._client.fs.exists(filePath)) return;
		this._client.webtorrent.seed(typeof window === "undefined" ? filePath : await this._client.fs.readFile(filePath), {
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
		this._client.files.db.increment(this.hash, column);
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
		if (!this._client.utils.hasSufficientMemory(size)) {
			console.log("Reached memory limit, waiting");
			await new Promise(() => {
				const intervalId = setInterval(async () => {
					if (await this._client.utils.hasSufficientMemory(size)) clearInterval(intervalId);
				}, this._client.config.memoryThresholdReachedWait);
			});
		}

		const peers = this._client.rpcClient.http.getPeers(true);
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
		const responses = this._client.rpcClient.rtc.fetch(`http://localhost/download/${this.hash}`);
		for (let i = 0; i < responses.length; i++) {
			const response = await responses[i];
			const fileContent = new Uint8Array(await response.arrayBuffer());
			console.log(`File:     ${this.hash}  Validating hash`);
			const verifiedHash = await Utils.hashUint8Array(fileContent);
			console.log(`File:     ${this.hash}  Done Validating hash`);
			if (this.hash !== verifiedHash) return new ErrorChecksumMismatch();
			console.log(`File:     ${this.hash}  Valid hash`);

			const ethAddress = response.headers.get("Ethereum-Address");
			if (ethAddress) this._client.wallet.transfer(ethAddress as EthAddress, 1_000_000n * BigInt(fileContent.byteLength));

			if (this.name === null || this.name.length === 0) {
				this.name = String(response.headers.get("Content-Disposition")?.split("=")[1].replace(/"/g, "").replace(" [HYDRAFILES]", ""));
				this.save();
			}
		}

		return new ErrorNotFound();
	}
}

class Files {
	private _client: Hydrafiles;
	public db: FileDB;
	public filesHash = new Map<string, File>(); // TODO: add inserts
	public filesInfohash = new Map<string, File>(); // TODO: add inserts
	public filesId = new Map<string, File>(); // TODO: add inserts

	private constructor(client: Hydrafiles, db: FileDB) {
		this._client = client;
		this.db = db;

		setTimeout(async () => {
			const files = await this.db.select();
			for (const file of files) {
				this.add(file);
			}
		}, 1000); // Runs 1 sec late to ensure Files gets saves to this._client
	}

	static async init(client: Hydrafiles): Promise<Files> {
		return new Files(client, await FileDB.init(client));
	}

	public async add(values: Partial<FileAttributes>): Promise<File> {
		if (!values.hash) throw new Error("Hash not defined");
		const file = await File.init(values, this._client, false);
		this.filesHash.set(values.hash, file);
		if (values.infohash) this.filesInfohash.set(values.infohash, file);
		if (values.id) this.filesId.set(values.id, file);
		return file;
	}

	public getFiles(): File[] {
		return Array.from(this.filesHash.values())
			.sort((a, b) => (b.voteHash ?? "").localeCompare(a.voteHash ?? ""));
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
		const responses = await Promise.all(this._client.rpcClient.fetch("http://localhost/files"));
		for (let i = 0; i < responses.length; i++) {
			if (!(responses[i] instanceof ErrorRequestFailed)) {
				try {
					files = files.concat((await (responses[i] as Response).json()) as FileAttributes[]);
				} catch (e) {
					if (this._client.config.logLevel === "verbose") console.log(e);
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
				const currentFile = await this.add(fileObj);
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
