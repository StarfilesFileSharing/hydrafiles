import type Hydrafiles from "../../hydrafiles.ts";
import Utils, { type NonNegativeNumber } from "../../utils.ts";
import type { Database } from "jsr:@db/sqlite@0.11";
import type { indexedDB } from "https://deno.land/x/indexeddb@v1.1.0/ponyfill.ts";
import { File } from "../../file.ts";
import type RPCClient from "../client.ts";
import type { EthAddress } from "../../wallet.ts";
import { ErrorChecksumMismatch, ErrorDownloadFailed, ErrorMissingRequiredProperty, ErrorNotInitialised, ErrorRequestFailed, ErrorTimeout, ErrorWrongDatabaseType } from "../../errors.ts";
import { ErrorNotFound } from "../../errors.ts";

type DatabaseWrapper = { type: "UNDEFINED"; db: undefined } | { type: "SQLITE"; db: Database } | { type: "INDEXEDDB"; db: IDBDatabase };

export interface PeerAttributes {
	host: string;
	hits: NonNegativeNumber;
	rejects: NonNegativeNumber;
	bytes: NonNegativeNumber;
	duration: NonNegativeNumber;
	updatedAt: string;
}

function createIDBDatabase(): Promise<IDBDatabase> {
	const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		console.log("Startup: PeerDB: Opening IndexedDB Connection");
		// @ts-expect-error:
		const request = indexedDB.open("Peer", 1);
		request.onupgradeneeded = (event): void => {
			console.log("Startup: PeerDB: On Upgrade Needed");
			// @ts-expect-error:
			if (!event.target.result.objectStoreNames.contains("peer")) {
				// @ts-expect-error:
				const objectStore = event.target.result.createObjectStore("peer", { keyPath: "host" });
				objectStore.createIndex("host", "host", { unique: true });
				objectStore.createIndex("hits", "hits", { unique: false });
				objectStore.createIndex("rejects", "rejects", { unique: false });
				objectStore.createIndex("bytes", "bytes", { unique: false });
				objectStore.createIndex("duration", "duration", { unique: false });
				objectStore.createIndex("createdAt", "createdAt", { unique: false });
				objectStore.createIndex("updatedAt", "updatedAt", { unique: false });
			}
		};
		request.onsuccess = () => {
			console.log("Startup: PeerDB: On Success");
			resolve(request.result as unknown as IDBDatabase);
		};
		request.onerror = () => {
			console.error("Startup: PeerDB error:", request.error);
			reject(request.error);
		};
		request.onblocked = () => {
			console.error("Startup: PeerDB: Blocked. Close other tabs with this site open.");
		};
	});

	return dbPromise;
}

/**
 * @group Database
 */
class PeerDB {
	private _rpcClient: RPCClient;
	db: DatabaseWrapper = { type: "UNDEFINED", db: undefined };

	private constructor(rpcClient: RPCClient) {
		this._rpcClient = rpcClient;
	}

	/**
	 * Initializes an instance of PeerDB.
	 * @returns {PeerDB} A new instance of PeerDB.
	 * @default
	 */
	static async init(rpcClient: RPCClient): Promise<PeerDB> {
		const peerDB = new PeerDB(rpcClient);

		if (typeof window === "undefined") {
			const database = (await import("jsr:@db/sqlite@0.11")).Database;
			peerDB.db = { type: "SQLITE", db: new database("peer.db") };
			peerDB.db.db.exec(`
				CREATE TABLE IF NOT EXISTS peer (
					host TEXT PRIMARY KEY,
					hits NUMBER DEFAULT 0,
					rejects NUMBER DEFAULT 0,
					bytes NUMBER DEFAULT 0,
					duration NUMBER DEFAULT 0,
					createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
					updatedAt DATETIME
				)
			`);
		} else {
			const db = await createIDBDatabase();
			peerDB.db = { type: "INDEXEDDB", db: db };
		}
		return peerDB;
	}

	objectStore(): IDBObjectStore | ErrorWrongDatabaseType {
		if (this.db.type !== "INDEXEDDB") return new ErrorWrongDatabaseType();
		return this.db.db.transaction("peer", "readwrite").objectStore("peer");
	}

