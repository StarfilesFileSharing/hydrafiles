import Utils, { type NonNegativeNumber } from "../../utils.ts";
import Database, { type DatabaseModal } from "../../database.ts";
import { File } from "../../file.ts";
import RPCClient from "../client.ts";
import type { EthAddress } from "../../wallet.ts";
import { ErrorChecksumMismatch, ErrorDownloadFailed, ErrorMissingRequiredProperty, ErrorRequestFailed, ErrorTimeout } from "../../errors.ts";
import { ErrorNotFound } from "../../errors.ts";

const peerModel = {
	tableName: "peer",
	columns: {
		host: { type: "TEXT" as const, primary: true },
		hits: { type: "INTEGER" as const, default: 0 },
		rejects: { type: "INTEGER" as const, default: 0 },
		bytes: { type: "INTEGER" as const, default: 0 },
		duration: { type: "INTEGER" as const, default: 0 },
		createdAt: { type: "DATETIME" as const, default: "CURRENT_TIMESTAMP" },
		updatedAt: { type: "DATETIME" as const, default: "CURRENT_TIMESTAMP" },
	},
};

export interface PeerAttributes {
	host: string;
	hits: NonNegativeNumber;
	rejects: NonNegativeNumber;
	bytes: NonNegativeNumber;
	duration: NonNegativeNumber;
	updatedAt: string;
}

class HTTPPeer implements PeerAttributes {
	host: string;
	hits: NonNegativeNumber = 0 as NonNegativeNumber;
	rejects: NonNegativeNumber = 0 as NonNegativeNumber;
	bytes: NonNegativeNumber = 0 as NonNegativeNumber;
	duration: NonNegativeNumber = 0 as NonNegativeNumber;
	updatedAt: string = new Date().toISOString();
	createdAt: string = new Date().toISOString();
	private _db: Database<typeof peerModel>;

	private constructor(values: DatabaseModal<typeof peerModel>, db: Database<typeof peerModel>) {
		this._db = db;

		this.host = values.host;

		this.hits = Utils.createNonNegativeNumber(values.hits);
		this.rejects = Utils.createNonNegativeNumber(values.rejects);
		this.bytes = Utils.createNonNegativeNumber(values.bytes);
		this.duration = Utils.createNonNegativeNumber(values.duration);
	}

	/**
	 * Initializes an instance of HTTPPeer.
	 * @returns {HTTPPeer} A new instance of HTTPPeer.
	 * @default
	 */
	static async init(values: Partial<DatabaseModal<typeof peerModel>>, db: Database<typeof peerModel>): Promise<HTTPPeer | ErrorMissingRequiredProperty> {
		if (values.host === undefined) return new ErrorMissingRequiredProperty();
		const result = new URL(values.host);
		if (!result.protocol || !result.host || result.protocol === "hydra") throw new Error("Invalid URL");

		let peer = (await db.select({ key: "host", value: values.host }))[0];
		if (peer === undefined) {
			db.insert({ host: values.host });
			peer = (await db.select({ key: "host", value: values.host }))[0];
		}

		return new HTTPPeer(peer, db);
	}

	save(): void {
		const peer: DatabaseModal<typeof peerModel> = {
			...this,
		};
		this._db.update(this.host, peer);
	}

	async downloadFile(file: File): Promise<{ file: Uint8Array; signal: number } | ErrorTimeout | ErrorDownloadFailed> {
		try {
			const startTime = Date.now();

			const hash = file.hash;
			console.log(`File:     ${hash}  Downloading from ${this.host}`);
			let response;
			try {
				response = await Utils.promiseWithTimeout(fetch(`${this.host}/download/${hash}`), RPCClient._client.config.timeout);
			} catch (e) {
				if (RPCClient._client.config.logLevel === "verbose") console.error(e);
				return new ErrorRequestFailed();
			}
			if (response instanceof ErrorTimeout) return new ErrorTimeout();
			const fileContent = new Uint8Array(await response.arrayBuffer());
			console.log(`File:     ${hash}  Validating hash`);
			const verifiedHash = await Utils.hashUint8Array(fileContent);
			console.log(`File:     ${hash}  Done Validating hash`);
			if (hash !== verifiedHash) return new ErrorChecksumMismatch();
			console.log(`File:     ${hash}  Valid hash`);

			const ethAddress = response.headers.get("Ethereum-Address");
			if (ethAddress) RPCClient._client.filesWallet.transfer(ethAddress as EthAddress, 1_000_000n * BigInt(fileContent.byteLength));

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
		const file = await File.init({ hash: "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f" });
		if (!file) throw new Error("Failed to build file");
		return "file" in await this.downloadFile(file);
	}
}

// TODO: Log common user-agents and re-use them to help anonimise non Hydrafiles peers
export default class HTTPPeers {
	public db: Database<typeof peerModel>;
	public peers = new Map<string, HTTPPeer>();

