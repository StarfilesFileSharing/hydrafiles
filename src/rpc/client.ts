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
		rpcClient.rtc = new RTCPeers(rpcClient);
		return rpcClient;
	}

	public fetch(input: RequestInfo, init?: RequestInit): Promise<Response | false>[] {
		return [...this.http.fetch(input, init), ...this.rtc.fetch(input, init)];
	}
}
