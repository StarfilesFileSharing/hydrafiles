import { HydraResponse } from "../rpc/routes.ts";
import type Wallet from "../wallet.ts";
import Services from "./services.ts";

export default class Service {
	wallet: Wallet;
	requestHandler: (req: Request) => Promise<Response> | Response;

	public constructor(wallet: Wallet, requestHandler: (req: Request) => Promise<Response> | Response) {
		this.wallet = wallet;
		this.requestHandler = requestHandler;
	}

	public async fetch(req: Request): Promise<HydraResponse> {
		const res = await HydraResponse.from(await this.requestHandler(req));
		res.headers["hydra-signature"] = await this.wallet.signMessage(JSON.stringify({ body: res.body, headers: res.headers, status: res.status }));
		return res;
	}

	announce(name: string): void {
		Services._client.nameService.createBlock({ wallet: this.wallet }, name);
	}
}
