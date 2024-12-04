import { type DecodedResponse, HydraResponse } from "./../rpc/routes.ts";
import type Hydrafiles from "../hydrafiles.ts";
import { ErrorNotFound, ErrorRequestFailed } from "../errors.ts";
import type { EthAddress } from "../wallet.ts";
import Wallet from "../wallet.ts";
import { decodeBase32, encodeBase32 } from "https://deno.land/std@0.224.0/encoding/base32.ts";
import Service from "./service.ts";

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
	public cachedResponses: Record<string, HydraResponse> = {};

	private filterHydraHeaders(headers: { [key: string]: string } = {}): { [key: string]: string } {
		for (const key in Object.keys(headers)) {
			if (!key.toLowerCase().startsWith("hydra-")) delete headers[key];
		}
		return headers;
	}

	public addHostname(requestHandler: (req: Request) => Promise<Response> | Response, seed: number): EthAddress {
		const wallet = new Wallet(1000 + seed);
		const api = new Service(wallet, requestHandler);
		const encodedHostname = encodeBase32(wallet.address()).toUpperCase();
		console.log(`Service:  ${wallet.address()} added`);
		this.ownedServices[encodedHostname] = api;
		return wallet.address();
	}

	public async fetch(req: Request): Promise<HydraResponse> { // TODO: Refactor this
		const now = Date.now();
		const url = new URL(req.url);
		const hostname = url.pathname.split("/")[2];
		const encodedHostname = encodeBase32(hostname).toUpperCase();
		console.log(`Service:  ${hostname} Received Request`);

		if (encodedHostname in this.ownedServices) {
			console.log(`Service:  ${hostname} Serving response`);
			return this.ownedServices[encodedHostname].fetch(req);
		}

		if (this.processingRequests.has(encodedHostname)) {
			console.log(`Service:  ${hostname} Waiting for existing request with same hostname`);
			await this.processingRequests.get(encodedHostname);
		}
		const reqKey = req.url;
		if (reqKey in this.cachedResponses) {
			const cachedEntry = this.cachedResponses[reqKey];
			if (now - (cachedEntry.timestamp ?? 0) > 60000) {
				delete this.cachedResponses[reqKey];
			}
			console.log(`Service:  ${hostname} Serving response from cache`);
			return cachedEntry;
		}

		const headersObj: { [key: string]: string } = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "hydra-signature, hydra-from",
		};
		req.headers.forEach((value, key) => {
			headersObj[key] = value;
		});

		console.log(`Service:  ${hostname} Fetching response from peers`);
		const responses = await Services._client.rpcPeers.fetch(`hydra://core${url.pathname}${url.search}` as `hydra://core/service/${EthAddress}`, { headers: this.filterHydraHeaders(headersObj) });

		const processingRequest = new Promise<DecodedResponse | ErrorRequestFailed | ErrorNotFound>((resolve, _rej) => {
			(async () => {
				await Promise.all(responses.map((response) => {
					try {
						if (response instanceof Error) return response;
						if (!response.ok) return;
						const signature = response.headers["hydra-signature"] as EthAddress | null;
						console.log(response, new TextDecoder().decode(decodeBase32(encodedHostname)) as EthAddress, signature);
						// if ( // TODO: figure out why this is false
						// 	signature !== null &&
						// 	await Services._client.filesWallet.verifyMessage(typeof response.body === "string" ? response.body : new TextDecoder().decode(response.body), signature, new TextDecoder().decode(decodeBase32(encodedHostname)) as EthAddress)
						// ) {
						response.headers = this.filterHydraHeaders(response.headers);
						resolve(response);
						// } else console.warn("Inval");
					} catch (e) {
						if (e instanceof ErrorNotFound) console.error(e);
						throw e;
					}
				}));
				resolve(new ErrorNotFound());
			})();
		});

		this.processingRequests.set(encodedHostname, processingRequest);

		let response: DecodedResponse | ErrorRequestFailed | undefined;
		try {
			response = await processingRequest;
		} catch (e) {
			const err = e as Error;
			if (err.message === "Hostname not found") {
				console.warn(`Service:  ${hostname} Not found`);
				const headersObj: { [key: string]: string } = {};
				req.headers.forEach((value, key) => {
					headersObj[key] = value;
				});
				return new HydraResponse("Hostname not found", { headers: headersObj, status: 404 });
			} else {
				console.error(err.message);
				throw err;
			}
		} finally {
			this.processingRequests.delete(hostname);
		}

		if (response instanceof ErrorRequestFailed) throw response;

		console.log(`Service:  ${hostname} Mirroring response`);
		const res = new HydraResponse(response.body, { headers: this.filterHydraHeaders(response.headers), timestamp: Date.now() });
		this.cachedResponses[reqKey] = res;
		return res;
	}
}
