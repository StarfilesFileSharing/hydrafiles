import type { Database as SQLite } from "jsr:@db/sqlite";
import type { indexedDB } from "https://deno.land/x/indexeddb@v1.1.0/ponyfill.ts";
import { ErrorMissingRequiredProperty, ErrorNotFound, ErrorNotInitialised } from "./errors.ts";
import Hydrafiles from "./hydrafiles.ts";
import type { NonEmptyString } from "./utils.ts";

export interface ModelType {
	tableName: string;
	columns: {
		[key: string]: {
			type: "INTEGER" | "REAL" | "TEXT" | "DATETIME" | "BOOLEAN";
			primary?: boolean;
			default?: string | number | boolean;
			unique?: boolean;
			isNullable?: boolean;
		};
	};
}

type ColumnTypes = {
	INTEGER: number;
	REAL: number;
	TEXT: NonEmptyString;
	DATETIME: NonEmptyString;
	BOOLEAN: boolean;
};

export type DatabaseModal<T extends ModelType> =
	& {
		[K in keyof T["columns"]]: T["columns"][K]["type"] extends keyof ColumnTypes ? (
				T["columns"][K]["isNullable"] extends true ? ColumnTypes[T["columns"][K]["type"]] | null : ColumnTypes[T["columns"][K]["type"]]
			)
			: never;
	}
	& {
		createdAt: NonEmptyString;
		updatedAt: NonEmptyString;
	};

type DatabaseWrapperUndefined = { type: "UNDEFINED"; db: undefined };
type DatabaseWrapperSQLite = { type: "SQLITE"; db: SQLite };
type DatabaseWrapperIndexedDB = { type: "INDEXEDDB"; db: IDBDatabase };
type DatabaseWrapper = DatabaseWrapperUndefined | DatabaseWrapperSQLite | DatabaseWrapperIndexedDB;

