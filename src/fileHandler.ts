import { Readable } from "node:stream";

import type Hydrafiles from "./hydrafiles.ts";
import { existsSync } from "https://deno.land/std/fs/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";
import type { File } from "./database.ts";

interface Metadata {
  name: string;
  size: number;
  type: string;
  hash: string;
  id: string;
  infohash: string;
}

// TODO: Log common user-agents and use the same for requests to slightly anonymise clients

const FILESPATH = join(Deno.cwd(), "../files");
// const seeding: string[] = [];

export default class FileHandler implements File {
  hash!: string;
  infohash: string | null = null;
  downloadCount = 0;
  id: string | null = null;
  name: string | null = null;
  found = true;
  size = 0;
  createdAt!: string;
  _client!: Hydrafiles;

  constructor(
    opts: { hash?: string; infohash?: string },
    client: Hydrafiles,
  ) {
    let hash: string;
    if (opts.hash !== undefined) hash = opts.hash;
    else if (opts.infohash !== undefined) {
      if (!client.utils.isValidInfoHash(opts.infohash)) {
        throw new Error(`Invalid infohash provided: ${opts.infohash}`);
      }
      const file = client.FileManager.select({
        where: { key: "infohash", value: opts.infohash },
      })[0];
      if (typeof file?.hash === "string") {
        hash = file?.hash;
      } else {
        // TODO: Check against other nodes
        hash = "";
      }
    } else throw new Error("No hash or infohash provided");
    if (hash !== undefined && !client.utils.isValidSHA256Hash(hash)) {
      throw new Error("Invalid hash provided");
    }

    this.hash = hash;
    this._client = client;

    const file =
      client.FileManager.select({ where: { key: "hash", value: hash } })[0] ??
        client.FileManager.insert(this);
    Object.assign(this, file);
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
        `${this._client.config.metadataEndpoint}${id}`,
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

    const filePath = join(FILESPATH, hash);
    if (existsSync(filePath)) {
      this.size = Deno.statSync(filePath).size;
      await this.save();
      return this;
    }

    if (this._client.config.s3Endpoint.length !== 0) {
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

  async cacheFile(file: Uint8Array): Promise<void> {
    const hash = this.hash;
    const filePath = join(FILESPATH, hash);
    if (existsSync(filePath)) return;

    let size = this.size;
    if (size === 0) {
      size = file.byteLength;
      this.size = size;
      await this.save();
    }
    const remainingSpace = this._client.utils.remainingStorage();
    if (this._client.config.maxCache !== -1 && size > remainingSpace) {
      this._client.utils.purgeCache(size, remainingSpace);
    }

    Deno.writeFileSync(filePath, file);
    const savedHash = await this._client.utils.hashUint8Array(
      Deno.readFileSync(filePath),
    );
    if (savedHash !== hash) await Deno.remove(filePath); // In case of broken file
  }

  private async fetchFromCache(): Promise<
    { file: Uint8Array; signal: number } | false
  > {
    const hash = this.hash;
    console.log(`  ${hash}  Checking Cache`);
    const filePath = join(FILESPATH, hash);
    this.seed();
    if (!existsSync(filePath)) return false;
    const fileContents = Deno.readFileSync(filePath);
    const savedHash = await this._client.utils.hashUint8Array(fileContents);
    if (savedHash !== this.hash) {
      await Deno.remove(filePath);
      return false;
    }
    return {
      file: fileContents,
      signal: this._client.utils.interfere(100),
    };
  }

  async fetchFromS3(): Promise<{ file: Uint8Array; signal: number } | false> {
    console.log(`  ${this.hash}  Checking S3`);
    if (this._client.config.s3Endpoint.length === 0) return false;
    try {
      let file: Uint8Array;
      const data = await this._client.s3.getObject({
        Bucket: "uploads",
        Key: `${this.hash}.stuf`,
      });

      if (data.Body instanceof Readable) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of data.Body) {
          chunks.push(chunk);
        }

        const length = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        file = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          file.set(chunk, offset);
          offset += chunk.length;
        }
      } else {
        console.error("Unknown S3 return type");
        return false;
      }

      if (this._client.config.cacheS3) await this.cacheFile(file);

      const hash = await this._client.utils.hashUint8Array(file);
      if (hash !== this.hash) {
        return false;
      }
      return { file, signal: this._client.utils.interfere(100) };
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
  ): Promise<{ file: Uint8Array; signal: number } | false> {
    // const peer = await this._client.utils.exportPublicKey((await this._client.keyPair).publicKey); // TODO: Replace this with actual peer
    // const receipt = await this._client.blockchain.mempoolBlock.signReceipt(
    //   peer,
    //   await this._client.keyPair,
    // );
    // await this._client.blockchain.mempoolBlock.addReceipt(receipt);
    // console.log(
    //   this._client.blockchain.blocks.length,
    //   this._client.blockchain.mempoolBlock.receipts.length,
    // );

    const hash = this.hash;
    console.log(`  ${hash}  Getting file`);
    if (!this._client.utils.isValidSHA256Hash(hash)) {
      console.log(`  ${hash}  Invalid hash`);
      return false;
    }
    // if (
    //   !this.found &&
    //   new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000)
    // ) {
    //   console.log(`  ${hash}  404 cached`);
    //   return false;
    // }
    if (opts.logDownloads === undefined || opts.logDownloads) {
      await this.increment("downloadCount");
    }
    await this.save();

    if (this.size !== 0 && !this._client.utils.hasSufficientMemory(this.size)) {
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (this._client.config.logLevel === "verbose") {
            console.log(`  ${hash}  Reached memory limit, waiting`, this.size);
          }
          if (
            this.size === 0 || this._client.utils.hasSufficientMemory(this.size)
          ) clearInterval(intervalId);
        }, this._client.config.memoryThresholdReachedWait);
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
      if (this._client.config.s3Endpoint.length > 0) {
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

  save(): void {
    this._client.FileManager.update(this.hash, this);
  }

  seed(): void {
    // if (seeding.includes(this.hash)) return;
    // seeding.push(this.hash);
    // const filePath = join(FILESPATH, this.hash);
    // if (!existsSync(filePath)) return;
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

  increment(column: keyof File): void {
    this._client.FileManager.increment(this.hash, column);
  }
}

// TODO: webtorrent.add() all known files
