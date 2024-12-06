import { encodeBase32 } from "https://deno.land/std@0.224.0/encoding/base32.ts";
import { ErrorTimeout } from "../../errors.ts";
import { DecodedResponse, HydraResponse } from "../routes.ts";
import RPCPeers from "../RPCPeers.ts";
import type { SignallingMessage } from "./rtc.ts";

export type WSRequest = { request: { method: string; url: string; headers: Record<string, string>; body?: string } };
export type WSResponse = { response: DecodedResponse; requestHash: string };

const pendingWSRequests = new Map<string, DecodedResponse[]>();

export class WSPeer {
	host: string;
	socket: WebSocket;
	messageQueue: (WSRequest | WSResponse)[] = [];

	constructor(host: string, socket?: WebSocket) {
		console.log("WS:       Adding Peer", host);
		this.host = host;
		this.socket = socket ?? new WebSocket(this.host.replace("https://", "wss://").replace("http://", "ws://") + "?address=" + RPCPeers._client.rtcWallet.address());

		for (let i = 0; i < WSPeers._rpcPeers.ws.onopens.length; i++) this.socket.addEventListener("open", WSPeers._rpcPeers.ws.onopens[i]);

		this.socket.addEventListener("message", (data) => {
			this.handleMessage(data);
		});

		console.log(`WebRTC:   Announcing`);
		this.send({ announce: true, from: RPCPeers._client.rtcWallet.address() });
		setInterval(() => this.send({ announce: true, from: RPCPeers._client.rtcWallet.address() }), RPCPeers._client.config.announceSpeed);
	}

	public async fetch(url: `hydra://core/${string}`, method = "GET", headers: { [key: string]: string } = {}, body: string | undefined = undefined): Promise<Array<DecodedResponse | ErrorTimeout>> {
		console.log(`WS:       Fetching ${url} from ${this.host}`);
		const request: WSRequest = { request: { method, url: url.toString(), headers, body: method === "GET" ? undefined : body } };
		const message = JSON.stringify(request);

		const hash = encodeBase32(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message))));

		pendingWSRequests.set(hash, []);

		const responses = await new Promise<DecodedResponse[]>((resolve) => {
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

		const t = Math.ceil(+new Date() / RPCPeers._client.config.wsMessageCacheTime);
		if (WSPeers.seenMessages.has(t + data)) return;
		WSPeers.seenMessages.add(t + data);

		if ("request" in message) {
			const requestHash = encodeBase32(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(message)))));
			const response = await WSPeers._rpcPeers.handleRequest(new Request(message.request.url, { body: message.request.body, headers: message.request.headers, method: message.request.method }));
			const headersObj: Record<string, string> = {};
			response.headers.forEach((value, key) => headersObj[key] = value);
			const responseMessage: WSResponse = { requestHash, response: (await HydraResponse.from(response)).toDecodedResponse() };
			WSPeers._rpcPeers.ws.send(responseMessage);
		} else if ("response" in message) {
			const responseList = pendingWSRequests.get(message.requestHash);
			if (responseList) {
				responseList.push(message.response);
				pendingWSRequests.set(message.requestHash, responseList);
			}
		}

		for (let i = 0; i < WSPeers._rpcPeers.ws.onmessages.length; i++) WSPeers._rpcPeers.ws.onmessages[i](new MessageEvent("message", { data }));
	}

	send(message: WSRequest | WSResponse | SignallingMessage): void {
		if ("to" in message && message.to === `rtc://${RPCPeers._client.rtcWallet.address()}.hydra`) return;
		if (this.socket.readyState === 1) this.socket.send(JSON.stringify(message));
		else this.socket.addEventListener("open", () => this.socket.send(JSON.stringify(message)));
	}
}

export default class WSPeers {
	static _rpcPeers: RPCPeers;
	static seenMessages: Set<string> = new Set();
	onopens: Array<() => void> = [];
	onmessages: Array<(event: MessageEvent) => void> = [];

	handleConnection(req: Request): Response {
		const { socket, response } = Deno.upgradeWebSocket(req);
		WSPeers._rpcPeers.add({ host: `wsc://${new URL(req.url).searchParams.get("address")}`, socket });

		(response as Response & { ws: true }).ws = true;
		return response as Response & { ws: true };
	}

	send(message: WSRequest | WSResponse | SignallingMessage): void {
		const peers = Array.from(WSPeers._rpcPeers.peers.entries());
		for (let i = 0; i < peers.length; i++) {
			const peer = peers[i][1].peer;
			if (peer instanceof WSPeer) peer.send(message);
		}
	}

	onopen(callback: () => void): void {
		console.log("onopen", callback);
		const peers = Array.from(WSPeers._rpcPeers.peers);
		for (let i = 0; i < peers.length; i++) {
			const peer = peers[i][1].peer;
			if (peer instanceof WSPeer) peer.socket.addEventListener("open", callback);
		}
		this.onopens.push(callback);
	}

	onmessage(callback: (event: MessageEvent) => void): void {
		const peers = Array.from(WSPeers._rpcPeers.peers);
		for (let i = 0; i < peers.length; i++) {
			const peer = peers[i][1].peer;
			if (peer instanceof WSPeer) peer.socket.addEventListener("message", callback);
		}
		this.onmessages.push(callback);
	}
}
