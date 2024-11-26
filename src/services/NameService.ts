import { type NonEmptyString, Sha256 } from "./../utils.ts";
import Wallet, { EthAddress } from "../wallet.ts";
import Hydrafiles from "../hydrafiles.ts";
import Database from "../database.ts";
import { encodeHex } from "jsr:@std/encoding/hex";

const blockModel = {
	tableName: "block",
	columns: {
		prev: { type: "TEXT" as const, primary: true },
		content: { type: "TEXT" as const, isNullable: true },
		id: { type: "TEXT" as const, isNullable: true },
		nonce: { type: "INTEGER" as const },
		name: { type: "TEXT" as const },
		createdAt: { type: "DATETIME" as const, default: "CURRENT_TIMESTAMP" },
		updatedAt: { type: "DATETIME" as const, default: "CURRENT_TIMESTAMP" },
	},
};

interface BlockAttributes {
	prev: string;
	nonce: number;
	name: string;
	content: string;
	id: string;
}

export class Block implements BlockAttributes {
	prev: EthAddress | Sha256;
	nonce: number;
	name: string;
	content: EthAddress | string;
	id: EthAddress | Sha256;
	updatedAt: NonEmptyString = new Date().toISOString();
	createdAt: NonEmptyString = new Date().toISOString();

	constructor(content: EthAddress | string, id: EthAddress | Sha256, nonce: number, prev: EthAddress | Sha256, name: string) {
		this.id = id;
		this.content = content;
		this.nonce = nonce;
		this.prev = prev;
		this.name = name;
	}
}

export default class BlockchainNameService {
	static _client: Hydrafiles;
	blocks: Block[] = [new Block("0x0", "0x0", 0, "0x0", "Genesis")];
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
			blockchainNameService.blocks.push(new Block(block.content, block.id as EthAddress | Sha256, block.nonce, block.prev as EthAddress, block.name));
		}

		return blockchainNameService;
	}

	async createBlock(data: { wallet: Wallet } | { script: string }, name: string): Promise<void> {
		const prev = this.blocks[this.blocks.length - 1];

		let nonce;
		let id;
		let content;
		if ("wallet" in data) {
			for (nonce = 0; true; nonce++) {
				id = await data.wallet.signMessage(`${data.wallet.address()}-${nonce}-${prev.id}`);
				if (id.startsWith("0x00")) {
					content = data.wallet.address();
					break;
				}
				if (nonce % 100 === 0) console.log(`${nonce} attempts to find block`);
			}
		} else {
			for (nonce = 0; true; nonce++) {
				id = encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${data.script}-${nonce}-${prev.id}`))) as Sha256;
				if (id.startsWith("00")) {
					content = data.script;
					break;
				}
				if (nonce % 100 === 0) console.log(`${nonce} attempts to find block`);
			}
		}
		const block = new Block(content, id, nonce, prev.id, name);

		this.db.insert(block);
		this.blocks.push(block);
	}

	async addBlock(block: Block): Promise<boolean> {
		const prev = this.blocks[this.blocks.length - 1];

		if (block.prev !== prev.id) return false; // TODO: Longest chain
		if (block.id.startsWith("0x")) {
			if (!BlockchainNameService._client.filesWallet.verifyMessage(block.toString(), block.id as EthAddress, block.content as EthAddress)) return false;
		} else {
			if (encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${block.content}-${block.nonce}-${block.prev}`))) !== block.id) return false;
		}

		this.db.insert(block);
		this.blocks.push(block);
		return true;
	}

	async fetchBlocks(): Promise<void> {
		console.log(`Blocks:   Fetching blocks from peers`);
		const responses = await Promise.all(await BlockchainNameService._client.rpcClient.fetch("https://localhost/blocks"));
		for (let i = 0; i < responses.length; i++) {
			const response = responses[i];
			if (response instanceof Error) continue;
			try {
				const blocks = JSON.parse(response.text()) as BlockAttributes[];
				for (let j = 0; j < blocks.length; j++) {
					if (this.blocks[j].id === blocks[j].id) continue;
					const block = new Block(blocks[j].content, blocks[j].id as EthAddress | Sha256, blocks[j].nonce, blocks[j].prev as EthAddress, blocks[j].name);
					if (!this.addBlock(block)) break;
					console.log(`Blocks:   Received block`);
				}
			} catch (_) {
				continue;
			}
		}
	}
}
