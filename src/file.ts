import { Database } from "jsr:@db/sqlite@0.11";
import { join } from "https://deno.land/std/path/mod.ts";
import type Hydrafiles from "./hydrafiles.ts";
import { existsSync } from "https://deno.land/std@0.224.0/fs/exists.ts";
import { Readable } from "node:stream";

interface Metadata {
  name: string;
  size: number;
  type: string;
  hash: string;
  id: string;
  infohash: string;
}

export interface FileAttributes {
  hash: string;
  infohash: string | null;
  downloadCount: number;
  id: string | null;
  name: string | null;
  found: boolean;
  size: number;
  voteNonce: number;
  voteDifficulty: number;
}

const FILESPATH = join(new URL('.', import.meta.url).pathname, "../files");

function addColumnIfNotExists(db: Database, tableName: string, columnName: string, columnDefinition: string): void {
  const result = db.prepare(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name = ?`).value<[number]>(tableName, columnName);
  const columnExists = result && result[0] === 1

  if (!columnExists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    console.log(`Column '${columnName}' added to table '${tableName}'.`);
  }
}

class FileManager {
  private db: Database;

  constructor() {
    console.log(join(new URL('.', import.meta.url).pathname, "../filemanager.db"))
    console.log("Starting database connection...");
    this.db = new Database(join(new URL('.', import.meta.url).pathname, "../filemanager.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file (
        hash TEXT PRIMARY KEY,
        infohash TEXT,
        downloadCount INTEGER DEFAULT 0,
        id TEXT,
        name TEXT,
        found BOOLEAN DEFAULT 1,
        size INTEGER DEFAULT 0,
        voteNonce REAL,
        voteDifficulty REAL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    addColumnIfNotExists(this.db, 'file', 'voteNonce', 'REAL');
    addColumnIfNotExists(this.db, 'file', 'voteDifficulty', 'REAL');
  }

  select<T extends keyof FileAttributes>(
    opts: {
      where?: { key: T; value: NonNullable<File[T]> };
      orderBy?: string;
    } = {},
  ): File[] {
    let query = "SELECT * FROM file";
    const params: (string | number | boolean)[] = [];

    if (opts.where) {
      query += ` WHERE ${opts.where.key} = ?`;
      params.push(opts.where.value);
    }

    if (opts.orderBy) {
      query += ` ORDER BY ${opts.orderBy}`;
    }

    try {
      const results = this.db.prepare(query).values(...params);
      return results.map((row) => ({
        hash: row[0],
        infohash: row[1],
        downloadCount: row[2],
        id: row[3],
        name: row[4],
        found: row[5] === 1,
        size: row[6],
      })) as File[];
    } catch (err) {
      console.error("Error executing SELECT query:", err);
      return [];
    }
  }

  insert(values: Partial<FileAttributes>): File {
    const query = `
      INSERT INTO file (hash, infohash, downloadCount, id, name, found, size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    if (values.hash === undefined) throw new Error('No filehash provided');

    const file: FileAttributes = {
      hash: values.hash,
      infohash: values.infohash || null,
      downloadCount: values.downloadCount || 0,
      id: values.id || null,
      name: values.name || null,
      found: values.found !== undefined ? values.found : true,
      size: values.size || 0,
      voteNonce: values.voteNonce || 0,
      voteDifficulty: values.voteDifficulty || 0
    };
    this.db.exec(
      query,
      file.hash,
      file.infohash,
      file.downloadCount,
      file.id,
      file.name,
      file.found ? 1 : 0,
      file.size,
    );
    console.log(`  ${file.hash}  File INSERTed`);
    return this.select({ where: { key: "hash", value: file.hash } })[0];
  }

  update(hash: string, updates: Partial<FileAttributes>): void { // TODO: If row has changed
    const currentFile = this.select({ where: { key: "hash", value: hash } })[0];
    if (!currentFile) {
      console.error(`File with hash ${hash} not found.`);
      return;
    }

    const updatedColumn: string[] = [];
    const params: (string | number | boolean)[] = [];

    if (updates.infohash !== undefined && updates.infohash !== null && updates.infohash !== currentFile.infohash) {
      updatedColumn.push("infohash");
      params.push(updates.infohash);
    }
    if (updates.downloadCount !== undefined && updates.downloadCount !== currentFile.downloadCount) {
      updatedColumn.push("downloadCount");
      params.push(updates.downloadCount);
    }
    if (updates.id !== undefined && updates.id !== null && updates.id !== currentFile.id) {
      updatedColumn.push("id");
      params.push(updates.id);
    }
    if (updates.name !== undefined && updates.name !== null && updates.name !== currentFile.name) {
      updatedColumn.push("name");
      params.push(updates.name);
    }
    if (updates.found !== undefined && updates.found !== currentFile.found) {
      updatedColumn.push("found");
      params.push(updates.found ? 1 : 0);
    }
    if (updates.size !== undefined && updates.size !== currentFile.size) {
      updatedColumn.push("size");
      params.push(updates.size);
    }
    if(updatedColumn.length === 0) return;
    params.push(hash)

    const query = `UPDATE file SET ${updatedColumn.map(column => `${column} = ?`).join(", ")} WHERE hash = ?`;

    this.db.prepare(query).values(params)
    console.log(`  ${hash}  File UPDATEd - Updated Columns: ${updatedColumn.join(", ")}`);
  }

  delete(hash: string): void {
    const query = `DELETE FROM file WHERE hash = ?`;

    try {
      this.db.exec(query, hash);
      console.log(`${hash} File DELETEd`);
    } catch (err) {
      console.error("Error executing DELETE query:", err);
    }
  }

  increment<T>(hash: string, column: string): void {
    this.db.prepare(`UPDATE file set ${column} = ${column}+1 WHERE hash = ?`).values(hash);
  }

  count(): number {
    return this.db.exec("SELECT COUNT(*) FROM files");
  }

  sum(column: string): number {
    // @ts-expect-error:
    return this.db.exec(`SELECT sum(${column}) as sum FROM files`).sum;
  }
}

export const fileManager = new FileManager()

class File implements FileAttributes {
  hash: string;
  infohash: string | null;
  downloadCount: number;
  id: string | null;
  name: string | null;
  found: boolean;
  size: number;
  voteNonce: number;
  voteDifficulty: number;
  _client: Hydrafiles;

  constructor (
    values: { hash?: string; infohash?: string },
    client: Hydrafiles,
  ) {
    this._client = client;

    let hash: string;
    if (values.hash !== undefined) hash = values.hash;
    else if (values.infohash !== undefined) {
      if (!this._client.utils.isValidInfoHash(values.infohash)) throw new Error(`Invalid infohash provided: ${values.infohash}`);
      const file = fileManager.select({where: { key: "infohash", value: values.infohash }})[0];
      if (typeof file?.hash === "string") {
        hash = file?.hash;
      } else { // TODO: Check against other nodes
        hash = "";
      }
    } else throw new Error("No hash or infohash provided");
    if (hash !== undefined && !this._client.utils.isValidSHA256Hash(hash)) throw new Error("Invalid hash provided");

    this.hash = hash;

    const file = fileManager.select({ where: { key: "hash", value: hash } })[0] ?? fileManager.insert(this);
    this.infohash = file.infohash
    this.downloadCount = file.downloadCount
    this.id = file.id
    this.name = file.name
    this.found = file.found
    this.size = file.size
    this.voteNonce = file.voteNonce
    this.voteDifficulty = file.voteDifficulty

    this.vote().catch(console.error)
  }

  public async getMetadata(): Promise<this | false> {
    if (this.size > 0 && this.name !== undefined && this.name !== null && this.name.length > 0) return this;

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
        this.save();
        return this;
      }
    }

    const filePath = join(FILESPATH, hash);
    if (existsSync(filePath)) {
      this.size = Deno.statSync(filePath).size;
      this.save();
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
          this.save();
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
      this.save();
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
      Deno.remove(filePath).catch(console.error)
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
      this.increment("downloadCount");
    }
    this.save();

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
          this.save();
        }
      }
    }

    if (file !== false) this.seed();

    return file;
  }

  save(): void {
    fileManager.update(this.hash, this);
  }

  seed(): void { // TODO: webtorrent.add() all known files
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
    fileManager.increment(this.hash, column);
  }

  async vote(): Promise<void> {
    const nonce = Number(crypto.getRandomValues(new Uint32Array(1)));
    const voteHash = await this._client.utils.hashString(this.hash + nonce);
    const decimalValue = BigInt("0x" + voteHash).toString(10);
    const difficulty = Number(decimalValue) / Number(BigInt("0x" + "f".repeat(64)));
    this.voteNonce = nonce;
    if (difficulty > this.voteDifficulty) {
      console.log(` ${this.hash}  Found rarer difficulty`);
      this.voteDifficulty = difficulty;
      this.save();
    }
  }
}

export default File;
