import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import { ErrorNotFound, ErrorTimeout } from "../errors.ts";
import type Hydrafiles from "../hydrafiles.ts";
import type Wallet from "../wallet.ts";
import HTTPServer, { HTTPClient } from "./peers/http.ts";
import RTCPeers, { RTCPeer } from "./peers/rtc.ts";
import WSPeers, { WSPeer } from "./peers/ws.ts";
import { type DecodedResponse, HydraResponse, router } from "./routes.ts";
import { serveFile } from "https://deno.land/std@0.115.0/http/file_server.ts";
import type { EthAddress } from "../wallet.ts";
import Database, { type DatabaseModal } from "../database.ts";
import Utils from "../utils.ts";
import RPCPeer, { type Host, type PeerAttributes, peerModel } from "./RPCPeer.ts";

type RawPayload = { url: string };
type EncryptedPayload = { payload: RawPayload | EncryptedPayload; to: EthAddress };
type CoreRequest = `hydra://core/${"peers" | "file" | "files" | "blocks" | "exit" | "announce" | "service"}${string}`;

export default class RPCPeers {
	static _client: Hydrafiles;
	static db: Database<typeof peerModel>;

	peers = new Map<Host, RPCPeer>();

	http: HTTPServer;
	ws: WSPeers;
	rtc: RTCPeers;

	private constructor(wallet: Wallet) {
		this.http = new HTTPServer(this);
		WSPeers._rpcPeers = this;
		this.ws = new WSPeers();
		RTCPeers._rpcPeers = this;
		this.rtc = new RTCPeers(wallet);
	}

	static init = async () => {
		RPCPeers.db = await Database.init(peerModel, RPCPeers._client);
		const peers = new RPCPeers(RPCPeers._client.rtcWallet);

		const peerValues = await RPCPeers.db.select() as unknown as (DatabaseModal<typeof peerModel> & { host: Host })[];
		for (let i = 0; i < peerValues.length; i++) {
			if (peerValues[i].host.startsWith("hydra:") || peerValues[i].host.startsWith("wsc:")) continue;
			await peers.add(peerValues[i]);
		}

		for (let i = 0; i < RPCPeers._client.config.bootstrapPeers.length; i++) peers.add({ host: RPCPeers._client.config.bootstrapPeers[i] });
		for (let i = 0; i < RPCPeers._client.config.customPeers.length; i++) peers.add({ host: RPCPeers._client.config.customPeers[i] });

		peers.add({ host: "wss://rooms.deno.dev/" });

		return peers;
	};

	public add = async (values: Partial<DatabaseModal<typeof peerModel>> & ({ host: Host; socket?: WebSocket })): Promise<[RPCPeer] | [RPCPeer, RPCPeer]> => {
		const peers = [];

		const savedPeer = this.peers.get(values.host);
		if (savedPeer) return [savedPeer];

		console.log("RPC:      Adding peer", values.host);
		const peer = await RPCPeer.init(values);
		if (!(peer instanceof Error)) {
			this.peers.set(values.host, peer);
			peers.push(peer);
		}

		if (values.host.startsWith("http:") || values.host.startsWith("https:")) {
			const host = values.host.replace("http", "ws") as Host;
			console.log("RPC:      Adding peer", host);
			const wsPeer = await RPCPeer.init({ ...values, host });
			if (!(wsPeer instanceof Error)) {
				this.peers.set(host, wsPeer);
				peers.push(wsPeer);
			}
		}

		return peers as [RPCPeer] | [RPCPeer, RPCPeer];
	};

	public getPeers = (applicablePeers = false): RPCPeer[] => {
		const peers = Array.from(this.peers).filter((peer) => !applicablePeers || typeof window === "undefined" || !peer[0].startsWith("http://"));

		if (RPCPeers._client.config.preferNode === "FASTEST") return peers.map(([_, peer]) => peer).sort((a, b) => a.bytes / a.duration - b.bytes / b.duration);
		else if (RPCPeers._client.config.preferNode === "LEAST_USED") return peers.map(([_, peer]) => peer).sort((a, b) => a.hits - a.rejects - (b.hits - b.rejects));
		else if (RPCPeers._client.config.preferNode === "HIGHEST_HITRATE") return peers.sort((a, b) => a[1].hits - a[1].rejects - (b[1].hits - b[1].rejects)).map(([_, peer]) => peer);
		else return peers.map(([_, peer]) => peer);
	};

