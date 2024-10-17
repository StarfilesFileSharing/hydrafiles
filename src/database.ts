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
    console.log("Starting database connection...");
    this.db = new Database(join(Deno.cwd(), "../filemanager.db"));
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
    const { infohash, downloadCount, id, name, found, size } = updates;
    const setClauses: string[] = [];
    const params: (string | number | boolean)[] = [hash];

    if (infohash !== undefined && infohash !== null) {
      setClauses.push("infohash = ?");
      params.push(infohash);
    }
    if (downloadCount !== undefined) {
      setClauses.push("downloadCount = ?");
      params.push(downloadCount);
    }
    if (id !== undefined && id !== null) {
      setClauses.push("id = ?");
      params.push(id);
    }
    if (name !== undefined && name !== null) {
      setClauses.push("name = ?");
      params.push(name);
    }
    if (found !== undefined) {
      setClauses.push("found = ?");
      params.push(found ? 1 : 0);
    }
    if (size !== undefined) {
      setClauses.push("size = ?");
      params.push(size);
    }

    const query = `UPDATE file SET ${setClauses.join(", ")} WHERE hash = ?`;

    try {
      this.db.exec(query, ...params);
      console.log(`File with hash ${hash} updated successfully.`);
    } catch (err) {
      console.error("Error executing UPDATE query:", err);
    }
  }

  delete(hash: string): void {
    const query = `DELETE FROM file WHERE hash = ?`;

    try {
      this.db.exec(query, hash);
      console.log(`File with hash ${hash} deleted successfully.`);
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
