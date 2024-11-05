import type Hydrafiles from "../hydrafiles.ts";
import HTTPPeers from "./peers/http.ts";
import RTCPeers from "./peers/rtc.ts";

export default class RPCClient {
	_client: Hydrafiles;
	http!: HTTPPeers;
	rtc!: RTCPeers;

	private constructor(client: Hydrafiles) {
		this._client = client;
	}
	static async init(client: Hydrafiles): Promise<RPCClient> {
		const rpcClient = new RPCClient(client);
		rpcClient.http = await HTTPPeers.init(rpcClient);
		rpcClient.rtc = await RTCPeers.init(rpcClient);
		return rpcClient;
	}

	public async fetch(input: RequestInfo, init?: RequestInit): Promise<Promise<Response | false>[]> {
		return [...await this.http.fetch(input, init), ...this.rtc.fetch(input, init)];
	}
}
