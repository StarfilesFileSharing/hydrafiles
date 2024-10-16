import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Model } from "sequelize";
import type Hydrafiles from "./hydrafiles.ts";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { Block } from "./block.ts";

interface Metadata {
  name: string;
  size: number;
  type: string;
  hash: string;
  id: string;
  infohash: string;
}

// TODO: Log common user-agents and use the same for requests to slightly anonymise clients

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const FILESPATH = path.join(DIRNAME, "../files");
// const seeding: string[] = [];

export interface FileAttributes {
  hash: string;
  infohash: string;
  downloadCount: number | undefined;
  id: string;
  name: string;
  found: boolean;
  size: number;
  createdAt: Date;
  updatedAt: Date;
}

export default class FileHandler {
  hash!: string;
  infohash: string | null | undefined;
  downloadCount: number | undefined;
  id: string | null | undefined;
  name: string | null | undefined;
  found!: boolean;
  size!: number;
  createdAt!: Date;
  updatedAt!: Date;
  file!: Model<FileAttributes, Partial<FileAttributes>>;
  _client!: Hydrafiles;

  public static async init(
    opts: { hash?: string; infohash?: string },
    client: Hydrafiles,
  ): Promise<FileHandler> {
    let hash: string;
    if (opts.hash !== undefined) hash = opts.hash;
    else if (opts.infohash !== undefined) {
      if (!client.utils.isValidInfoHash(opts.infohash)) {
        throw new Error(`Invalid infohash provided: ${opts.infohash}`);
      }
      const file = await client.FileModel.findOne({
        where: { infohash: opts.infohash },
      });
      if (typeof file?.dataValues.hash === "string") {
        hash = file?.dataValues.hash;
      } else {
        // TODO: Check against other nodes
        hash = "";
      }
    } else throw new Error("No hash or infohash provided");
    if (hash !== undefined && !client.utils.isValidSHA256Hash(hash)) {
      throw new Error("Invalid hash provided");
    }

    const fileHandler = new FileHandler();
    fileHandler.hash = hash;
    fileHandler.infohash = "";
    fileHandler.id = "";
    fileHandler.name = "";
    fileHandler.found = true;
    fileHandler.size = 0;
    fileHandler._client = client;

    const existingFile = await client.FileModel.findByPk(hash);
    fileHandler.file = existingFile ?? await client.FileModel.create({ hash });
    Object.assign(fileHandler, fileHandler.file.dataValues);
    if (Number(fileHandler.size) === 0) fileHandler.size = 0;

    return fileHandler;
  }

  public async getMetadata(): Promise<FileHandler | false> {
    if (
      this.size > 0 && this.name !== undefined && this.name !== null &&
      this.name.length > 0
    ) return this;

    const hash = this.hash;

    console.log(`  ${hash}  Getting file metadata`);

    const id = this.id;
    if (id !== undefined && id !== null && id.length > 0) {
      const response = await fetch(
        `${this._client.config.metadata_endpoint}${id}`,
      );
      if (response.ok) {
        const metadata = (await response.json()).result as Metadata;
        this.name = metadata.name;
        this.size = metadata.size;
        if (this.infohash?.length === 0) this.infohash = metadata.infohash;
        await this.save();
        return this;
      }
    }

    const filePath = path.join(FILESPATH, hash);
    if (fs.existsSync(filePath)) {
      this.size = fs.statSync(filePath).size;
      await this.save();
      return this;
    }

    if (this._client.config.s3_endpoint.length !== 0) {
      try {
        const data = await this._client.s3.headObject({
          Bucket: "uploads",
          Key: `${hash}.stuf`,
        });
        if (typeof data.ContentLength !== "undefined") {
          this.size = data.ContentLength;
          await this.save();
          return this;
        }
      } catch (error) {
        console.error(error);
      }
    }

    return false;
  }

  async cacheFile(file: Buffer): Promise<void> {
    const hash = this.hash;
    const filePath = path.join(FILESPATH, hash);
    if (fs.existsSync(filePath)) return;

    let size = this.size;
    if (size === 0) {
      size = file.byteLength;
      this.size = size;
      await this.save();
    }
    const remainingSpace = this._client.utils.remainingStorage();
    if (this._client.config.max_cache !== -1 && size > remainingSpace) {
      this._client.utils.purgeCache(size, remainingSpace);
    }

    await this._client.utils.saveBufferToFile(file, filePath);
    const fileContents = fs.createReadStream(filePath);
    const savedHash = await this._client.utils.hashStream(fileContents);
    if (savedHash !== hash) fs.rmSync(filePath); // In case of broken file
  }

  private async fetchFromCache(): Promise<
    { file: Buffer; signal: number } | false
  > {
    const hash = this.hash;
    console.log(`  ${hash}  Checking Cache`);
    const filePath = path.join(FILESPATH, hash);
    await this.seed();
    if (!fs.existsSync(filePath)) return false;
    const fileContents = fs.createReadStream(filePath);
    const savedHash = await this._client.utils.hashStream(fileContents);
    if (savedHash !== this.hash) {
      fs.rmSync(filePath);
      return false;
    }
    return {
      file: fs.readFileSync(filePath),
      signal: this._client.utils.interfere(100),
    };
  }

