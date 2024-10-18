import { Database } from "jsr:@db/sqlite@0.11";
import { join } from "https://deno.land/std/path/mod.ts";

export interface File {
  hash: string;
  infohash: string | null;
  downloadCount: number;
  id: string | null;
  name: string | null;
  found: boolean;
  size: number;
  createdAt: string;
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
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  select<T extends keyof File>(
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

  insert(values: File): File {
    const { hash, infohash, downloadCount = 0, id, name, found = true, size } = values;
    const query = `
      INSERT INTO file (hash, infohash, downloadCount, id, name, found, size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    this.db.exec(
      query,
      hash,
      infohash,
      downloadCount,
      id,
      name,
      found ? 1 : 0,
      size,
    );
    console.log(`  ${hash}  File INSERTed`);
    return this.select({ where: { key: "hash", value: values.hash } })[0];
  }

  update(hash: string, updates: Partial<File>): void { // TODO: If row has changed
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
    this.db.exec(
      `UPDATE file set ${column} = ${column}+1 WHERE hash = ${hash}`,
    );
  }

  count(): number {
    return this.db.exec("SELECT COUNT(*) FROM files");
  }

  sum(column: string): number {
    // @ts-expect-error:
    return this.db.exec(`SELECT sum(${column}) as sum FROM files`).sum;
  }
}

export default FileManager;
