import type { indexedDB } from "https://deno.land/x/indexeddb@v1.1.0/ponyfill.ts";
import { ErrorFailedToReadFile } from "../errors.ts";

export default class IndexedDBFileSystem {
	dbName = "FileSystemDB";
	storeName = "files";
	dbPromise!: Promise<IDBDatabase>;

	initDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			// @ts-expect-error:
			const request = indexedDB.open(this.dbName, 1);
			request.onupgradeneeded = (event) => {
				const target = event.target;
				if (!target) {
					reject(new Error("Failed to open IndexedDB"));
					return;
				}
				// @ts-expect-error:
				const db = target.result;
				db.createObjectStore(this.storeName, { keyPath: "path" });
			};
			// @ts-expect-error:
			request.onsuccess = (event) => resolve(event.target.result);
			// @ts-expect-error:
			request.onerror = (event) => reject(event.target.error);
		});
	}

	async exists(path: string): Promise<boolean> {
		const db = await this.dbPromise;
		return new Promise((resolve) => {
			const transaction = db.transaction(this.storeName, "readonly");
			const store = transaction.objectStore(this.storeName);
			const request = store.get(path);
			request.onsuccess = () => resolve(request.result !== undefined);
			request.onerror = () => resolve(false);
		});
	}

	async mkdir(_path: string): Promise<void> {}

	async readDir(path: `${string}/`): Promise<string[]> {
		const db = await this.dbPromise;
		const files: string[] = [];

		return new Promise((resolve) => {
			const transaction = db.transaction(this.storeName, "readonly");
			const store = transaction.objectStore(this.storeName);
			const request = store.openCursor();

			request.onsuccess = (event) => {
				// @ts-expect-error:
				const cursor = event.target.result;
				if (cursor) {
					if (cursor.value.path.startsWith(path + "/")) {
						files.push(cursor.value.path.replace(path + "/", ""));
					}
					cursor.continue();
				} else {
					resolve(files);
				}
			};
		});
	}

	async readFile(path: string): Promise<Uint8Array | ErrorFailedToReadFile> {
		const db = await this.dbPromise;
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(this.storeName, "readonly");
			const store = transaction.objectStore(this.storeName);
			const request = store.get(path);
			request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result.data) : new ErrorFailedToReadFile());
			request.onerror = () => reject(new Error(`Error reading ${path}`));
		});
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		const db = await this.dbPromise;
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(this.storeName, "readwrite");
			const store = transaction.objectStore(this.storeName);
			const fileData = { path, data: data.buffer };

			const request = store.put(fileData);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(new Error(`Error writing ${path}`));
		});
	}

	async getFileSize(path: string): Promise<number> {
		const db = await this.dbPromise;
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(this.storeName, "readonly");
			const store = transaction.objectStore(this.storeName);
			const request = store.get(path);
			request.onsuccess = () => {
				if (request.result) {
					resolve(request.result.data.byteLength);
				} else {
					reject(new Error(`${path} doesn't exist`));
				}
			};
			request.onerror = () => reject(new Error(`Error retrieving size of ${path}`));
		});
	}

	async remove(path: string): Promise<void> {
		const db = await this.dbPromise;
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(this.storeName, "readwrite");
			const store = transaction.objectStore(this.storeName);
			const request = store.delete(path);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(new Error(`Error removing ${path}`));
		});
	}
}
