import DirectoryHandleFileSystem from "./DirectoryHandleFileSystem.ts";
import IndexedDBFileSystem from "./IndexedDBFileSystem.ts";
import StandardFileSystem from "./StandardFileSystem.ts";

const fs = typeof window === "undefined" ? StandardFileSystem : (typeof globalThis.window.showDirectoryPicker !== "undefined" ? DirectoryHandleFileSystem : IndexedDBFileSystem);

if (typeof IndexedDBFileSystem === typeof fs && "dbPromise" in fs) fs.dbPromise = IndexedDBFileSystem.initDB();

export default class FileSystem {
	static exists = async (path: string) => fs ? await fs.exists(path) : false;
	static mkdir = async (path: string) => fs ? await fs.mkdir(path) : false;
	static readDir = async (path: string) => fs ? await fs.readDir(path) : [];
	static readFile = async (path: string) => fs ? await fs.readFile(path) : false;
	static writeFile = async (path: string, data: Uint8Array) => fs ? await fs.writeFile(path, data) : false;
	static getFileSize = async (path: string) => fs ? await fs.getFileSize(path) : false;
	static remove = async (path: string) => fs ? await fs.remove(path) : false;
}
