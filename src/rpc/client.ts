import { ErrorRequestFailed, ErrorTimeout } from "../errors.ts";
import type Hydrafiles from "../hydrafiles.ts";
import HTTPPeers from "./peers/http.ts";
import RTCPeers from "./peers/rtc.ts";
import WSPeers from "./peers/ws.ts";

export default class RPCClient {
	static _client: Hydrafiles;
	http!: HTTPPeers;
	rtc!: RTCPeers;
	ws!: WSPeers;

	private constructor() {}

	static async init(): Promise<RPCClient> {
		const rpcClient = new RPCClient();
		rpcClient.http = await HTTPPeers.init(rpcClient);
		rpcClient.rtc = new RTCPeers(rpcClient);
		rpcClient.ws = new WSPeers(rpcClient);
		return rpcClient;
	}

	public fetch(input: RequestInfo, init?: RequestInit): Promise<Response | ErrorRequestFailed | ErrorTimeout>[] {
		return [...this.http.fetch(input, init), ...this.rtc.fetch(input, init), ...this.ws.fetch(input, init)];
	}
}
