import type Hydrafiles from "../hydrafiles.ts";
import HTTPPeers from "./peers/http.ts";
import RTCPeers from "./peers/rtc.ts";
import WSPeers from "./peers/ws.ts";

export default class RPCClient {
	_client: Hydrafiles;
	http!: HTTPPeers;
	rtc!: RTCPeers;
	ws!: WSPeers;

	private constructor(client: Hydrafiles) {
		this._client = client;
	}
	static async init(client: Hydrafiles): Promise<RPCClient> {
		const rpcClient = new RPCClient(client);
		rpcClient.http = await HTTPPeers.init(rpcClient);
		rpcClient.rtc = new RTCPeers(rpcClient);
		rpcClient.ws = new WSPeers(client);
		return rpcClient;
	}

	public fetch(input: RequestInfo, init?: RequestInit): Promise<Response | false>[] {
		return [...this.http.fetch(input, init), ...this.rtc.fetch(input, init), ...this.ws.fetch(input, init)];
	}
}
