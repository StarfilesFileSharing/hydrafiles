import { createPublicClient, createWalletClient, http, publicActions } from "npm:viem";
import { privateKeyToAccount } from "npm:viem/accounts";
import { sepolia } from "npm:viem/chains";
import type Hydrafiles from "./hydrafiles.ts";

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

		if (!await client.fs.exists(keyFilePath)) await client.fs.writeFile(keyFilePath, new TextEncoder().encode(Wallet.generateEthPrivateKey()));

		const fileContent = await client.fs.readFile(keyFilePath);
		const key = fileContent !== false ? new TextDecoder().decode(fileContent) as EthAddress : Wallet.generateEthPrivateKey();

		return new Wallet(client, key);
	}

	public static generateEthPrivateKey(): EthAddress {
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

	public async transfer(to: EthAddress, amount: bigint): Promise<boolean> {
		const currentBalance = await this.balance();
		const amountInEth = parseFloat(amount.toString()) / 1e18;

		if (currentBalance < amountInEth) {
			console.log(`Insufficient balance. Current balance: ${currentBalance}, Transfer amount: ${amountInEth}`);
			return false;
		}

		console.log(`Transferring ${amount} to ${to}`);
		const hash = await this.client.sendTransaction({
			account: this.account,
			chain: sepolia,
			to,
			value: amount,
		});
		console.log("Transaction Hash:", hash);
		return true;
	}

	public address(): EthAddress {
		return this.account.address;
	}
}

export default Wallet;
