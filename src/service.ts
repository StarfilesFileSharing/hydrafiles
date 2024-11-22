import type Hydrafiles from "./hydrafiles.ts";
import { ErrorNotFound, ErrorRequestFailed } from "./hydrafiles.ts";
import type { EthAddress } from "./wallet.ts";
import Wallet from "./wallet.ts";
import { decodeBase32, encodeBase32 } from "https://deno.land/std@0.224.0/encoding/base32.ts";

interface CachedResponse {
	body: string;
	headers: Headers;
	timestamp: number;
}

interface ServiceMetadata {
	name: string;
	description: string;
	categories: string[];
	keywords: string[];
}

export class Service {
	wallet: Wallet;
	requestHandler: (req: Request) => Promise<Response> | Response;

	public constructor(wallet: Wallet, requestHandler: (req: Request) => Promise<Response> | Response) {
		this.wallet = wallet;
		this.requestHandler = requestHandler;
	}

	public async fetch(req: Request, headers: Headers): Promise<Response> {
		const body = await (await this.requestHandler(req)).text();
		headers.set("hydra-signature", await this.wallet.signMessage(body));
		return new Response(body, { headers });
	}
}

export default class Services {
	static _client: Hydrafiles;
	public ownedServices: { [hostname: string]: Service } = {};
	public knownServices: { [hostname: string]: ServiceMetadata } = {};
	public processingRequests = new Map<string, Promise<Response | ErrorNotFound>>();
	public cachedResponses: Record<string, CachedResponse> = {};

	public addHostname(requestHandler: (req: Request) => Promise<Response> | Response, seed = 0): void {
		const wallet = new Wallet(100 + seed);
		const api = new Service(wallet, requestHandler);
		this.ownedServices[encodeBase32(new TextEncoder().encode(wallet.address())).toUpperCase()] = api;
	}

	public async fetch(req: Request, headers: Headers): Promise<Response> { // TODO: Refactor this
		const now = Date.now();
		const url = new URL(req.url);
		const hostname = url.hostname.toUpperCase();
		console.log(`Hostname: ${hostname} Received Request`);

		if (hostname in this.ownedServices) {
			console.log(`Hostname: ${hostname} Serving response`);
			return this.ownedServices[hostname].fetch(req, headers);
		} else {
			if (this.processingRequests.has(hostname)) {
				if (Services._client.config.logLevel === "verbose") console.log(`  ${hostname}  Waiting for existing request with same hostname`);
				await this.processingRequests.get(hostname);
			}
			const reqKey = req.url;
			if (reqKey in this.cachedResponses) {
				const cachedEntry = this.cachedResponses[reqKey];
				if (now - cachedEntry.timestamp > 60000) {
					delete this.cachedResponses[reqKey];
				}
				console.log(`Hostname: ${hostname} Serving response from cache`);
				return new Response(this.cachedResponses[req.url].body, { headers: this.cachedResponses[req.url].headers });
			}

			const responses = Services._client.rpcClient.fetch(`http://localhost/endpoint/${url.hostname}`);

			const processingRequest = new Promise<Response | ErrorRequestFailed>((resolve, reject) => {
				(async () => {
					await Promise.all(responses.map(async (res) => {
						try {
							const response = await res;
							if (response instanceof Error) return response;
							if (!response.ok) return;
							const body = await response.text();
							const signature = response.headers.get("hydra-signature") as EthAddress | null;
							if (signature !== null && await Services._client.filesWallet.verifyMessage(body, signature, new TextDecoder().decode(decodeBase32(hostname)) as EthAddress)) resolve(new Response(body, { headers: response.headers }));
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
				if (err.message === "Hostname not found") {
					console.log(`Hostname: ${hostname} Not found`);
					return new Response("Hostname not found", { headers, status: 404 });
				} else throw err;
			} finally {
				this.processingRequests.delete(hostname);
			}

			if (response instanceof ErrorRequestFailed) throw response;

			console.log(`Hostname: ${hostname} Mirroring response`);
			const res = { body: await response.text(), headers: response.headers };
			this.cachedResponses[hostname] = { ...res, timestamp: Date.now() };
			return new Response(res.body, { headers: res.headers });
		}
	}
}
