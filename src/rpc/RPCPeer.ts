import { WSPeer } from "./peers/ws.ts";
import type { DatabaseModal } from "../database.ts";
import { ErrorChecksumMismatch, ErrorDownloadFailed, ErrorMissingRequiredProperty, ErrorRequestFailed, ErrorTimeout, ErrorUnexpectedProtocol, ErrorUnreachableCodeReached } from "../errors.ts";
import Utils, { type NonNegativeNumber } from "../utils.ts";
import type { EthAddress } from "../wallet.ts";
import RPCPeers from "./RPCPeers.ts";
import { File } from "../file.ts";
import { HTTPClient } from "./peers/http.ts";
import { RTCPeer } from "./peers/rtc.ts";

export type Host = `https://${EthAddress}` | `${"http" | "https" | "ws" | "wss" | "wsc" | "rtc"}://${string}`;

async function validateHash(body: Uint8Array, hash: string): Promise<boolean> {
	console.log(`File:     ${hash}  Validating hash`);
	const verifiedHash = await Utils.hashUint8Array(body);
	console.log(`File:     ${hash}  Done Validating hash`);
	if (hash !== verifiedHash) return false;
	console.log(`File:     ${hash}  Valid hash`);
	return true;
}

export interface PeerAttributes {
	host: Host;
	hits: NonNegativeNumber;
	rejects: NonNegativeNumber;
	bytes: NonNegativeNumber;
	duration: NonNegativeNumber;
	updatedAt: string;
}

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

export default class RPCPeer implements PeerAttributes {
	peer: HTTPClient | WSPeer | RTCPeer;

	host!: Host;
	hits: NonNegativeNumber = 0 as NonNegativeNumber;
	rejects: NonNegativeNumber = 0 as NonNegativeNumber;
	bytes: NonNegativeNumber = 0 as NonNegativeNumber;
	duration: NonNegativeNumber = 0 as NonNegativeNumber;
	updatedAt: string = new Date().toISOString();
	createdAt: string = new Date().toISOString();

	constructor(peer: HTTPClient | WSPeer | RTCPeer, values: DatabaseModal<typeof peerModel>) {
		this.peer = peer;

		this.host = values.host as Host;
		this.hits = Utils.createNonNegativeNumber(values.hits);
		this.rejects = Utils.createNonNegativeNumber(values.rejects);
		this.bytes = Utils.createNonNegativeNumber(values.bytes);
		this.duration = Utils.createNonNegativeNumber(values.duration);
	}

	static async init(
		values: Partial<DatabaseModal<typeof peerModel>> & ({ host: Host; socket?: WebSocket }),
	): Promise<RPCPeer | ErrorMissingRequiredProperty | ErrorUnexpectedProtocol> {
		const url = new URL(values.host);
		if (!url.protocol || !url.host || url.protocol === "hydra") throw new Error("Invalid URL");

		let peerValues = (await RPCPeers.db.select({ key: "host", value: values.host }))[0];
		if (peerValues === undefined) {
			RPCPeers.db.insert({ host: values.host });
			peerValues = (await RPCPeers.db.select({ key: "host", value: values.host }))[0];
		}

		const peerUrl = new URL(peerValues.host);

		let peer;
		if (peerUrl.protocol === "rtc:") peer = new RTCPeer(values.host as `rtc://${EthAddress}.hydra`);
		else if (peerUrl.protocol === "http:" || peerUrl.protocol === "https:") peer = new HTTPClient(values.host);
		else if (peerUrl.protocol === "ws:" || peerUrl.protocol === "wss:" || (peerUrl.protocol === "wsc:" && values.socket)) peer = new WSPeer(values.host, values.socket);
		else if (peerUrl.protocol === "hydra:") throw new ErrorUnexpectedProtocol();
		else throw new ErrorUnreachableCodeReached();

		return new RPCPeer(peer, peerValues);
	}

	save(): void {
		const peer: DatabaseModal<typeof peerModel> = {
			...this,
		};
		RPCPeers.db.update(this.host, peer);
	}

	async downloadFile(file: File): Promise<{ file: Uint8Array; signal: number } | ErrorTimeout | ErrorDownloadFailed | ErrorChecksumMismatch> {
		try {
			const startTime = Date.now();

			const hash = file.hash;
			let response;
			console.log(`File:     ${hash}  Downloading from ${this.host}`);
			if (this.peer instanceof WSPeer) {
				const wsResponse = await this.peer.fetch(`hydra://core/download/${hash}`);
				for (let i = 0; i < wsResponse.length; i++) {
					response = wsResponse[i];
					if (response instanceof ErrorTimeout || response instanceof ErrorRequestFailed) continue;
					if (await validateHash(new TextEncoder().encode(response.body), hash)) break;
				}
			} else response = await this.peer.fetch(`hydra://core/download/${hash}`);

			if (!response) return new ErrorDownloadFailed();
			if (response instanceof Error) return response;

			const fileContent = new TextEncoder().encode(response.body);

			const ethAddress = response.headers["Ethereum-Address"];
			if (ethAddress) RPCPeers._client.filesWallet.transfer(ethAddress as EthAddress, 1_000_000n * BigInt(fileContent.byteLength));

			if (file.name === undefined || file.name === null || file.name.length === 0) {
				file.name = String(response.headers["Content-Disposition"]?.split("=")[1].replace(/"/g, "").replace(" [HYDRAFILES]", ""));
				file.save();
			}

			this.duration = Utils.createNonNegativeNumber(this.duration + Date.now() - startTime);
			this.bytes = Utils.createNonNegativeNumber(this.bytes + fileContent.byteLength);
			this.hits++;
			this.save();

			await file.cacheFile(fileContent);
			return {
				file: fileContent,
				signal: Utils.interfere(Number(response.headers["Signal-Strength"])),
			};
		} catch (e) {
			console.error(e);
			this.rejects++;

			this.save();
			throw e;
		}
	}
}

export { peerModel };
