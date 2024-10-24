import type Hydrafiles from "./hydrafiles.ts";
import seedrandom from "https://cdn.skypack.dev/seedrandom";
import Utils from "./utils.ts";

const Deno: typeof globalThis.Deno | undefined = globalThis.Deno ?? undefined;
type Base64 = string & { __brand: "Base64" };

export interface Receipt {
	issuer: string;
	message: string;
	signature: Base64;
	nonce: number;
}

enum State {
	Locked = "LOCKED",
	Mempool = "MEMPOOL",
}

export const BLOCKSDIR = "blocks/";

export class Block {
	prevBlock: string;
	receipts: Receipt[] = [];
	state: State = State.Locked;
	private _client: Hydrafiles;
	time: number = +new Date();
	height = 0;
	constructor(prevBlock: string, client: Hydrafiles) {
		this.prevBlock = prevBlock;
		this._client = client;
		if (Deno !== undefined && !Utils.existsSync(BLOCKSDIR)) Deno.mkdir(BLOCKSDIR);
	}

	static init(hash: string, client: Hydrafiles): Block {
		const blockContent = JSON.parse(new TextDecoder().decode(Deno !== undefined ? Deno.readFileSync(Utils.pathJoin(BLOCKSDIR, hash)) : new Uint8Array()));
		const block = new Block(blockContent.prevBlock, client);
		block.receipts = blockContent.receipts;
		return block;
	}

	async signReceipt(peer: string, keyPair: CryptoKeyPair): Promise<Receipt> {
		const receipt = {
			peer,
			nonce: Math.random(),
			time: +new Date(),
		};
		const message = JSON.stringify(receipt);
		const signature = await this._client.utils.signMessage(keyPair.privateKey, message);
		const issuer = await this._client.utils.exportPublicKey(keyPair.publicKey);
		const nonce = Math.random();

		return {
			issuer,
			message,
			signature,
			nonce,
		};
	}

	async addReceipt(receipt: Receipt): Promise<void> { // TODO: Validate added transactions
		if (this.state !== State.Mempool) throw new Error("Block not in mempool");
		if (await this._client.utils.verifySignature(receipt)) this.receipts.push(receipt);
	}

	toString(): string {
		return JSON.stringify({
			receipts: this.receipts,
			prevBlock: this.prevBlock,
			time: this.time,
		});
	}

	async getHash(): Promise<string> {
		return await this._client.utils.hashString(this.toString());
	}

	getPeers(): string[] {
		const peers = this.receipts.map((receipt) => JSON.parse(receipt.message).peer as string);
		const sortedPeers = peers.sort((i) => seedrandom(this.getHash() + i)() - 0.5);
		return sortedPeers;
	}

	announce(): void { // TODO: P2P announce/receive blocks
		this.time = +new Date();
		this.state = State.Locked;
	}
}

class Blockchain {
	blocks: Block[] = [];
	mempoolBlock: Block;
	private _client: Hydrafiles;
	constructor(client: Hydrafiles) {
		if (Deno !== undefined) {
			for (const dirEntry of Deno.readDirSync(BLOCKSDIR)) { // TODO: Validate block prev is valid
				this.addBlock(Block.init(dirEntry.name, client));
			}
		}
		this._client = client;
		this.mempoolBlock = new Block("genesis", this._client);
		this.mempoolBlock.state = State.Mempool;

		// this.syncBlocks().then(() => this.proposeBlocks)
	}

	async proposeBlocks(): Promise<void> {
		const lastBlock = this.lastBlock();
		let peer = await this.nextBlockProposer(0);
		console.log(`Block Proposer is ${peer}`);
		if (peer === undefined || peer === await this._client.utils.exportPublicKey((await this._client.keyPair).publicKey)) {
			console.log("YOU ARE BLOCK PROPOSER");
			while (lastBlock.time + 60 * 1000 > +new Date()) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			peer = await this.nextBlockProposer(0);
			if (peer === undefined || peer === await this._client.utils.exportPublicKey((await this._client.keyPair).publicKey)) {
				this.newMempoolBlock();
			}
		} else {
			while (lastBlock.time + 60 * 1000 > +new Date()) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			await this
				.syncBlocks();
			while (lastBlock.time + 60 * 1000 > +new Date()) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			await this.syncBlocks();
			console.log("Unclaimed block");
			this.newMempoolBlock();
		}
		await this.proposeBlocks();
	}

	async syncBlocks(): Promise<void> {
		const blockHeights = await this._client.nodes.getBlockHeights();
		for (let i = 0; i < Object.keys(blockHeights).length; i++) {
			const claimedBlockHeight = Number(Object.keys(blockHeights)[i]);
			if (claimedBlockHeight > this.lastBlock().height) {
				const nodes = blockHeights[claimedBlockHeight];
				for (let j = 0; j < claimedBlockHeight; j++) {
					if (i < this.lastBlock().height) continue;
					for (let k = 0; k < nodes.length; k++) {
						console.log(`Fetch block ${i} from ${nodes[k]}`);
						let response;
						try {
							response = await fetch(`${nodes[k]}/block/${j}`);
						} catch (_) {
							continue;
						}
						const blockContent = await response.text();
						let blockPaylod;
						try {
							blockPaylod = JSON.parse(blockContent);
						} catch (_) {
							continue;
						}
						const block = new Block(blockPaylod.prevBlock, this._client);
						block.time = blockPaylod.time;
						block.receipts = blockPaylod.receipts;
						this.addBlock(block);
					}
				}
			}
		}
	}

	addBlock(block: Block): void {
		block.height = this.blocks.length;
		this.blocks.push(block);
		block.announce();
		if (Deno !== undefined) Deno.writeFileSync(Utils.pathJoin(BLOCKSDIR, this.blocks.length.toString()), new TextEncoder().encode(block.toString()));
	}

	lastBlock(): Block {
		return this.blocks[this.blocks.length - 1] ?? new Block("Genesis", this._client);
	}

	async newMempoolBlock(): Promise<void> {
		if (
			this.mempoolBlock !== null
		) {
			this.mempoolBlock.announce();
			this.addBlock(this.mempoolBlock);
		}
		const block = new Block(await (this.mempoolBlock ?? new Block("genesis", this._client)).getHash(), this._client);
		block.state = State.Mempool;
		this.mempoolBlock = block;
	}

	async nextBlockProposer(level = 0): Promise<string> {
		const lastBlockHash = await this.lastBlock().getHash();
		const peers = this.blocks.map((block) => block.getPeers()).flat();
		const sortedPeers = peers.sort((i) => seedrandom(lastBlockHash + i)() - 0.5);
		return sortedPeers[level];
	}
}

export default Blockchain;
