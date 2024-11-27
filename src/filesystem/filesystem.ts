import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import { ErrorNotInitialised } from "../errors.ts";
import type Hydrafiles from "../hydrafiles.ts";
import DirectoryHandleFileSystem from "./DirectoryHandleFileSystem.ts";
import IndexedDBFileSystem from "./IndexedDBFileSystem.ts";
import StandardFileSystem from "./StandardFileSystem.ts";

export default class FileSystem {
	fs: StandardFileSystem | DirectoryHandleFileSystem | IndexedDBFileSystem;
	private _client: Hydrafiles;

	/**
	 * Use constructor or init to initialise class.
	 */
	constructor(client: Hydrafiles, fs: StandardFileSystem | DirectoryHandleFileSystem | IndexedDBFileSystem) {
		this.fs = fs;
		this._client = client;
	}

	static async init(client: Hydrafiles): Promise<FileSystem> {
		let fs: StandardFileSystem | DirectoryHandleFileSystem | IndexedDBFileSystem;
		if (typeof window === "undefined") fs = new StandardFileSystem();
		else if (typeof globalThis.window.showDirectoryPicker !== "undefined" && !client.config.dontUseFileSystemAPI) fs = await DirectoryHandleFileSystem.init();
		else fs = await IndexedDBFileSystem.init();

		return new FileSystem(client, fs);
	}

	exists = async (path: string) => this.fs ? await this.fs.exists(`${join(this._client.config.baseDir, path)}`) : new ErrorNotInitialised();
	mkdir = async (path: `${string}/`) => this.fs ? await this.fs.mkdir(`${join(this._client.config.baseDir, path)}/`) : new ErrorNotInitialised();
	readFile = async (path: string) => this.fs ? await this.fs.readFile(`${join(this._client.config.baseDir, path)}`) : new ErrorNotInitialised();
	writeFile = async (path: string, data: Uint8Array) => this.fs ? await this.fs.writeFile(`${join(this._client.config.baseDir, path)}`, data) : new ErrorNotInitialised();
	getFileSize = async (path: string) => this.fs ? await this.fs.getFileSize(`${join(this._client.config.baseDir, path)}`) : new ErrorNotInitialised();
	remove = async (path: string) => this.fs ? await this.fs.remove(`${join(this._client.config.baseDir, path)}`) : new ErrorNotInitialised();
	readDir = async (path: `${string}/`) => this.fs ? (await this.fs.readDir(`${join(this._client.config.baseDir, path)}/`)).filter((path) => !path.startsWith(".")) : new ErrorNotInitialised();
}
