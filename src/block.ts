import seedrandom from "https://cdn.skypack.dev/seedrandom";
import type Hydrafiles from "./hydrafiles.ts";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
export const BLOCKSDIR = path.join(DIRNAME, "../blocks/");

export class Block {
  prevBlock: string;
  receipts: Receipt[] = [];
  state: State = State.Locked;
  private _client: Hydrafiles;
  time: number = +new Date();
  height: number = 0;
  constructor(prevBlock: string, client: Hydrafiles) {
    this.prevBlock = prevBlock;
    this._client = client;
  }

  static init(hash: string, client: Hydrafiles) {
    const blockContent = JSON.parse(
      new TextDecoder().decode(Deno.readFileSync(path.join(BLOCKSDIR, hash))),
    );
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
    const signature = await this._client.utils.signMessage(
      keyPair.privateKey,
      message,
    );
    const issuer = await this._client.utils.exportPublicKey(keyPair.publicKey);
    const nonce = Math.random();

    return { issuer, message, signature, nonce };
  }

  async addReceipt(receipt: Receipt) { // TODO: Validate added transactions
    if (this.state !== State.Mempool) throw new Error("Block not in mempool");
    if (await this._client.utils.verifySignature(receipt)) {
      this.receipts.push(receipt);
    }
  }

  toString() {
    return JSON.stringify({
      receipts: this.receipts,
      prevBlock: this.prevBlock,
      time: this.time,
    });
  }

  async getHash() {
    return await this._client.utils.hashString(this.toString());
  }

  getPeers() {
    const peers = this.receipts.map((receipt) =>
      JSON.parse(receipt.message).peer
    );
    const sortedPeers = peers.sort((i) =>
      seedrandom(this.getHash() + i)() - 0.5
    );
    return sortedPeers;
  }

  announce() { // TODO: P2P announce/receive blocks
    this.time = +new Date();
    this.state = State.Locked;
  }
}

class Blockchain {
  blocks: Block[] = [];
  mempoolBlock: Block;
  private _client: Hydrafiles;
  constructor(client: Hydrafiles) {
    for (const dirEntry of Deno.readDirSync(BLOCKSDIR)) { // TODO: Validate block prev is valid
      this.addBlock(Block.init(dirEntry.name, client));
    }
    this._client = client;
    this.mempoolBlock = new Block("genesis", this._client);
    this.mempoolBlock.state = State.Mempool;

    this.proposeBlocks();
  }

  async proposeBlocks() {
    const peer = await this.nextBlockProposer();
    console.log(`Block Proposer is ${peer}`);
    if (peer === undefined ||
      peer ===
        await this._client.utils.exportPublicKey(
          (await this._client.keyPair).publicKey,
        )
    ) {
      console.log("YOU ARE BLOCK PROPOSER");
      while (this.lastBlock().time + 5 * 1000 > +new Date()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (peer === undefined ||
        peer ===
          await this._client.utils.exportPublicKey(
            (await this._client.keyPair).publicKey,
          )
      ) {
        this.newMempoolBlock();
      }
    }
    await this.proposeBlocks();
  }

  addBlock(block: Block) {
    block.height = this.blocks.length;
    this.blocks.push(block);
    block.announce();
    Deno.writeFileSync(
      path.join(BLOCKSDIR, this.blocks.length.toString()),
      new TextEncoder().encode(block.toString()),
    );
  }

  lastBlock() {
    return this.blocks[this.blocks.length - 1] ?? new Block('Genesis', this._client);
  }

  async newMempoolBlock() {
    if (this.mempoolBlock !== null) {
      this.mempoolBlock.announce();
      this.addBlock(this.mempoolBlock);
    }
    const block = new Block(
      await (this.mempoolBlock ?? new Block("genesis", this._client)).getHash(),
      this._client,
    );
    block.state = State.Mempool;
    this.mempoolBlock = block;
  }

  async nextBlockProposer() {
    const lastBlockHash = await this.lastBlock().getHash();
    const peers = this.blocks.map((block) => block.getPeers()).flat();
    const sortedPeers = peers.sort((i) =>
      seedrandom(lastBlockHash + i)() - 0.5
    );
    return sortedPeers[0];
  }
}

export default Blockchain;
