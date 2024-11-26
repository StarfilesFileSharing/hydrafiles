import { ErrorTimeout } from "../../errors.ts";
import Utils from "../../utils.ts";
import RPCClient from "../client.ts";
import { DecodedResponse, pendingWSRequests } from "../routes.ts";
import type { WSMessage } from "./rtc.ts";

export default class WSPeers {
	private _rpcClient: RPCClient;
	peers: { id: string; socket: WebSocket }[] = [{ id: RPCClient._client.rtcWallet.account.address, socket: new WebSocket("wss://rooms.deno.dev/") }];
	messageQueue: WSMessage[] = [];

	constructor(rpcClient: RPCClient) {
		this._rpcClient = rpcClient;

		const peers = rpcClient.http.getPeers(true);
		for (let i = 0; i < peers.length; i++) {
			this.peers.push({ id: RPCClient._client.rtcWallet.account.address, socket: new WebSocket(peers[i].host.replace("https://", "wss://").replace("http://", "ws://")) });
		}
	}

	send(message: WSMessage): void {
		this.messageQueue.push(message);
		for (let i = 0; i < this.peers.length; i++) {
			if (this.peers[i].socket.readyState === 1) this.peers[i].socket.send(JSON.stringify(message));
			else {
				this.peers[i].socket.addEventListener("open", () => {
					this.peers[i].socket.send(JSON.stringify(message));
				});
			}
		}
	}

	public fetch(url: URL, method = "GET", headers: { [key: string]: string } = {}, body: string | undefined = undefined): Promise<DecodedResponse | ErrorTimeout>[] {
		if (!this.peers.length) return [];

		url.protocol = "wss:";
		url.hostname = "0.0.0.0";
		const requestId = Math.random();
		const request: WSMessage = { request: { method, url: url.toString(), headers, body: method === "GET" ? undefined : body }, id: requestId, from: this._rpcClient.rtc.peerId };

		const responses = this.peers.map(async (socket) => {
			return await Utils.promiseWithTimeout(
				new Promise<DecodedResponse>((resolve) => {
					pendingWSRequests.set(requestId, resolve);
					if (socket.socket.readyState === 1) socket.socket.send(JSON.stringify(request));
				}),
				RPCClient._client.config.timeout,
			);
		});

		return responses;
	}

	handleConnection(req: Request): Response {
		const { socket, response } = Deno.upgradeWebSocket(req);
		this.peers.push({ socket, id: "" });

		socket.addEventListener("message", ({ data }) => {
			const message = JSON.parse(data) as WSMessage | null;
			if (message === null) return;
			if ("response" in message) {
				const resolve = pendingWSRequests.get(message.id);
				if (resolve) {
					const { status, headers, body } = message.response;
					resolve(new DecodedResponse(body, { status, headers }));
					pendingWSRequests.delete(message.id);
				}
			}
			for (let i = 0; i < this.peers.length; i++) {
				if (this.peers[i].socket !== socket && (!("to" in message) || message.to === this.peers[i].id)) {
					if (this.peers[i].socket.readyState === 1) this.peers[i].socket.send(data);
				} else if ("from" in message) {
					this.peers[i].id = message.from;
				}
			}
		});

		(response as Response & { ws: true }).ws = true;
		return response as Response & { ws: true };
	}
}
