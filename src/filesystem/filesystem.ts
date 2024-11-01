import type Hydrafiles from "../hydrafiles.ts";
import DirectoryHandleFileSystem from "./DirectoryHandleFileSystem.ts";
import IndexedDBFileSystem from "./IndexedDBFileSystem.ts";
import StandardFileSystem from "./StandardFileSystem.ts";

export default class FileSystem {
	fs!: StandardFileSystem | DirectoryHandleFileSystem | IndexedDBFileSystem;
	constructor(client: Hydrafiles) {
		const fs = typeof window === "undefined" ? StandardFileSystem : (typeof globalThis.window.showDirectoryPicker !== "undefined" && !client.config.dontUseFileSystemAPI ? DirectoryHandleFileSystem : IndexedDBFileSystem);
		this.fs = new fs();
		if (this.fs instanceof IndexedDBFileSystem) this.fs.dbPromise = this.fs.initDB();
	}
	exists = async (path: string) => this.fs ? await this.fs.exists(path) : false;
	mkdir = async (path: string) => this.fs ? await this.fs.mkdir(path) : false;
	readDir = async (path: string) => this.fs ? await this.fs.readDir(path) : [];
	readFile = async (path: string) => this.fs ? await this.fs.readFile(path) : false;
	writeFile = async (path: string, data: Uint8Array) => this.fs ? await this.fs.writeFile(path, data) : false;
	getFileSize = async (path: string) => this.fs ? await this.fs.getFileSize(path) : false;
	remove = async (path: string) => this.fs ? await this.fs.remove(path) : false;
}
