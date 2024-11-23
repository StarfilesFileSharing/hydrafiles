import type Wallet from "../wallet.ts";
import Services from "./services.ts";

export default class Service {
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

	announce(name: string): void {
		Services._client.nameService.createBlock({ wallet: this.wallet }, name);
	}
}
