import { createPublicClient, createWalletClient, http, publicActions } from "npm:viem";
import { privateKeyToAccount } from "npm:viem/accounts";
import { sepolia } from "npm:viem/chains";
import type Hydrafiles from "./hydrafiles.ts";
import { randomIntegerBetween, randomSeeded } from "jsr:@std/random";
import { ErrorInsufficientBalance } from "./errors.ts";

export type EthAddress = `0x${string}`;

class Wallet {
	private _client: Hydrafiles;
	account: ReturnType<typeof privateKeyToAccount>;
	client: ReturnType<typeof createWalletClient> & ReturnType<typeof createPublicClient>;

	private constructor(client: Hydrafiles, privateKey: EthAddress) {
		this._client = client;
		this.account = privateKeyToAccount(privateKey);
		this.client = createWalletClient({
			account: this.account,
			chain: sepolia,
			transport: http(),
		}).extend(publicActions);
	}

	public static async init(client: Hydrafiles): Promise<Wallet> {
		const keyFilePath = "eth.key";

		if (!await client.fs.exists(keyFilePath)) await client.fs.writeFile(keyFilePath, new TextEncoder().encode(Wallet.generateEthPrivateKey(client)));

		const fileContent = await client.fs.readFile(keyFilePath);
		const key = !(fileContent instanceof Error) ? new TextDecoder().decode(fileContent) as EthAddress : Wallet.generateEthPrivateKey(client);

		return new Wallet(client, key);
	}

	public static generateEthPrivateKey(client: Hydrafiles): EthAddress {
		if (client.config.deriveKey.length) {
			const prng = randomSeeded(BigInt("0x" + client.config.deriveKey));

			let result = "";
			for (let i = 0; i < 8; i++) {
				const chunk = randomIntegerBetween(i === 0 ? 0x10000000 : 0, 0xFFFFFFFF, { prng })
					.toString(16)
					.padStart(8, "0");

				result += chunk;
			}
			return "0x" + result as EthAddress;
		}

		const privateKey = new Uint8Array(32);
		crypto.getRandomValues(privateKey);
		return ("0x" + Array.from(privateKey)
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("")) as EthAddress;
	}

	public async balance(): Promise<number> {
		const balanceWei = await this.client.getBalance({ address: this.account.address });
		return parseFloat(balanceWei.toString()) / 1e18;
	}

	public async transfer(to: EthAddress, amount: bigint): Promise<true | ErrorInsufficientBalance> {
		const currentBalance = await this.balance();
		const amountInEth = parseFloat(amount.toString()) / 1e18;

		if (currentBalance < amountInEth) {
			console.log(`Insufficient balance. Current balance: ${currentBalance}, Transfer amount: ${amountInEth}`);
			return new ErrorInsufficientBalance();
		}

		console.log(`Transferring ${amount} to ${to}`);
		try {
			const hash = await this.client.sendTransaction({
				account: this.account,
				chain: sepolia,
				to,
				value: amount,
			});
			console.log("Transaction Hash:", hash);
		} catch (e) {
			if (this._client.config.logLevel === "verbose") console.error(e);
		}
		return true;
	}

	public address(): EthAddress {
		return this.account.address;
	}
}

export default Wallet;
