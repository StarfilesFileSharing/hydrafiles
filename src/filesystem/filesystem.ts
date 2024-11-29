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

	exists = (path: string) => this.fs ? this.fs.exists(`${join("./", path)}`) : new ErrorNotInitialised();
	mkdir = (path: `${string}/`) => this.fs ? this.fs.mkdir(`${join("./", path)}/`) : new ErrorNotInitialised();
	readFile = (path: string) => this.fs ? this.fs.readFile(`${join("./", path)}`) : new ErrorNotInitialised();
	writeFile = (path: string, data: Uint8Array) => this.fs ? this.fs.writeFile(`${join("./", path)}`, data) : new ErrorNotInitialised();
	getFileSize = (path: string) => this.fs ? this.fs.getFileSize(`${join("./", path)}`) : new ErrorNotInitialised();
	remove = (path: string) => this.fs ? this.fs.remove(`${join("./", path)}`) : new ErrorNotInitialised();
	readDir = async (path: `${string}/`) => this.fs ? (await this.fs.readDir(`${join("./", path)}/`)).filter((path) => !path.startsWith(".")) : new ErrorNotInitialised();
}
