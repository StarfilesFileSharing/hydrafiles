import type Hydrafiles from "./hydrafiles.ts";
import { ErrorNotFound, ErrorRequestFailed } from "./hydrafiles.ts";
import type { EthAddress } from "./wallet.ts";
import Wallet from "./wallet.ts";

interface CachedResponse {
	body: string;
	headers: Headers;
	timestamp: number;
}

export class API {
	wallet: Wallet;
	requestHandler: (req: Request) => Promise<Response> | Response;

	public constructor(wallet: Wallet, requestHandler: (req: Request) => Promise<Response> | Response) {
		this.wallet = wallet;
		this.requestHandler = requestHandler;
	}

	public async fetch(req: Request, headers: Headers): Promise<Response> {
		const body = await (await this.requestHandler(req)).text();
		headers.set("hydra-signature", await APIs._client.apiWallet.signMessage(body));
		return new Response(body, { headers });
	}
}

export default class APIs {
	static _client: Hydrafiles;
	public hostnames: { [key: EthAddress]: API } = {};
	public processingRequests = new Map<string, Promise<Response | ErrorNotFound>>();
	public cachedResponses: Record<string, CachedResponse> = {};

	public addHostname(requestHandler: (req: Request) => Promise<Response> | Response, seed = 0): void {
		const wallet = new Wallet(100 + seed);
		const api = new API(wallet, requestHandler);
		this.hostnames[wallet.address()] = api;
	}

	public async fetch(req: Request, headers: Headers): Promise<Response> {
		const now = Date.now();
		const url = new URL(req.url);
		const hostname = url.pathname.split("/")[2] as EthAddress;

		if (hostname in this.hostnames) return this.hostnames[hostname].fetch(req, headers);
		else {
			if (this.processingRequests.has(hostname)) {
				if (APIs._client.config.logLevel === "verbose") console.log(`  ${hostname}  Waiting for existing request with same hostname`);
				await this.processingRequests.get(hostname);
			}
			if (hostname in this.cachedResponses) {
				const cachedEntry = this.cachedResponses[hostname];
				if (now - cachedEntry.timestamp > 60000) {
					delete this.cachedResponses[hostname];
				}
				return new Response(this.cachedResponses[hostname].body, { headers: this.cachedResponses[hostname].headers });
			}

			const responses = APIs._client.rpcClient.fetch(`http://localhost/endpoint/${hostname}`);

			const processingRequest = new Promise<Response | ErrorRequestFailed>((resolve, reject) => {
				(async () => {
					await Promise.all(responses.map(async (res) => {
						try {
							const response = await res;
							if (response instanceof Error) return response;
							const body = await response.text();
							const signature = response.headers.get("hydra-signature") as EthAddress | null;
							if (signature !== null && await APIs._client.apiWallet.verifyMessage(body, signature, hostname)) resolve(new Response(body, { headers: response.headers }));
						} catch (e) {
							const err = e as Error;
							if (err.message !== "Hostname not found") console.error(e);
						}
					}));
					reject(new Error("Hostname not found"));
				})();
			});

			this.processingRequests.set(hostname, processingRequest);

			let response: Response | ErrorRequestFailed | undefined;
			try {
				response = await processingRequest;
			} catch (e) {
				const err = e as Error;
				if (err.message === "Hostname not found") return new Response("Hostname not found", { headers, status: 404 });
				else throw err;
			} finally {
				this.processingRequests.delete(hostname);
			}

			if (response instanceof ErrorRequestFailed) throw response;

			const res = { body: await response.text(), headers: response.headers };
			this.cachedResponses[hostname] = { ...res, timestamp: Date.now() };
			return new Response(res.body, { headers: res.headers });
		}
	}
}
