import type Hydrafiles from "../../hydrafiles.ts";
import Utils from "../../utils.ts";
import type { Database } from "jsr:@db/sqlite@0.11";
import type { indexedDB } from "https://deno.land/x/indexeddb@v1.1.0/ponyfill.ts";
import File from "../../file.ts";

type DatabaseWrapper = { type: "UNDEFINED"; db: undefined } | { type: "SQLITE"; db: Database } | { type: "INDEXEDDB"; db: IDBDatabase };

interface PeerAttributes {
	host: string;
	hits: number;
	rejects: number;
	bytes: number;
	duration: number;
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

export class PeerDB {
	private _client: Hydrafiles;
	db: DatabaseWrapper = { type: "UNDEFINED", db: undefined };

	constructor(client: Hydrafiles) {
		this._client = client;
	}

	static async init(client: Hydrafiles): Promise<PeerDB> {
		const peerDB = new PeerDB(client);

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

	objectStore(): IDBObjectStore {
		if (this.db.type !== "INDEXEDDB") throw new Error("Wrong DB type when calling objectStore");
		return this.db.db.transaction("peer", "readwrite").objectStore("peer");
	}

	select<T extends keyof PeerAttributes>(where?: { key: T; value: NonNullable<PeerAttributes[T]> } | undefined, orderBy?: { key: T; direction: "ASC" | "DESC" } | "RANDOM" | undefined): Promise<PeerAttributes[]> {
		if (this.db === undefined) return new Promise((resolve) => resolve([]));

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
				const request = where ? this.objectStore().index(where.key).openCursor(where.value) : this.objectStore().openCursor();
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

	insert(values: Partial<PeerAttributes>): void {
		if (typeof this.db === "undefined") return;
		const peer: PeerAttributes = {
			host: values.host,
			hits: values.hits ?? 0,
			rejects: values.rejects ?? 0,
			bytes: values.bytes ?? 0,
			duration: values.duration ?? 0,
			updatedAt: values.updatedAt ?? new Date().toISOString(),
		} as PeerAttributes;
		console.log(`  ${peer.host}  Peer INSERTed`, values);
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
			const request = this.objectStore().add(peer);

			request.onsuccess = function (event): void {
				// @ts-expect-error:
				console.log(`  ${peer.hash}  Peer added successfully:`, event.target.result);
			};

			request.onerror = function (event): void {
				// @ts-expect-error:
				console.error("Error adding peer:", event.target.error);
			};

			this.objectStore().add(peer);
		}
	}

	async update(host: string, newPeer: PeerAttributes | HTTPPeer): Promise<void> {
		if (this.db === undefined) return;

		// Get the current peer attributes before updating
		const currentPeer = (await this.select({ key: "host", value: host }))[0] ?? { host };
		if (!currentPeer) {
			console.error(`  ${host}  Not found when updating`);
			return;
		}

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

		if (updatedColumn.length <= 1) return;

		if (this.db.type === "SQLITE") {
			params.push(host);
			const query = `UPDATE peer SET ${updatedColumn.map((column) => `${column} = ?`).join(", ")} WHERE host = ?`;
			this.db.db.prepare(query).values(params);
			console.log(
				`  ${host}  Peer UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._client.config.logLevel === "verbose" ? ` - Params: ${params.join(", ")}  - Query: ${query}` : ""),
				this._client.config.logLevel === "verbose" ? console.log(`  ${host}  Updated Values:`, beforeAndAfter) : "",
			);
		} else {
			// @ts-expect-error:
			const { _db, ...clonedPeer } = newPeer;
			if (this.db.type === "INDEXEDDB") this.objectStore().put(clonedPeer).onerror = console.error;
			console.log(
				`  ${host}  Peer UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._client.config.logLevel === "verbose" ? ` - Params: ${params.join(", ")}` : ""),
				this._client.config.logLevel === "verbose" ? console.log(`  ${host}  Updated Values:`, beforeAndAfter) : "",
			);
		}
	}

