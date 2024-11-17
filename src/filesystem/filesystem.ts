import { ErrorNotInitialised } from "../errors.ts";
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
	exists = async (path: string) => this.fs ? await this.fs.exists(path) : new ErrorNotInitialised();
	mkdir = async (path: `${string}/`) => this.fs ? await this.fs.mkdir(path) : new ErrorNotInitialised();
	readDir = async (path: `${string}/`) => this.fs ? await this.fs.readDir(path) : new ErrorNotInitialised();
	readFile = async (path: string) => this.fs ? await this.fs.readFile(path) : new ErrorNotInitialised();
	writeFile = async (path: string, data: Uint8Array) => this.fs ? await this.fs.writeFile(path, data) : new ErrorNotInitialised();
	getFileSize = async (path: string) => this.fs ? await this.fs.getFileSize(path) : new ErrorNotInitialised();
	remove = async (path: string) => this.fs ? await this.fs.remove(path) : new ErrorNotInitialised();
}
