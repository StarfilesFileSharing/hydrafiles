import { ErrorTimeout } from "../../errors.ts";
import Utils from "../../utils.ts";
import RPCClient from "../client.ts";
import { pendingRequests, sockets } from "../routes.ts";
import type { WSMessage } from "./rtc.ts";

export default class WSPeers {
	private _rpcClient: RPCClient;

	constructor(rpcClient: RPCClient) {
		this._rpcClient = rpcClient;
	}

	public fetch(input: RequestInfo, init?: RequestInit): Promise<Response | ErrorTimeout>[] {
		const req = typeof input === "string" ? new Request(input, init) : input;

		if (!sockets.length) return [];

		const requestId = Math.random();
		const { method, url, headers } = req;
		const headersObj: Record<string, string> = {};
		headers.forEach((value, key) => headersObj[key] = value);
		const request: WSMessage = { request: { method, url, headers: headersObj, body: req.method === "GET" ? null : req.body }, id: requestId, from: this._rpcClient.rtc.peerId };

		const responses = sockets.map(async (socket) => {
			return await Utils.promiseWithTimeout(
				new Promise<Response>((resolve) => {
					pendingRequests.set(requestId, resolve);
					if (socket.socket.readyState === 1) socket.socket.send(JSON.stringify(request));
				}),
				RPCClient._client.config.timeout,
			);
		});

		return responses;
	}
}
