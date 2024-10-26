interface FileHandle extends FileSystemFileHandle {
	remove(): Promise<void>; // Returns a Promise that resolves when the file is removed.
}

interface DirectoryHandle extends FileSystemDirectoryHandle {
	values(): IterableIterator<FileSystemHandle>; // Returns an iterator of FileSystemHandle objects for the directory's contents.
	getDirectoryHandle(path: string, options: { create: boolean }): Promise<DirectoryHandle>; // Returns a Promise that resolves to a DirectoryHandle for the specified path, creating it if specified.
	getFileHandle(path: string, opts?: { create: boolean }): Promise<FileHandle>; // Returns a Promise that resolves to a FileHandle for the specified file path.
}

async function getFileHandle(directoryHandle: DirectoryHandle, path: string, touch = false): Promise<FileHandle> {
	const parts = path.split("/");
	let currentHandle = directoryHandle;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];

		if (i === parts.length - 1) return await currentHandle.getFileHandle(part, { create: touch });
		else currentHandle = await currentHandle.getDirectoryHandle(part, { create: true });
	}

	throw new Error("Unreachable code reached");
}

declare global {
	interface Window {
		showDirectoryPicker: () => Promise<DirectoryHandle>;
	}
}

class FileSystem {
	fs: DirectoryHandleFileSystem | StandardFileSystem;

	constructor() {
		if (typeof window === "undefined") this.fs = new StandardFileSystem();
		else if (typeof globalThis.window.showDirectoryPicker !== "undefined") this.fs = new DirectoryHandleFileSystem();
		else throw new Error("Unsupported platform");
	}

	exists = async (path: string): Promise<boolean> => await this.fs.exists(path);
	mkdir = async (path: string) => await this.fs.mkdir(path);
	readDir = async (path: string): Promise<string[]> => await this.fs.readDir(path);
	readFile = async (path: string): Promise<Uint8Array> => await this.fs.readFile(path);
	writeFile = async (path: string, data: Uint8Array): Promise<void> => await this.fs.writeFile(path, data);
	getFileSize = async (path: string): Promise<number> => await this.fs.getFileSize(path);
	remove = async (path: string) => await this.fs.remove(path);
}

class StandardFileSystem {
	exists = async (path: string): Promise<boolean> => {
		try {
			await Deno.stat(path);
			return true;
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) return false;
			console.error((e as Error).message);
			throw e;
		}
	};

	mkdir = async (path: string) => {
		if (await this.exists(path)) return;
		await Deno.mkdir(path);
	};

	readDir = async (path: string): Promise<string[]> => {
		const entries: string[] = [];
		for await (const entry of Deno.readDir(path)) {
			entries.push(entry.name);
		}
		return entries;
	};

	readFile = async (path: string): Promise<Uint8Array> => {
		if (!await this.exists(path)) throw new Error(`${path} File doesn't exist`);
		return await Deno.readFile(path);
	};

	writeFile = async (path: string, data: Uint8Array): Promise<void> => {
		await Deno.writeFile(path, data);
	};

	getFileSize = async (path: string): Promise<number> => {
		const fileInfo = await Deno.stat(path);
		return fileInfo.size;
	};

	remove = async (path: string) => {
		await Deno.remove(path);
	};
}

class DirectoryHandleFileSystem {
	directoryHandle = globalThis.window.showDirectoryPicker();

	exists = async (path: string): Promise<boolean> => {
		try {
			await getFileHandle(await this.directoryHandle, path);
			return true;
		} catch (e) {
			const error = e as Error;
			if (error.name === "TypeMismatchError") return true;
			else if (error.name === "NotFoundError") return false;
			throw error;
		}
	};

	mkdir = async (path: string) => {
		if (await this.exists(path)) return;
		await (await this.directoryHandle).getDirectoryHandle(path, { create: true });
	};

	readDir = async (path: string): Promise<string[]> => {
		const entries: string[] = [];
		const dirHandle = await (await this.directoryHandle).getDirectoryHandle(path, { create: false });
		for await (const entry of dirHandle.values()) {
			entries.push(entry.name);
		}
		return entries;
	};

	readFile = async (path: string): Promise<Uint8Array> => {
		if (!await this.exists(path)) throw new Error(`${path} File doesn't exist`);
		const fileHandle = await getFileHandle(await this.directoryHandle, path);
		const file = await fileHandle.getFile();
		return new Uint8Array(await file.arrayBuffer());
	};

	writeFile = async (path: string, data: Uint8Array): Promise<void> => {
		const fileHandle = await getFileHandle(await this.directoryHandle, path, true);
		const writable = await fileHandle.createWritable();
		await writable.write(data);
		await writable.close();
	};

	getFileSize = async (path: string): Promise<number> => {
		const fileHandle = await getFileHandle(await this.directoryHandle, path);
		const file = await fileHandle.getFile();
		return file.size;
	};

	remove = async (path: string) => {
		const fileHandle = await getFileHandle(await this.directoryHandle, path);
		await fileHandle.remove();
	};
}

export default FileSystem;