	private constructor(db: Database<typeof peerModel>) {
		this.db = db;
	}

	/**
	 * Initializes an instance of HTTPPeers.
	 * @returns {HTTPPeers} A new instance of HTTPPeers.
	 * @default
	 */
	public static async init(): Promise<HTTPPeers> {
		const db = await Database.init(peerModel, RPCClient._client);
		const httpPeers = new HTTPPeers(db);

		(await Promise.all((await db.select()).map((peer) => HTTPPeer.init(peer, db)))).forEach((peer) => {
			if (!(peer instanceof ErrorMissingRequiredProperty)) httpPeers.peers.set(peer.host, peer);
		});

		for (let i = 0; i < RPCClient._client.config.bootstrapPeers.length; i++) {
			await httpPeers.add(RPCClient._client.config.bootstrapPeers[i]);
		}
		for (let i = 0; i < RPCClient._client.config.customPeers.length; i++) {
			await httpPeers.add(RPCClient._client.config.customPeers[i]);
		}

		return httpPeers;
	}

	async add(host: string): Promise<true | ErrorMissingRequiredProperty> {
		const peer = await HTTPPeer.init({ host }, this.db);
		if (peer instanceof ErrorMissingRequiredProperty) return peer;
		if (host !== RPCClient._client.config.publicHostname) this.peers.set(peer.host, peer);
		return true;
	}

	public getPeers = (applicablePeers = false): HTTPPeer[] => {
		const peers = Array.from(this.peers).filter((peer) => !applicablePeers || typeof window === "undefined" || !peer[0].startsWith("http://"));

		if (RPCClient._client.config.preferNode === "FASTEST") return peers.map(([_, peer]) => peer).sort((a, b) => a.bytes / a.duration - b.bytes / b.duration);
		else if (RPCClient._client.config.preferNode === "LEAST_USED") return peers.map(([_, peer]) => peer).sort((a, b) => a.hits - a.rejects - (b.hits - b.rejects));
		else if (RPCClient._client.config.preferNode === "HIGHEST_HITRATE") return peers.sort((a, b) => a[1].hits - a[1].rejects - (b[1].hits - b[1].rejects)).map(([_, peer]) => peer);
		else return peers.map(([_, peer]) => peer);
	};

	async getValidPeers(): Promise<PeerAttributes[]> {
		const peers = this.getPeers();
		const results: PeerAttributes[] = [];
		const executing: Array<Promise<void>> = [];

		for (let i = 0; i < peers.length; i++) {
			const peer = peers[i];
			if (peer.host === RPCClient._client.config.publicHostname) {
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

	public fetch(url: URL, method = "GET", headers: { [key: string]: string } = {}, body: string | undefined = undefined): Promise<Response | ErrorRequestFailed | ErrorTimeout>[] {
		const peers = this.getPeers(true);
		const fetchPromises = peers.map(async (peer) => {
			try {
				const peerUrl = new URL(peer.host);
				url.hostname = peerUrl.hostname;
				url.protocol = peerUrl.protocol;
				return await Utils.promiseWithTimeout(fetch(url.toString(), { method, headers, body }), RPCClient._client.config.timeout);
			} catch (e) {
				if (RPCClient._client.config.logLevel === "verbose") console.error(e);
				return new ErrorRequestFailed();
			}
		});

		return fetchPromises;
	}

	// TODO: Compare list between all peers and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
	async updatePeers(): Promise<void> {
		console.log(`Fetching peers`);
		const responses = await Promise.all(await RPCClient._client.rpcClient.fetch("http://localhost/peers"));
		for (let i = 0; i < responses.length; i++) {
			try {
				if (!(responses[i] instanceof Response)) continue;
				const response = responses[i];
				if (response instanceof Response) {
					const remotePeers = (await response.json()) as HTTPPeer[];
					for (const remotePeer of remotePeers) {
						if (Utils.isPrivateIP(remotePeer.host) || remotePeer.host.startsWith("hydra://")) continue;
						this.add(remotePeer.host).catch((e) => {
							if (RPCClient._client.config.logLevel === "verbose") console.error(e);
						});
					}
				}
			} catch (e) {
				if (RPCClient._client.config.logLevel === "verbose") console.error(e);
			}
		}
	}

	public getSelf(): HTTPPeer | ErrorNotFound {
		const peer = this.peers.get(RPCClient._client.config.publicHostname);
		if (!peer) return new ErrorNotFound();
		return peer;
	}
}