	// TODO: Compare list between all peers and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
	async discoverPeers(): Promise<void> {
		console.log(`RPC:      Discovering peers`);
		const responses = await Promise.all(await RPCPeers._client.rpcPeers.fetch("hydra://core/peers"));
		for (let i = 0; i < responses.length; i++) {
			try {
				if (!(responses[i] instanceof Response)) continue;
				const response = responses[i];
				if (response instanceof Response) {
					const remotePeers = (await response.json()) as PeerAttributes[];
					for (const remotePeer of remotePeers) {
						if (Utils.isPrivateIP(remotePeer.host) || remotePeer.host.startsWith("https://")) continue;
						this.add(remotePeer).catch((e) => {
							if (RPCPeers._client.config.logLevel === "verbose") console.error(e);
						});
					}
				}
			} catch (e) {
				if (RPCPeers._client.config.logLevel === "verbose") console.error(e);
			}
		}
	}

	/**
	 * Sends requests to peers.
	 */
	public fetch = async (url: CoreRequest, init?: RequestInit | RequestInit & { wallet: Wallet }): Promise<DecodedResponse[]> => {
		console.log(`RPC:      Fetching ${url.toString()}`);

		const method = init?.method;
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

		let responses: DecodedResponse[] = [];
		const peerEntries = Array.from(this.peers.entries());
		const promises = peerEntries.map(async ([_, peer]) => {
			try {
				let peerResponses: DecodedResponse[] = [];

				if (peer.peer instanceof WSPeer) {
					const wsResponses = await peer.peer.fetch(url, method, headers, body);
					peerResponses = wsResponses.filter((r): r is DecodedResponse => !(r instanceof ErrorTimeout));
				} else if (peer.peer instanceof HTTPClient) {
					const response = await peer.peer.fetch(url, { method, headers, body });
					if (!(response instanceof Error)) peerResponses = [response];
				} else if (peer.peer instanceof RTCPeer) {
					const response = await peer.peer.fetch(url, method, headers, body);
					if (!(response instanceof Error)) peerResponses = [response];
				}

				return peerResponses;
			} catch (e) {
				console.error(e);
				return [];
			}
		});
		const results = await Promise.all(promises);
		responses = responses.concat(...results);

		console.log(`RPC:      Fetched ${responses.length} responses for ${url.toString()}`);
		return responses;
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

			if (req.headers.get("Connection") !== "Upgrade") {
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

		const handshakeResponses = await Promise.all(await this.fetch(`hydra://core/exit/request`));
		for (let i = 0; i < handshakeResponses.length; i++) {
			const response = handshakeResponses[i];
			if (response instanceof Error || response.status !== 200) continue;
			const body = response.body;
			try {
				const payload = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
				relays.push(payload.pubKey);
			} catch (_) {
				continue;
			}
		}

		const chosenRelays = relays.sort(() => Math.random() - 0.5).slice(0, 3);
		const rawPayload = { url: req.url };

		let payload: EncryptedPayload = { payload: rawPayload, to: chosenRelays[0] };
		for (let i = 1; i < chosenRelays.length; i++) {
			payload = { payload, to: chosenRelays[i] };
		}

		const responses = await Promise.all(await this.fetch(`hydra://core/exit/${payload.to}`, { method: "POST", body: JSON.stringify(payload.payload) }));
		for (let j = 0; j < responses.length; j++) {
			const response = responses[j];
			if (response instanceof Error || response.status !== 200) continue;
			return response;
		}

		throw new ErrorNotFound();
	};

	public exitHandleRequest = async (req: Request): Promise<HydraResponse> => {
		return HydraResponse.from(await fetch(req));
	};
}