	select<T extends keyof PeerAttributes>(where?: { key: T; value: NonNullable<PeerAttributes[T]> } | undefined, orderBy?: { key: T; direction: "ASC" | "DESC" } | "RANDOM" | undefined): Promise<PeerAttributes[]> {
		if (this.db.type === "SQLITE") {
			let query = "SELECT * FROM peer";
			const params: (string | number | boolean)[] = [];

			if (where) {
				query += ` WHERE ${where.key} = ?`;
				params.push(where.value);
			}

			if (orderBy) {
				if (orderBy === "RANDOM") query += ` ORDER BY RANDOM()`;
				else query += ` ORDER BY ${orderBy.key} ${orderBy.direction}`;
			}
			const results = this.db.db.prepare(query).all(params) as unknown as PeerAttributes[];
			return new Promise((resolve) => resolve(results));
		} else if (this.db.type === "INDEXEDDB") {
			return new Promise((resolve, reject) => {
				if (this.db.type !== "INDEXEDDB") return;
				const objectStore = this.objectStore();
				if (objectStore instanceof ErrorWrongDatabaseType) return new ErrorWrongDatabaseType();
				const request = where ? objectStore.index(where.key).openCursor(where.value) : objectStore.openCursor();
				const results: PeerAttributes[] = [];

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

	insert(values: Partial<PeerAttributes>): true | ErrorNotInitialised | ErrorWrongDatabaseType {
		if (typeof this.db === "undefined") return new ErrorNotInitialised();
		const peer: PeerAttributes = {
			host: values.host,
			hits: values.hits ?? 0,
			rejects: values.rejects ?? 0,
			bytes: values.bytes ?? 0,
			duration: values.duration ?? 0,
			updatedAt: values.updatedAt ?? new Date().toISOString(),
		} as PeerAttributes;
		console.log(`Peer: ${peer.host}  Peer INSERTed`, values);
		if (this.db.type === "SQLITE") {
			const query = `INSERT INTO peer (host, hits, rejects, bytes, duration, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`;

			this.db.db.prepare(query).run(
				peer.host,
				peer.hits,
				peer.rejects,
				peer.bytes,
				peer.duration,
				peer.updatedAt,
			);
		} else if (this.db.type === "INDEXEDDB") {
			const objectStore = this.objectStore();
			if (objectStore instanceof ErrorWrongDatabaseType) return objectStore;
			const request = objectStore.add(peer);

			// @ts-expect-error:
			request.onsuccess = (event): void => console.log(`Peer: ${peer.hash}  Peer added successfully:`, event.target.result);
			// @ts-expect-error:
			request.onerror = (event): void => console.error("Error adding peer:", event.target.error);
		}
		return true;
	}

	async update(host: string, newPeer: PeerAttributes | HTTPPeer): Promise<true | ErrorWrongDatabaseType> {
		// Get the current peer attributes before updating
		const currentPeer = (await this.select({ key: "host", value: host }))[0] ?? { host };
		if (!currentPeer) return new ErrorNotFound(host);

		newPeer.updatedAt = new Date().toISOString();

		const updatedColumn: string[] = [];
		const params: (string | number | boolean)[] = [];
		const keys = Object.keys(newPeer);

		type BeforeAfter = Record<string, { before: PeerAttributes[keyof PeerAttributes]; after: PeerAttributes[keyof PeerAttributes] }>;
		const beforeAndAfter: BeforeAfter = {};

		for (let i = 0; i < keys.length; i++) {
			const key = keys[i] as keyof PeerAttributes;
			if (newPeer[key] !== undefined && newPeer[key] !== null && newPeer[key] !== currentPeer[key] && typeof newPeer[key] !== "object") {
				updatedColumn.push(key);
				params.push(newPeer[key]);
				beforeAndAfter[key] = { before: currentPeer[key], after: newPeer[key] };
			}
		}

		if (updatedColumn.length <= 1) {
			console.warn("Unnecessary update call");
			return true;
		}

		if (this.db.type === "SQLITE") {
			params.push(host);
			const query = `UPDATE peer SET ${updatedColumn.map((column) => `${column} = ?`).join(", ")} WHERE host = ?`;
			this.db.db.prepare(query).values(params);
			console.log(
				`Peer: ${host}  Peer UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._rpcClient._client.config.logLevel === "verbose" ? ` - Params: ${params.join(", ")}  - Query: ${query}` : ""),
				this._rpcClient._client.config.logLevel === "verbose" ? console.log(`Peer: ${host}  Updated Values:`, beforeAndAfter) : "",
			);
		} else {
			// @ts-expect-error:
			const { _db, ...clonedPeer } = newPeer;
			if (this.db.type === "INDEXEDDB") {
				const objectStore = this.objectStore();
				if (objectStore instanceof ErrorWrongDatabaseType) return new ErrorWrongDatabaseType();
				objectStore.put(clonedPeer).onerror = (e) => {
					console.error(e, "Failed to save peer", clonedPeer);
				};
			}
			console.log(
				`Peer: ${host}  Peer UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._rpcClient._client.config.logLevel === "verbose" ? ` - Params: ${params.join(", ")}` : ""),
				this._rpcClient._client.config.logLevel === "verbose" ? console.log(`Peer: ${host}  Updated Values:`, beforeAndAfter) : "",
			);
		}

		return true;
	}

	delete(host: string): true | ErrorWrongDatabaseType {
		const query = `DELETE FROM peer WHERE host = ?`;

		if (this.db.type === "SQLITE") {
			this.db.db.exec(query, host);
		} else if (this.db.type === "INDEXEDDB") {
			const objectStore = this.objectStore();
			if (objectStore instanceof ErrorWrongDatabaseType) return new ErrorWrongDatabaseType();
			objectStore.delete(host).onerror = console.error;
		}
		console.log(`Peer: ${host}  Peer DELETEd`);
		return true;
	}

	increment<T>(host: string, column: keyof PeerAttributes): true | ErrorWrongDatabaseType {
		if (this.db.type === "SQLITE") this.db.db.prepare(`UPDATE peer set ${column} = ${column}+1 WHERE host = ?`).values(host);
		else if (this.db.type === "INDEXEDDB") {
			const objectStore = this.objectStore();
			if (objectStore instanceof ErrorWrongDatabaseType) return new ErrorWrongDatabaseType();
			const request = objectStore.get(host);
			request.onsuccess = (event) => {
				const target = event.target;
				if (!target) return;
				const peer = (target as IDBRequest).result;
				if (peer && this.db.type === "INDEXEDDB") {
					peer[column] = (peer[column] || 0) + 1;
					const objectStore = this.objectStore();
					if (objectStore instanceof ErrorWrongDatabaseType) return objectStore;
					objectStore.put(peer).onsuccess = () => console.log(`Peer: ${host}  Incremented ${column}`);
				}
			};
		}
		return true;
	}

	count(): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db.type === "SQLITE") {
				const result = this.db.db.prepare("SELECT COUNT(*) FROM peer").value() as number[];
				return resolve(result[0]);
			}

			if (this.db.type === "UNDEFINED") return resolve(0);
			const objectStore = this.objectStore();
			if (objectStore instanceof ErrorWrongDatabaseType) return objectStore;
			const request = objectStore.count();
			request.onsuccess = () => resolve(request.result);
			request.onerror = (event) => reject((event.target as IDBRequest).error);
		});
	}

	sum(column: string, where = ""): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db.type === "SQLITE") {
				const result = this.db.db.prepare(`SELECT SUM(${column}) FROM peer${where.length !== 0 ? ` WHERE ${where}` : ""}`).value() as number[];
				return resolve(result === undefined ? 0 : result[0]);
			} else {
				if (this.db.type === "UNDEFINED") return resolve(0);
				let sum = 0;
				const objectStore = this.objectStore();
				if (objectStore instanceof ErrorWrongDatabaseType) return objectStore;
				const request = objectStore.openCursor();

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

class HTTPPeer implements PeerAttributes {
	host: string;
	hits: NonNegativeNumber = 0 as NonNegativeNumber;
	rejects: NonNegativeNumber = 0 as NonNegativeNumber;
	bytes: NonNegativeNumber = 0 as NonNegativeNumber;
	duration: NonNegativeNumber = 0 as NonNegativeNumber;
	updatedAt: string = new Date().toISOString();
	private _db: PeerDB;
	private _client: Hydrafiles;

	private constructor(values: PeerAttributes, db: PeerDB, client: Hydrafiles) {
		this._client = client;
		this._db = db;

		this.host = values.host;

		this.hits = values.hits;
		this.rejects = values.rejects;
		this.bytes = values.bytes;
		this.duration = values.duration;
		this.updatedAt = values.updatedAt;
	}

	/**
	 * Initializes an instance of HTTPPeer.
	 * @returns {HTTPPeer} A new instance of HTTPPeer.
	 * @default
	 */
	static async init(values: Partial<PeerAttributes>, db: PeerDB, client: Hydrafiles): Promise<HTTPPeer | ErrorMissingRequiredProperty> {
		if (values.host === undefined) return new ErrorMissingRequiredProperty();
		const result = new URL(values.host);
		if (!result.protocol || !result.host || result.protocol === "hydra") throw new Error("Invalid URL");

		const peerAttributes: PeerAttributes = {
			host: values.host,
			hits: values.hits ?? 0,
			rejects: values.rejects ?? 0,
			bytes: values.bytes ?? 0,
			duration: values.duration ?? 0,
			updatedAt: values.updatedAt ?? new Date().toISOString(),
		} as PeerAttributes;

		let peer = (await db.select({ key: "host", value: values.host }))[0];
		if (peer === undefined) {
			db.insert(peerAttributes);
			peer = (await db.select({ key: "host", value: values.host }))[0];
		}

		return new HTTPPeer(peer, db, client);
	}

	save(): void {
		this.updatedAt = new Date().toISOString();
		if (this._db) this._db.update(this.host, this);
	}

	async downloadFile(file: File): Promise<{ file: Uint8Array; signal: number } | ErrorTimeout | ErrorDownloadFailed> {
		try {
			const startTime = Date.now();

			const hash = file.hash;
			console.log(`File: ${hash}  Downloading from ${this.host}`);
			let response;
			try {
				response = await Utils.promiseWithTimeout(fetch(`${this.host}/download/${hash}`), this._client.config.timeout);
			} catch (e) {
				if (this._client.config.logLevel === "verbose") console.error(e);
				return new ErrorRequestFailed();
			}
			if (response instanceof ErrorTimeout) return new ErrorTimeout();
			const fileContent = new Uint8Array(await response.arrayBuffer());
			console.log(`File: ${hash}  Validating hash`);
			const verifiedHash = await Utils.hashUint8Array(fileContent);
			console.log(`File: ${hash}  Done Validating hash`);
			if (hash !== verifiedHash) return new ErrorChecksumMismatch();
			console.log(`File: ${hash}  Valid hash`);

			const ethAddress = response.headers.get("Ethereum-Address");
			if (ethAddress) this._client.wallet.transfer(ethAddress as EthAddress, 1_000_000n * BigInt(fileContent.byteLength));

			if (file.name === undefined || file.name === null || file.name.length === 0) {
				file.name = String(response.headers.get("Content-Disposition")?.split("=")[1].replace(/"/g, "").replace(" [HYDRAFILES]", ""));
				file.save();
			}

			this.duration = Utils.createNonNegativeNumber(this.duration + Date.now() - startTime);
			this.bytes = Utils.createNonNegativeNumber(this.bytes + fileContent.byteLength);
			this.hits++;
			this.save();

			await file.cacheFile(fileContent);
			return {
				file: fileContent,
				signal: Utils.interfere(Number(response.headers.get("Signal-Strength"))),
			};
		} catch (e) {
			console.error(e);
			this.rejects++;

			this.save();
			return new ErrorDownloadFailed();
		}
	}

	async validate(): Promise<boolean> {
		const file = await File.init({ hash: Utils.sha256("04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f") }, this._client);
		if (!file) throw new Error("Failed to build file");
		return "file" in await this.downloadFile(file);
	}
}

// TODO: Log common user-agents and re-use them to help anonimise non Hydrafiles peers
export default class HTTPPeers {
	private _rpcClient: RPCClient;
	public db: PeerDB;
	public peers = new Map<string, HTTPPeer>();

	private constructor(rpcClient: RPCClient, db: PeerDB) {
		this._rpcClient = rpcClient;
		this.db = db;
	}

	/**
	 * Initializes an instance of HTTPPeers.
	 * @returns {HTTPPeers} A new instance of HTTPPeers.
	 * @default
	 */
	public static async init(rpcClient: RPCClient): Promise<HTTPPeers> {
		const db = await PeerDB.init(rpcClient);
		const httpPeers = new HTTPPeers(rpcClient, db);

		(await Promise.all((await db.select()).map((peer) => HTTPPeer.init(peer, db, rpcClient._client)))).forEach((peer) => {
			if (!(peer instanceof ErrorMissingRequiredProperty)) httpPeers.peers.set(peer.host, peer);
		});

		for (let i = 0; i < rpcClient._client.config.bootstrapPeers.length; i++) {
			await httpPeers.add(rpcClient._client.config.bootstrapPeers[i]);
		}
		return httpPeers;
	}

	async add(host: string): Promise<true | ErrorMissingRequiredProperty> {
		const peer = await HTTPPeer.init({ host }, this.db, this._rpcClient._client);
		if (peer instanceof ErrorMissingRequiredProperty) return peer;
		if (host !== this._rpcClient._client.config.publicHostname) this.peers.set(peer.host, peer);
		return true;
	}

	public getPeers = (applicablePeers = false): HTTPPeer[] => {
		const peers = Array.from(this.peers).filter((peer) => !applicablePeers || typeof window === "undefined" || !peer[0].startsWith("http://"));

		if (this._rpcClient._client.config.preferNode === "FASTEST") {
			return peers.map(([_, peer]) => peer).sort((a, b) => a.bytes / a.duration - b.bytes / b.duration);
		} else if (this._rpcClient._client.config.preferNode === "LEAST_USED") {
			return peers.map(([_, peer]) => peer).sort((a, b) => a.hits - a.rejects - (b.hits - b.rejects));
		} else if (this._rpcClient._client.config.preferNode === "HIGHEST_HITRATE") {
			return peers.sort((a, b) => a[1].hits - a[1].rejects - (b[1].hits - b[1].rejects)).map(([_, peer]) => peer);
		} else {
			return peers.map(([_, peer]) => peer);
		}
	};

	async getValidPeers(): Promise<PeerAttributes[]> {
		const peers = this.getPeers();
		const results: PeerAttributes[] = [];
		const executing: Array<Promise<void>> = [];

		for (let i = 0; i < peers.length; i++) {
			const peer = peers[i];
			if (peer.host === this._rpcClient._client.config.publicHostname) {
				results.push(peer);
				continue;
			}
			const promise = peer.validate().then((result) => {
				if (result) results.push(peer);
				executing.splice(executing.indexOf(promise), 1);
			});
			executing.push(promise);
		}
		await Promise.all(executing);
		return results;
	}

	public fetch(input: RequestInfo, init?: RequestInit): Promise<Response | ErrorRequestFailed>[] {
		const req = typeof input === "string" ? new Request(input, init) : input;
		const peers = this.getPeers(true);
		const fetchPromises = peers.map(async (peer) => {
			try {
				const url = new URL(req.url);
				const peerUrl = new URL(peer.host);
				url.hostname = peerUrl.hostname;
				url.protocol = peerUrl.protocol;
				return await Utils.promiseWithTimeout(fetch(url.toString(), init), this._rpcClient._client.config.timeout);
			} catch (e) {
				if (this._rpcClient._client.config.logLevel === "verbose") console.error(e);
				return new ErrorRequestFailed();
			}
		});

		return fetchPromises;
	}

	// TODO: Compare list between all peers and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
	async updatePeers(): Promise<void> {
		console.log(`Fetching peers`);
		const responses = await Promise.all(this._rpcClient._client.rpcClient.fetch("http://localhost/peers"));
		for (let i = 0; i < responses.length; i++) {
			try {
				if (!(responses[i] instanceof Response)) continue;
				const response = responses[i];
				if (response instanceof Response) {
					const remotePeers = (await response.json()) as HTTPPeer[];
					for (const remotePeer of remotePeers) {
						if (Utils.isPrivateIP(remotePeer.host) || remotePeer.host.startsWith("hydra://")) continue;
						this.add(remotePeer.host).catch((e) => {
							if (this._rpcClient._client.config.logLevel === "verbose") console.error(e);
						});
					}
				}
			} catch (e) {
				if (this._rpcClient._client.config.logLevel === "verbose") console.error(e);
			}
		}
	}

	public getSelf(): HTTPPeer | ErrorNotFound {
		const peer = this.peers.get(this._rpcClient._client.config.publicHostname);
		if (!peer) return new ErrorNotFound();
		return peer;
	}
}