function addColumnIfNotExists(db: SQLite, tableName: string, columnName: string, columnDefinition: string): void {
	const result = db.prepare(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name = ?`).value<[number]>(tableName, columnName);
	const columnExists = result && result[0] === 1;

	if (!columnExists) {
		if (db !== undefined) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
		console.log(`Column '${columnName}' added to table '${tableName}'.`);
	}
}

export default class Database<T extends ModelType> {
	private _client: Hydrafiles;
	db: DatabaseWrapper = { type: "UNDEFINED", db: undefined };
	model: T;

	private constructor(model: T, client: Hydrafiles) {
		this.model = model;
		this._client = client;
	}

	static async init<T extends ModelType>(model: T, client: Hydrafiles): Promise<Database<T>> {
		const database = new Database(model, client);

		if (typeof window === "undefined") {
			const SQLite = (await import("jsr:@db/sqlite")).Database;
			const db: DatabaseWrapperSQLite = { type: "SQLITE", db: new SQLite(`${model.tableName}.db`) };
			database.db = db;

			const columns = Object.entries(model.columns)
				.map(([name, def]) => {
					let sql = `${name} ${def.type}`;
					if (def.primary) sql += " PRIMARY KEY";
					if (def.default !== undefined) sql += ` DEFAULT ${def.default}`;
					return sql;
				})
				.join(", ");

			database.db.db.exec(`CREATE TABLE IF NOT EXISTS ${model.tableName} (${columns})`);

			Object.entries(model.columns).forEach(([name, def]) => addColumnIfNotExists(db.db, model.tableName, name, def.type));
		} else {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				console.log(`Database: ${model.tableName}DB: Opening IndexedDB Connection`);
				// @ts-expect-error:
				const request = indexedDB.open(model.tableName, 2);
				request.onupgradeneeded = (event): void => {
					console.log(`Database: ${model.tableName}DB: On Upgrade Needed`);
					// @ts-expect-error:
					if (!event.target.result.objectStoreNames.contains(model.tableName)) {
						// @ts-expect-error:
						const objectStore = event.target.result.createObjectStore(model.tableName, {
							keyPath: Object.entries(model.columns).find(([_, def]) => def.primary)?.[0],
						});

						// Create indexes for all columns
						Object.entries(model.columns).forEach(([name, def]) => {
							objectStore.createIndex(name, name, { unique: !!def.unique });
						});
					}
				};
				request.onsuccess = () => {
					console.log(`Database: ${model.tableName}DB: On Success`);
					resolve(request.result as unknown as IDBDatabase);
				};
				request.onerror = () => {
					console.error(`Database: ${model.tableName}DB error:`, request.error);
					reject(request.error);
				};
				request.onblocked = () => {
					console.error(`Database: ${model.tableName}DB: Blocked. Close other tabs with this site open.`);
				};
			});
			database.db = { type: "INDEXEDDB", db: db };
		}

		return database;
	}

	getPrimaryKey(): keyof T["columns"] & string {
		const primaryKeyEntry = Object.entries(this.model.columns).find(([_, def]) => def.primary);
		if (!primaryKeyEntry) throw new Error("No primary key defined in model");
		return primaryKeyEntry[0];
	}

	objectStore(): IDBObjectStore {
		if (this.db.type !== "INDEXEDDB") throw new Error("Wrong DB type when calling objectStore");
		return this.db.db.transaction(this.model.tableName, "readwrite").objectStore(this.model.tableName);
	}

	select<K extends keyof DatabaseModal<T>>(
		where?: { key: K & string; value: NonNullable<DatabaseModal<T>[K]> & (string | number) } | undefined,
		orderBy?: { key: K & string; direction: "ASC" | "DESC" } | "RANDOM" | undefined,
	): Promise<DatabaseModal<T>[]> {
		if (this.db.type === "SQLITE") {
			let query = `SELECT * FROM ${this.model.tableName}`;
			const params: (string | number | boolean)[] = [];

			if (where) {
				query += ` WHERE ${where.key} = ?`;
				params.push(where.value);
			}

			if (orderBy) {
				if (orderBy === "RANDOM") query += ` ORDER BY RANDOM()`;
				else query += ` ORDER BY ${orderBy.key} ${orderBy.direction}`;
			}
			const results = this.db.db.prepare(query).all(params) as unknown as DatabaseModal<T>[];
			return new Promise((resolve) => resolve(results));
		} else if (this.db.type === "INDEXEDDB") {
			return new Promise((resolve, reject) => {
				if (this.db.type !== "INDEXEDDB") return;
				const request = where ? this.objectStore().index(where.key.toString()).openCursor(where.value) : this.objectStore().openCursor();
				const results: DatabaseModal<T>[] = [];

				request.onsuccess = (event: Event) => {
					const target = event.target as IDBRequest<IDBCursorWithValue | null>;
					const cursor = target.result;
					if (cursor) {
						results.push(cursor.value);
						cursor.continue();
					} else {
						if (orderBy) {
							results.sort((a, b) => {
								if (!orderBy) return 0;
								if (orderBy === "RANDOM") return Math.random() - 0.5;
								const aValue = a[orderBy.key];
								const bValue = b[orderBy.key];

								if (orderBy.direction === "ASC") {
									return String(aValue ?? 0) > String(bValue ?? 0) ? 1 : -1;
								} else {
									return String(aValue ?? 0) < String(bValue ?? 0) ? 1 : -1;
								}
							});
						}
						resolve(results);
					}
				};

				request.onerror = (event: Event) => {
					const target = event.target as IDBRequest<IDBCursorWithValue | null>;
					reject(target.error);
				};
			});
		} else return new Promise((resolve) => resolve([]));
	}

	insert(values: Partial<DatabaseModal<T>>): true | ErrorMissingRequiredProperty {
		if (typeof this === "undefined") throw new ErrorNotInitialised();
		const file = this.withDefaults(values);
		if (file instanceof ErrorMissingRequiredProperty) return file;

		if (this._client.config.logLevel === "verbose") console.log(`Database: ${this.model.tableName}  Record INSERTed`, values);
		else console.log(`Database: ${this.model.tableName}  Record INSERTed`);

		if (this.db.type === "SQLITE") {
			const columns = Object.keys(this.model.columns);
			const placeholders = columns.map(() => "?").join(", ");
			const query = `INSERT INTO ${this.model.tableName} (${columns.join(", ")}) VALUES (${placeholders})`;
			const params = columns.map((column) => {
				const value = file[column as keyof DatabaseModal<T>];
				return value === null ? null : String(value);
			});

			this.db.db.exec(query, ...params);
		} else if (this.db.type === "INDEXEDDB") {
			const request = this.objectStore().add(file);

			request.onerror = (event) => {
				// @ts-expect-error:
				throw event.target.error;
			};

			this.objectStore().add(file);
		}

		return true;
	}

	async update(primaryKeyValue: DatabaseModal<T>[keyof T["columns"]] & string, updates: DatabaseModal<T>): Promise<true | ErrorNotFound | ErrorMissingRequiredProperty> {
		const primaryKey = this.getPrimaryKey();
		const newFile = this.withDefaults(updates);
		if (newFile instanceof ErrorMissingRequiredProperty) throw new ErrorMissingRequiredProperty();
		updates.updatedAt = new Date().toISOString();

		// Get the current file attributes before updating
		const currentFile = (await this.select({ key: primaryKey, value: primaryKeyValue }))[0];
		if (!currentFile) {
			console.error(`File:     ${primaryKeyValue}  Mot found when updating`);
			throw new ErrorNotFound();
		}

		const updatedColumn = [];
		const params = [];
		const keys: Array<keyof typeof newFile> = Object.keys(newFile);
		const defaultValues = this.getDefaultValues();
		if (defaultValues instanceof ErrorMissingRequiredProperty) throw new ErrorMissingRequiredProperty();

		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			if (newFile[key] !== undefined && newFile[key] !== null && newFile[key] !== currentFile[key] && newFile[key] !== defaultValues[key]) {
				if (!Object.keys(defaultValues).includes(String(key)) || (key === "name" && newFile[key] === "File")) continue;
				updatedColumn.push(key);
				params.push(newFile[key]);
			}
		}

		if (updatedColumn.length <= 1) {
			console.warn("Unnecessary DB update");
			return true;
		}

		if (this.db.type === "SQLITE") {
			params.push(primaryKeyValue);
			const query = `UPDATE ${this.model.tableName} SET ${updatedColumn.map((column) => `${String(column)} = ?`).join(", ")} WHERE ${primaryKey} = ?`;
			this.db.db.prepare(query).values(params);
			console.log(
				`File:     ${primaryKeyValue}  File UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._client.config.logLevel === "verbose" ? ` - Params: ${params.join(", ")}  - Query: ${query}` : ""),
				this._client.config.logLevel === "verbose" ? console.log(`File:     ${primaryKeyValue}`) : "",
			);
		} else {
			if (this.db.type === "INDEXEDDB") this.objectStore().put(Object.fromEntries(Object.entries(newFile).filter(([key]) => !key.startsWith("_")))).onerror = console.error;
			console.log(
				`this:     ${primaryKeyValue}  File UPDATEd - Updated Columns: ${updatedColumn.join(", ")}` + (this._client.config.logLevel === "verbose" ? ` - Params: ${params.join(", ")}` : ""),
				this._client.config.logLevel === "verbose" ? console.log(`File:     ${primaryKeyValue}`) : "",
			);
		}
		return true;
	}

	delete(primaryKeyValue: string): void {
		const primaryKey = this.getPrimaryKey();
		const query = `DELETE FROM ${this.model.tableName} WHERE ${primaryKey} = ?`;

		if (this.db.type === "SQLITE") {
			this.db.db.exec(query, primaryKeyValue.toString());
		} else if (this.db.type === "INDEXEDDB") this.objectStore().delete(primaryKeyValue.toString()).onerror = console.error;
		console.log(`File:     ${primaryKeyValue}  File DELETEd`);
	}

	increment(primaryKeyValue: string, column: string): void {
		const primaryKey = this.getPrimaryKey();
		if (this.db.type === "SQLITE") this.db.db.prepare(`UPDATE ${this.model.tableName} set ${column} = ${column}+1 WHERE ${primaryKey} = ?`).values(primaryKeyValue.toString());
		else if (this.db.type === "INDEXEDDB") {
			const request = this.objectStore().get(primaryKeyValue.toString());
			request.onsuccess = (event) => {
				const target = event.target;
				if (!target) return;
				const file = (target as IDBRequest).result;
				if (file && this.db.type === "INDEXEDDB") {
					file[column] = (file[column] || 0) + 1;
					this.objectStore().put(file).onsuccess = () => console.log(`File:     ${primaryKeyValue}  Incremented ${column}`);
				}
			};
		}
	}

	count(): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db.type === "SQLITE") {
				const result = this.db.db.prepare(`SELECT COUNT(*) FROM ${this.model.tableName}`).value() as number[];
				return resolve(result[0]);
			}

			if (this.db.type === "UNDEFINED") return resolve(0);
			const request = this.objectStore().count();
			request.onsuccess = () => resolve(request.result);
			request.onerror = (event) => reject((event.target as IDBRequest).error);
		});
	}

	sum(column: string, where = ""): Promise<number> {
		return new Promise((resolve, reject) => {
			if (this.db.type === "SQLITE") {
				const result = this.db.db.prepare(`SELECT SUM(${column}) FROM ${this.model.tableName}${where.length !== 0 ? ` WHERE ${where}` : ""}`).value() as number[];
				return resolve(result === undefined ? 0 : result[0]);
			} else {
				if (this.db.type === "UNDEFINED") return resolve(0);
				let sum = 0;
				const request = this.objectStore().openCursor();

				request.onsuccess = (event) => {
					const target = event.target;
					if (!target) {
						reject(new Error("Event target is null"));
						return;
					}
					const cursor = (target as IDBRequest).result;
					if (cursor) {
						sum += cursor.value[column] || 0;
						cursor.continue();
					} else {
						resolve(sum);
					}
				};

				request.onerror = (event) => reject((event.target as IDBRequest).error);
			}
		}) as Promise<number>;
	}

	private getDefaultValues(): Partial<DatabaseModal<T>> {
		const defaults: Record<string, string | number | boolean> = {};
		Object.entries(this.model.columns).forEach(([key, def]) => {
			if (def.default !== undefined) defaults[key] = def.default;
		});
		return defaults as Partial<DatabaseModal<T>>;
	}

	withDefaults(values: Partial<DatabaseModal<T>>): DatabaseModal<T> | ErrorMissingRequiredProperty {
		const defaults = this.getDefaultValues();
		const now = new Date().toISOString();

		const result = {
			...defaults,
			...values,
			updatedAt: now,
		} as Partial<DatabaseModal<T>>;

		for (const [key, def] of Object.entries(this.model.columns)) {
			if (!def.default && !def.isNullable && result[key as keyof DatabaseModal<T>] === undefined) throw new ErrorMissingRequiredProperty(key);
		}

		return result as DatabaseModal<T>;
	}
}
