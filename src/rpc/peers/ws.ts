import { ErrorTimeout } from "../../errors.ts";
import Utils from "../../utils.ts";
import { DecodedResponse, HydraResponse } from "../routes.ts";
import RPCPeers from "../RPCPeers.ts";
import type { SignallingMessage } from "./rtc.ts";

export type WSRequest = { request: { method: string; url: string; headers: Record<string, string>; body?: string } };
export type WSResponse = { response: DecodedResponse; requestHash: number };

const pendingWSRequests = new Map<number, DecodedResponse[]>();

export class WSPeer {
	private _rpcPeers: RPCPeers;
	host: string;
	socket: WebSocket;
	messageQueue: (WSRequest | WSResponse)[] = [];

	constructor(host: string, rpcPeers: RPCPeers) {
		this._rpcPeers = rpcPeers;
		this.host = host;
		this.socket = new WebSocket(this.host.replace("https://", "wss://").replace("http://", "ws://"));

		this.socket.addEventListener("message", this.handleMessage);
	}

	public async fetch(url: URL, method = "GET", headers: { [key: string]: string } = {}, body: string | undefined = undefined): Promise<Array<DecodedResponse | ErrorTimeout>> {
		url.protocol = "wssr:";
		url.hostname = "0.0.0.0";
		const request: WSRequest = { request: { method, url: url.toString(), headers, body: method === "GET" ? undefined : body } };
		const message = JSON.stringify(request);

		const hash = Utils.encodeBase10(new TextDecoder().decode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message))));

		pendingWSRequests.set(hash, []);

		const responses = new Promise<DecodedResponse[]>((resolve) => {
			setTimeout(() => {
				const collected = pendingWSRequests.get(hash) || [];
				pendingWSRequests.delete(hash);
				resolve(collected);
			}, RPCPeers._client.config.timeout);

			if (this.socket.readyState === 1) this.socket.send(message);
		});

		return responses;
	}

	async handleMessage({ data }: { data: string }): Promise<void> {
		const message = JSON.parse(data) as WSRequest | WSResponse | null;
		if (message === null) return;

		this._rpcPeers.ws.send(message);

		if ("request" in message) {
			const requestHash = Utils.encodeBase10(new TextDecoder().decode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(message)))));
			const response = await RPCPeers._client.rpcPeers.handleRequest(new Request(message.request.url, { body: message.request.body, headers: message.request.headers, method: message.request.method }));
			const headersObj: Record<string, string> = {};
			response.headers.forEach((value, key) => headersObj[key] = value);
			const responseMessage: WSResponse = { requestHash, response: (await HydraResponse.from(response)).toDecodedResponse() };
			this._rpcPeers.ws.send(responseMessage);
		} else if ("response" in message) {
			const responseList = pendingWSRequests.get(message.requestHash);
			if (responseList) {
				responseList.push(message.response);
			}
		}
	}

	send(message: WSRequest | WSResponse): void {
		if (this.socket.readyState === 1) this.socket.send(JSON.stringify(message));
		else this.socket.addEventListener("open", () => this.socket.send(JSON.stringify(message)));
	}
}

export default class WSPeers {
	peers: { id: string; socket: WebSocket }[] = [{ id: RPCPeers._client.rtcWallet.account.address, socket: new WebSocket("wss://rooms.deno.dev/") }];

	constructor(rpcPeer: RPCPeers) {
		const peers = rpcPeer.getPeers(true);
		for (let i = 0; i < peers.length; i++) {
			this.peers.push({ id: RPCPeers._client.rtcWallet.account.address, socket: new WebSocket(peers[i].host.replace("https://", "wss://").replace("http://", "ws://")) });
		}
	}

	handleConnection(req: Request): Response {
		const { socket, response } = Deno.upgradeWebSocket(req);
		this.peers.push({ socket, id: "" });

		(response as Response & { ws: true }).ws = true;
		return response as Response & { ws: true };
	}

	send(message: WSRequest | WSResponse | SignallingMessage): void {
		for (let i = 0; i < this.peers.length; i++) {
			this.peers[i].socket.send(JSON.stringify(message));
			if ("from" in message) this.peers[i].id = message.from;
		}
	}
}