  async fetchFromS3(): Promise<{ file: Buffer; signal: number } | false> {
    console.log(`  ${this.hash}  Checking S3`);
    if (this._client.config.s3_endpoint.length === 0) return false;
    try {
      let buffer: Buffer;
      const data = await this._client.s3.getObject({
        Bucket: "uploads",
        Key: `${this.hash}.stuf`,
      });

      if (data.Body instanceof Readable) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of data.Body) {
          chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
      } else if (data.Body instanceof Buffer) buffer = data.Body;
      else return false;

      if (this._client.config.cache_s3) await this.cacheFile(buffer);

      const stream = this._client.utils.bufferToStream(buffer);
      const hash = await this._client.utils.hashStream(stream);
      if (hash !== this.hash) {
        return false;
      }
      return { file: buffer, signal: this._client.utils.interfere(100) };
    } catch (e) {
      const err = e as { message: string };
      if (err.message !== "The specified key does not exist.") {
        console.error(err);
      }
      return false;
    }
  }

  // TODO: fetchFromTorrent
  // TODO: Connect to other hydrafiles nodes as webseed
  // TODO: Check other nodes file lists to find other claimed infohashes for the file, leech off all of them and copy the metadata from the healthiest torrent

  async getFile(
    opts: { logDownloads?: boolean } = {},
  ): Promise<{ file: Buffer; signal: number } | false> {
    const peer = await this._client.utils.exportPublicKey((await this._client.keyPair).publicKey) // TODO: Replace this with actual peer
    const receipt = await this._client.blockchain.mempoolBlock.signReceipt(peer, await this._client.keyPair);
    await this._client.blockchain.mempoolBlock.addReceipt(receipt)
    if (this._client.blockchain.mempoolBlock.receipts.length > 10)
      this._client.blockchain.mempoolBlock = await this._client.blockchain.newMempoolBlock(this._client)
    console.log(this._client.blockchain.blocks.length, this._client.blockchain.mempoolBlock.receipts.length)

    const hash = this.hash;
    console.log(`  ${hash}  Getting file`);
    if (!this._client.utils.isValidSHA256Hash(hash)) {
      console.log(`  ${hash}  Invalid hash`);
      return false;
    }
    if (
      !this.found &&
      new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000)
    ) {
      console.log(`  ${hash}  404 cached`);
      return false;
    }
    if (opts.logDownloads === undefined || opts.logDownloads) {
      await this.increment("downloadCount");
    }
    await this.save();

    if (this.size !== 0 && !this._client.utils.hasSufficientMemory(this.size)) {
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (this._client.config.log_level === "verbose") {
            console.log(`  ${hash}  Reached memory limit, waiting`, this.size);
          }
          if (
            this.size === 0 || this._client.utils.hasSufficientMemory(this.size)
          ) clearInterval(intervalId);
        }, this._client.config.memory_threshold_reached_wait);
      });
    }

    let file = await this.fetchFromCache();
    if (file !== false) {
      console.log(
        `  ${hash}  Serving ${
          this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0
        }MB from cache`,
      );
    } else {
      if (this._client.config.s3_endpoint.length > 0) {
        file = await this.fetchFromS3();
      }
      if (file !== false) {
        console.log(
          `  ${hash}  Serving ${
            this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0
          }MB from S3`,
        );
      } else {
        file = await this._client.nodes.getFile(hash, this.size);
        if (file === false) {
          this.found = false;
          await this.save();
        }
      }
    }

    if (file !== false) await this.seed();

    return file;
  }

  async save(): Promise<void> {
    const values = Object.keys(this).reduce(
      (row: Record<string, unknown>, key: string) => {
        if (key !== "file" && key !== "save") {
          row[key] = this[key as keyof FileAttributes];
        }
        return row;
      },
      {},
    );

    Object.assign(this.file, values);
    await this.file.save();
  }

  seed(): void {
    // if (seeding.includes(this.hash)) return;
    // seeding.push(this.hash);
    // const filePath = path.join(FILESPATH, this.hash);
    // if (!fs.existsSync(filePath)) return;
    // this._client.webtorrent.seed(filePath, {
    //   createdBy: "Hydrafiles/0.1",
    //   name: (this.name ?? this.hash).replace(/(\.\w+)$/, " [HYDRAFILES]$1"),
    //   destroyStoreOnDestroy: true,
    //   addUID: true,
    //   comment: "Anonymously seeded with Hydrafiles",
    // }, async (torrent: { infoHash: string }) => {
    //   console.log(`  ${this.hash}  Seeding with infohash ${torrent.infoHash}`);
    //   this.infohash = torrent.infoHash;
    //   await this.save();
    // });
  }

  async increment(column: keyof FileAttributes): Promise<void> {
    await this.file.increment(column);
  }
}

// TODO: webtorrent.add() all known files
