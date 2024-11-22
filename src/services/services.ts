import type Hydrafiles from "../hydrafiles.ts";
import { ErrorNotFound, ErrorRequestFailed } from "../hydrafiles.ts";
import type { EthAddress } from "../wallet.ts";
import Wallet from "../wallet.ts";
import { decodeBase32, encodeBase32 } from "https://deno.land/std@0.224.0/encoding/base32.ts";
import Service from "./service.ts";

export interface CachedResponse {
	body: string;
	headers: Headers;
	timestamp: number;
}

export interface ServiceMetadata {
	name: string;
	description: string;
	categories: string[];
	keywords: string[];
}

export default class Services {
	/** @internal */
	static _client: Hydrafiles;
	public ownedServices: { [hostname: string]: Service } = {};
	public knownServices: { [hostname: string]: ServiceMetadata } = {};
	public processingRequests = new Map<string, Promise<Response | ErrorNotFound>>();
	public cachedResponses: Record<string, CachedResponse> = {};

	public addHostname(requestHandler: (req: Request) => Promise<Response> | Response, seed = 0): string {
		const wallet = new Wallet(100 + seed);
		const api = new Service(wallet, requestHandler);
		const hostname = encodeBase32(new TextEncoder().encode(wallet.address())).toUpperCase();
		this.ownedServices[hostname] = api;
		return hostname;
	}

	public async fetch(req: Request, headers: Headers): Promise<Response> { // TODO: Refactor this
		const now = Date.now();
		const url = new URL(req.url);
		const hostname = url.pathname.split("/")[2].toUpperCase();
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
				return new Response(this.cachedResponses[reqKey].body, { headers: this.cachedResponses[reqKey].headers });
			}

			const responses = Services._client.rpcClient.fetch(req.url);

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
				} else {
					console.log(err.message);
					throw err;
				}
			} finally {
				this.processingRequests.delete(hostname);
			}

			if (response instanceof ErrorRequestFailed) throw response;

			console.log(`Hostname: ${hostname} Mirroring response`);
			const res = { body: await response.text(), headers: response.headers };
			this.cachedResponses[reqKey] = { ...res, timestamp: Date.now() };
			return new Response(res.body, { headers: res.headers });
		}
	}
}