	delete(host: string): void {
		if (this.db === undefined) return;
		const query = `DELETE FROM peer WHERE host = ?`;

		if (this.db.type === "SQLITE") {
			this.db.db.exec(query, host);
		} else if (this.db.type === "INDEXEDDB") this.objectStore().delete(host).onerror = console.error;
		console.log(`  ${host}  Peer DELETEd`);
	}

	increment<T>(host: string, column: keyof PeerAttributes): void {
		if (this.db === undefined) return;
		if (this.db.type === "SQLITE") this.db.db.prepare(`UPDATE peer set ${column} = ${column}+1 WHERE host = ?`).values(host);
		else if (this.db.type === "INDEXEDDB") {
			const request = this.objectStore().get(host);
			request.onsuccess = (event) => {
				const target = event.target;
				if (!target) return;
				const peer = (target as IDBRequest).result;
				if (peer && this.db.type === "INDEXEDDB") {
					peer[column] = (peer[column] || 0) + 1;
					this.objectStore().put(peer).onsuccess = () => console.log(`  ${host}  Incremented ${column}`);
				}
			};
		}
	}

	count(): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db === undefined) return resolve(0);
			else if (this.db.type === "SQLITE") {
				const result = this.db.db.prepare("SELECT COUNT(*) FROM peer").value() as number[];
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
			if (this.db === undefined) return resolve(0);
			if (this.db.type === "SQLITE") {
				const result = this.db.db.prepare(`SELECT SUM(${column}) FROM peer${where.length !== 0 ? ` WHERE ${where}` : ""}`).value() as number[];
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

export class HTTPPeer implements PeerAttributes {
	host: string;
	hits = 0;
	rejects = 0;
	bytes = 0;
	duration = 0;
	updatedAt: string = new Date().toISOString();
	private _db: PeerDB;

	constructor(values: PeerAttributes, db: PeerDB) {
		this._db = db;

		if (values.host === undefined || values.host === null) throw new Error("Created peer without host");
		this.host = values.host;

		this.hits = values.hits;
		this.rejects = values.rejects;
		this.bytes = values.bytes;
		this.duration = values.duration;
		this.updatedAt = values.updatedAt;
	}

	static async init(values: Partial<PeerAttributes>, db: PeerDB): Promise<HTTPPeer> {
		if (values.host === undefined) throw new Error("Hash is required");
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

		return new HTTPPeer(peer, db);
	}

	save(): void {
		this.updatedAt = new Date().toISOString();
		if (this._db) this._db.update(this.host, this);
	}
}

// TODO: Log common user-agents and re-use them to help anonimise non Hydrafiles peers
export default class HTTPClient {
	private _client: Hydrafiles;
	/** @internal */
	public _db: PeerDB;

	constructor(client: Hydrafiles, db: PeerDB) {
		this._client = client;
		this._db = db;
	}

	public static async init(client: Hydrafiles): Promise<HTTPClient> {
		const db = await PeerDB.init(client);
		const peers = new HTTPClient(client, db);

		for (let i = 0; i < client.config.bootstrapPeers.length; i++) {
			await peers.add(client.config.bootstrapPeers[i]);
		}
		return peers;
	}

	async add(host: string): Promise<void> {
		if (host !== this._client.config.publicHostname) await HTTPPeer.init({ host }, this._db);
	}

	public getPeers = async (applicablePeers = false): Promise<PeerAttributes[]> => {
		const peers = (await this._db.select()).filter((peer) => !applicablePeers || typeof window === "undefined" || !peer.host.startsWith("http://"));

		if (this._client.config.preferNode === "FASTEST") {
			return peers.sort((a, b) => a.bytes / a.duration - b.bytes / b.duration);
		} else if (this._client.config.preferNode === "LEAST_USED") {
			return peers.sort((a, b) => a.hits - a.rejects - (b.hits - b.rejects));
		} else if (this._client.config.preferNode === "HIGHEST_HITRATE") {
			return peers.sort((a, b) => a.hits - a.rejects - (b.hits - b.rejects));
		} else {
			return peers;
		}
	};

	async downloadFromPeer(peer: HTTPPeer, file: File): Promise<{ file: Uint8Array; signal: number } | false> {
		try {
			const startTime = Date.now();

			const hash = file.hash;
			console.log(`  ${hash}  Downloading from ${peer.host}`);
			let response;
			try {
				response = await Utils.promiseWithTimeout(fetch(`${peer.host}/download/${hash}`), this._client.config.timeout);
			} catch (e) {
				const err = e as Error;
				if (this._client.config.logLevel === "verbose" && err.message !== "Promise timed out") console.error(e);
				return false;
			}
			const peerContent = new Uint8Array(await response.arrayBuffer());
			console.log(`  ${hash}  Validating hash`);
			const verifiedHash = await Utils.hashUint8Array(peerContent);
			console.log(`  ${hash}  Done Validating hash`);
			if (hash !== verifiedHash) return false;
			console.log(`  ${hash}  Valid hash`);

			if (file.name === undefined || file.name === null || file.name.length === 0) {
				file.name = String(response.headers.get("Content-Disposition")?.split("=")[1].replace(/"/g, "").replace(" [HYDRAFILES]", ""));
				file.save();
			}

			peer.duration += Date.now() - startTime;
			peer.bytes += peerContent.byteLength;
			peer.hits++;
			peer.save();

			await file.cacheFile(peerContent);
			return {
				file: peerContent,
				signal: Utils.interfere(Number(response.headers.get("Signal-Strength"))),
			};
		} catch (e) {
			console.error(e);
			peer.rejects++;

			peer.save();
			return false;
		}
	}

	async getValidPeers(): Promise<PeerAttributes[]> {
		const peers = await this.getPeers();
		const results: PeerAttributes[] = [];
		const executing: Array<Promise<void>> = [];

		for (let i = 0; i < peers.length; i++) {
			const peer = peers[i];
			if (peer.host === this._client.config.publicHostname) {
				results.push(peer);
				continue;
			}
			const promise = this.validatePeer(await HTTPPeer.init(peer, this._db)).then((result) => {
				if (result) results.push(peer);
				executing.splice(executing.indexOf(promise), 1);
			});
			executing.push(promise);
		}
		await Promise.all(executing);
		return results;
	}

	async validatePeer(peer: HTTPPeer): Promise<boolean> {
		const file = await File.init({ hash: "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f" }, this._client);
		if (!file) throw new Error("Failed to build file");
		return await this.downloadFromPeer(peer, file) !== false;
	}

	public async fetch(input: RequestInfo, init?: RequestInit): Promise<Promise<Response | false>[]> {
		const req = typeof input === "string" ? new Request(input, init) : input;
		const peers = await this.getPeers(true);
		const fetchPromises = peers.map(async (peer) => {
			try {
				const url = new URL(req.url);
				const peerUrl = new URL(peer.host);
				url.hostname = peerUrl.hostname;
				url.protocol = peerUrl.protocol;
				return await Utils.promiseWithTimeout(fetch(url.toString(), init), this._client.config.timeout);
			} catch (e) {
				if (this._client.config.logLevel === "verbose") console.error(e);
				return false;
			}
		});

		return fetchPromises;
	}

	// TODO: Compare list between all peers and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
	async updatePeers(): Promise<void> {
		console.log(`Fetching peers`);
		const responses = await Promise.all(await this._client.rpcClient.fetch("http://localhost/peers"));
		for (let i = 0; i < responses.length; i++) {
			try {
				if (!(responses[i] instanceof Response)) continue;
				const response = responses[i];
				if (response instanceof Response) {
					const remotePeers = (await response.json()) as HTTPPeer[];
					for (const remotePeer of remotePeers) {
						this.add(remotePeer.host).catch((e) => {
							if (this._client.config.logLevel === "verbose") console.error(e);
						});
					}
				}
			} catch (e) {
				if (this._client.config.logLevel === "verbose") console.error(e);
			}
		}
	}
}