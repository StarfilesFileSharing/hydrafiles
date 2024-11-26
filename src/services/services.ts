import { DecodedResponse } from "./../rpc/routes.ts";
import type Hydrafiles from "../hydrafiles.ts";
import { ErrorNotFound, ErrorRequestFailed } from "../errors.ts";
import type { EthAddress } from "../wallet.ts";
import Wallet from "../wallet.ts";
import { decodeBase32, encodeBase32 } from "https://deno.land/std@0.224.0/encoding/base32.ts";
import Service from "./service.ts";

export interface CachedResponse {
	timestamp: number;
	body: string | Uint8Array;
	headers: { [key: string]: string };
	status: number;
	ok: boolean;
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
	public processingRequests = new Map<string, Promise<DecodedResponse | ErrorNotFound>>();
	public cachedResponses: Record<string, CachedResponse> = {};

	private filterHydraHeaders(headers: { [key: string]: string }): { [key: string]: string } {
		for (const key in Object.keys(headers)) {
			if (!key.toLowerCase().startsWith("hydra-")) delete headers[key];
		}
		return headers;
	}

	public addHostname(requestHandler: (req: Request) => Promise<Response> | Response, seed: number): string {
		const wallet = new Wallet(1000 + seed);
		const api = new Service(wallet, requestHandler);
		const hostname = encodeBase32(wallet.address()).toUpperCase();
		console.log(`Hostname: ${hostname} added`);
		this.ownedServices[hostname] = api;
		return hostname;
	}

	public async fetch(req: Request): Promise<DecodedResponse> { // TODO: Refactor this
		const now = Date.now();
		const url = new URL(req.url);
		const hostname = encodeBase32(url.pathname.split("/")[2]).toUpperCase();
		console.log(`Hostname: ${hostname} Received Request`);

		if (hostname in this.ownedServices) {
			console.log(`Hostname: ${hostname} Serving response`);
			return this.ownedServices[hostname].fetch(req);
		}

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
			return new DecodedResponse(this.cachedResponses[reqKey].body, { headers: this.filterHydraHeaders(this.cachedResponses[reqKey].headers) });
		}

		const headersObj: { [key: string]: string } = {};
		req.headers.forEach((value, key) => {
			headersObj[key] = value;
		});
		const responses = await Services._client.rpcClient.fetch(req.url, { headers: this.filterHydraHeaders(headersObj) });

		const processingRequest = new Promise<DecodedResponse | ErrorRequestFailed>((resolve, reject) => {
			(async () => {
				await Promise.all(responses.map(async (res) => {
					try {
						const response = await res;
						if (response instanceof Error) return response;
						if (!response.ok) return;
						const signature = response.headers["hydra-signature"] as EthAddress | null;
						if (
							signature !== null &&
							await Services._client.filesWallet.verifyMessage(typeof response.body === "string" ? response.body : new TextDecoder().decode(response.body), signature, new TextDecoder().decode(decodeBase32(hostname)) as EthAddress)
						) {
							response.headers = this.filterHydraHeaders(response.headers);
							resolve(response);
						}
					} catch (e) {
						if (e instanceof ErrorNotFound) console.error(e);
						throw e;
					}
				}));
				reject(new ErrorNotFound());
			})();
		});

		this.processingRequests.set(hostname, processingRequest);

		let response: DecodedResponse | ErrorRequestFailed | undefined;
		try {
			response = await processingRequest;
		} catch (e) {
			const err = e as Error;
			if (err.message === "Hostname not found") {
				console.log(`Hostname: ${hostname} Not found`);
				const headersObj: { [key: string]: string } = {};
				req.headers.forEach((value, key) => {
					headersObj[key] = value;
				});
				return new DecodedResponse("Hostname not found", { headers: headersObj, status: 404 });
			} else {
				console.log(err.message);
				throw err;
			}
		} finally {
			this.processingRequests.delete(hostname);
		}

		if (response instanceof ErrorRequestFailed) throw response;

		console.log(`Hostname: ${hostname} Mirroring response`);
		const res = new DecodedResponse(response.body, this.filterHydraHeaders(response.headers));
		this.cachedResponses[reqKey] = { ...res, timestamp: Date.now() };
		return res;
	}
}
