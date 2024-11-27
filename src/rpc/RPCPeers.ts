import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import { ErrorNotFound, type ErrorRequestFailed, type ErrorTimeout } from "../errors.ts";
import type Hydrafiles from "../hydrafiles.ts";
import type Wallet from "../wallet.ts";
import HTTPPeers from "./peers/http.ts";
import RTCPeers from "./peers/rtc.ts";
import WSPeers from "./peers/ws.ts";
import { DecodedResponse, router } from "./routes.ts";
import { serveFile } from "https://deno.land/std@0.115.0/http/file_server.ts";
import type { EthAddress } from "../wallet.ts";

type RawPayload = { url: string };
type EncryptedPayload = { payload: RawPayload | EncryptedPayload; to: EthAddress };

export default class RPCPeers {
	static _client: Hydrafiles;
	http!: HTTPPeers;
	ws!: WSPeers;
	rtc!: RTCPeers;

	private constructor() {}

	static async init(): Promise<RPCPeers> {
		const rpc = new RPCPeers();
		rpc.http = await HTTPPeers.init();
		rpc.ws = new WSPeers(rpc);
		rpc.rtc = new RTCPeers(rpc);
		return rpc;
	}

	/**
	 * Sends requests to peers.
	 */
	public fetch = async (input: RequestInfo, init?: RequestInit | RequestInit & { wallet: Wallet }): Promise<Promise<DecodedResponse | ErrorRequestFailed | ErrorTimeout>[]> => {
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

		return [...this.http.fetch(url, method, headers, body), ...this.rtc.fetch(url, method, headers, body), ...this.ws.fetch(url, method, headers, body)];
	};

	/**
	 * Handles requests locally (e.g. requeests from other peers).
	 */
	handleRequest = async (req: Request): Promise<Response> => {
		const headers: { [key: string]: string } = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "hydra-signature, hydra-from",
		};
		try {
			console.log(`RPC:      Received request ${req.url}`);
			const url = new URL(req.url);

			if ((url.pathname === "/" || url.pathname === "/docs") && req.headers.get("upgrade") !== "websocket") {
				headers["Location"] = "/docs/";
				return new Response("", { headers: headers, status: 301 });
			}

			if (typeof window === "undefined") {
				const possiblePaths = [join("public/dist/", url.pathname), join("public/", url.pathname.endsWith("/") ? join(url.pathname, "index.html") : url.pathname)];
				for (let i = 0; i < possiblePaths.length; i++) {
					try {
						const res = await serveFile(req, possiblePaths[i]);
						res.headers.append("access-control-allow-origin", "*");
						res.headers.append(
							"access-control-allow-headers",
							"Origin, X-Requested-With, Content-Type, Accept, Range, Hydra-Signature",
						);
						if (res.status === 404) continue;
						return res;
					} catch (_) {
						continue;
					}
				}
			}

			if (!RPCPeers._client.config.listen) return new Response("Peer has peering disabled");
			else {
				const routeHandler = req.headers.get("upgrade") === "websocket" ? this.ws.handleConnection : router.get(`/${url.pathname.split("/")[1]}`);
				if (routeHandler) {
					const response = await routeHandler(req, RPCPeers._client);
					if (response instanceof Response) return response;
					response.addHeaders(headers);
					return response.response();
				}
			}

			return new Response("404 Page Not Found\n", { status: 404, headers });
		} catch (e) {
			console.error(req.url, "Internal Server Error", e);
			return new Response("Internal Server Error", { status: 500, headers });
		}
	};

	public exitFetch = async (req: Request): Promise<DecodedResponse | ErrorNotFound> => {
		const relays: EthAddress[] = [];

		const handshakeResponses = await Promise.all(await this.fetch(`https://localhost/exit/request`));
		for (let i = 0; i < handshakeResponses.length; i++) {
			const response = handshakeResponses[i];
			if (response instanceof Error || response.status !== 200) continue;
			const body = response.text();
			try {
				const payload = JSON.parse(body);
				relays.push(payload.pubKey);
			} catch (_) {
				continue;
			}
		}

		const chosenRelays = relays.sort(() => Math.random() - 0.5).slice(0, 3);

		const rawPayload = {
			url: req.url,
		};

		let payload: EncryptedPayload = { payload: rawPayload, to: chosenRelays[0] };
		for (let i = 1; i < chosenRelays.length; i++) {
			payload = { payload, to: chosenRelays[i] };
		}

		console.log(`https://localhost/exit/${payload.to}`);
		const responses = await Promise.all(await this.fetch(`https://localhost/exit/${payload.to}`, { method: "POST", body: JSON.stringify(payload.payload) }));
		for (let j = 0; j < responses.length; j++) {
			const response = responses[j];
			if (response instanceof Error || response.status !== 200) continue;
			return response;
		}

		return new ErrorNotFound();
	};

	public exitHandleRequest = async (req: Request): Promise<DecodedResponse> => {
		return DecodedResponse.from(await fetch(req));
	};
}
