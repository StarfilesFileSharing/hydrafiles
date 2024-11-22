import Wallet, { EthAddress } from "../wallet.ts";
import Hydrafiles from "../hydrafiles.ts";
import Database from "../database.ts";

const blockModel = {
	tableName: "block",
	columns: {
		prev: { type: "TEXT" as const, primary: true },
		address: { type: "TEXT" as const },
		nonce: { type: "INTEGER" as const },
		signature: { type: "TEXT" as const },
		name: { type: "TEXT" as const },
		createdAt: { type: "DATETIME" as const, default: "CURRENT_TIMESTAMP" },
		updatedAt: { type: "DATETIME" as const, default: "CURRENT_TIMESTAMP" },
	},
};

interface BlockAttributes {
	prev: string;
	address: string;
	nonce: number;
	signature: string;
	name: string;
}

export class Block implements BlockAttributes {
	prev: EthAddress;
	address: EthAddress;
	nonce: number;
	signature: EthAddress;
	name: string;

	constructor(address: EthAddress, nonce: number, prev: EthAddress, signature: EthAddress, name: string) {
		this.address = address;
		this.nonce = nonce;
		this.prev = prev;
		this.signature = signature;
		this.name = name;
	}

	toString(): string {
		return `${this.address}-${this.nonce}-${this.prev}`;
	}
}

export default class BlockchainNameService {
	static _client: Hydrafiles;
	blocks: Block[] = [new Block("0x0000000000000000000000000000000000000000", 0, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "Genesis")];
	db: Database<typeof blockModel>;

	private constructor(db: Database<typeof blockModel>) {
		this.db = db;
	}

	static async init(): Promise<BlockchainNameService> {
		const db = await Database.init(blockModel, BlockchainNameService._client);
		const blockchainNameService = new BlockchainNameService(db);

		const blocks = await db.select();
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			blockchainNameService.blocks.push(new Block(block.address as EthAddress, block.nonce, block.prev as EthAddress, block.signature as EthAddress, block.name));
		}

		return blockchainNameService;
	}

	async createBlock(wallet: Wallet, name: string): Promise<void> {
		const prev = this.blocks[this.blocks.length - 1];

		let signature;
		for (let i = 0; true; i++) {
			signature = await wallet.signMessage(`${wallet.address()}-${i}-${prev.signature}`);
			if (signature.startsWith("0x00")) break;
			if (i % 100 === 0) console.log(`${i} attempts to find block`);
		}
		const block = new Block(wallet.address(), 0, prev.signature, signature, name);
		this.db.insert(block);
		this.blocks.push(block);
	}

	addBlock(block: Block): boolean {
		const prev = this.blocks[this.blocks.length - 1];

		if (block.prev !== prev.signature) return false; // TODO: Longest chain
		if (!BlockchainNameService._client.filesWallet.verifyMessage(block.toString(), block.signature, block.address)) return false;

		this.db.insert(block);
		this.blocks.push(block);
		return true;
	}

	async fetchBlocks(): Promise<void> {
		console.log(`Blocks:   Fetching blocks from peers`);
		const responses = await Promise.all(BlockchainNameService._client.rpcClient.fetch("http://localhost/blocks"));
		for (let i = 0; i < responses.length; i++) {
			const response = responses[i];
			if (response instanceof Error) continue;
			const data = await response.text();
			try {
				const blocks = JSON.parse(data) as BlockAttributes[];
				for (let j = 0; j < blocks.length; j++) {
					if (this.blocks[j].signature === blocks[j].signature) continue;
					const block = new Block(blocks[j].address as EthAddress, blocks[j].nonce, blocks[j].prev as EthAddress, blocks[j].signature as EthAddress, blocks[j].name);
					if (!this.addBlock(block)) break;
					console.log(`Blocks:   Received block`);
				}
			} catch (_) {
				continue;
			}
		}
	}
}
