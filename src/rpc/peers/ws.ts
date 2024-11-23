import { ErrorTimeout } from "../../errors.ts";
import Utils from "../../utils.ts";
import RPCClient from "../client.ts";
import { DecodedResponse, pendingWSRequests, sockets } from "../routes.ts";
import type { WSMessage } from "./rtc.ts";

export default class WSPeers {
	private _rpcClient: RPCClient;

	constructor(rpcClient: RPCClient) {
		this._rpcClient = rpcClient;
	}

	public fetch(url: URL, method = "GET", headers: { [key: string]: string } = {}, body: string | undefined = undefined): Promise<DecodedResponse | ErrorTimeout>[] {
		if (!sockets.length) return [];

		const requestId = Math.random();
		const request: WSMessage = { request: { method, url: url.toString(), headers, body: method === "GET" ? undefined : body }, id: requestId, from: this._rpcClient.rtc.peerId };

		const responses = sockets.map(async (socket) => {
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
}
