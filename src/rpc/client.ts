import { ErrorRequestFailed, ErrorTimeout } from "../errors.ts";
import type Hydrafiles from "../hydrafiles.ts";
import type Wallet from "../wallet.ts";
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
		rpcClient.http = await HTTPPeers.init();
		rpcClient.rtc = new RTCPeers(rpcClient);
		rpcClient.ws = new WSPeers(rpcClient);
		return rpcClient;
	}

	public async fetch(input: RequestInfo, init?: RequestInit | RequestInit & { wallet: Wallet }): Promise<Promise<Response | ErrorRequestFailed | ErrorTimeout>[]> {
		const url = new URL(input instanceof Request ? input.url : input);
		url.protocol = "https:";
		url.hostname = "localhost";

		const method = input instanceof Request ? input.method : "GET";
		const headers: { [key: string]: string } = {};
		let body: string | undefined;

		if (init) {
			init.headers = new Headers(init.headers);
			init.headers.forEach((value, name) => {
				headers[name] = value;
			});
			if ("wallet" in init) {
				const signature = await init.wallet.signMessage(JSON.stringify({ method, url, headers }));
				headers["hydra-signature"] = signature;
				headers["hydra-from"] = init.wallet.address();
			}
			body = init.body?.toString();
		}
		console.log(headers);

		return [...this.http.fetch(url, method, headers, body), ...this.rtc.fetch(url, method, headers, body), ...this.ws.fetch(url, method, headers, body)];
	}
}
