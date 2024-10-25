interface FileHandle extends FileSystemFileHandle {
	getFile(): Promise<File>; // Returns a Promise that resolves to a File object.
	// createWritable(): Promise<WritableStream>; // Returns a Promise that resolves to a WritableFileStream for writing to the file.
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

class FS {
	init = false;
	directoryHandle: DirectoryHandle | undefined;

	static initialize = async (): Promise<FS> => {
		const fs = new FS();
		if (typeof window !== "undefined") fs.directoryHandle = await globalThis.window.showDirectoryPicker();
		fs.init = true;
		return fs;
	};

	mkdir = async (path: string) => {
		console.log(`mkdir ${path}`);
		if (await this.exists(path)) return;
		if (!this.init) throw new Error("FS not initialized");
		if (this.directoryHandle !== undefined) await this.directoryHandle.getDirectoryHandle(path, { create: true });
		else await Deno.mkdir(path);
	};

	readDir = async (path: string): Promise<string[]> => {
		console.log(`readdir ${path}`);
		if (!this.init) throw new Error("FS not initialized");
		const entries: string[] = [];

		if (this.directoryHandle !== undefined) {
			const dirHandle = await this.directoryHandle.getDirectoryHandle(path, { create: false });
			for await (const entry of dirHandle.values()) {
				// Check if the entry is a file
				if (entry.kind === "file") {
					console.log("File:", entry.name);
				}
			}
		} else {
			for await (const entry of Deno.readDir(path)) {
				entries.push(entry.name); // Collects the names of entries in Deno
			}
		}

		return entries;
	};

	readFile = async (path: string): Promise<Uint8Array> => {
		console.log(`${path} Reading from file`);
		if (!this.init) throw new Error("FS not initialized");
		if (!await this.exists(path)) throw new Error(`${path} File doesn't exist`);
		if (this.directoryHandle !== undefined) {
			const fileHandle = await getFileHandle(this.directoryHandle, path);
			const file = await fileHandle.getFile();
			return new Uint8Array(await file.arrayBuffer());
		} else return await Deno.readFile(path);
	};

	writeFile = async (path: string, data: Uint8Array) => {
		console.log(`${path} Writing to file`);
		if (!this.init) throw new Error("FS not initialized");
		if (this.directoryHandle !== undefined) {
			const fileHandle = await getFileHandle(this.directoryHandle, path, true);
			const writable = await fileHandle.createWritable();
			await writable.write(data);
			await writable.close();
		} else {
			await Deno.writeFile(path, data);
		}
	};

	exists = async (path: string): Promise<boolean> => {
		if (!this.init) throw new Error("FS not initialized");

		console.log(`${path} Check if exists`);
		try {
			if (this.directoryHandle !== undefined) {
				try {
					await getFileHandle(this.directoryHandle, path);
				} catch (err) {
					const fileError = err as Error;
					if (fileError.name !== "TypeMismatchError") throw fileError;
				}
			} else await Deno.stat(path);
			console.log(`${path} Does exist`);
			return true;
		} catch (e) {
			console.log(`${path} Doesn't exist`);
			const error = e as Error;
			if (this.directoryHandle !== undefined && error.name === "NotFoundError") return false;
			if (typeof window === "undefined" && error instanceof Deno.errors.NotFound) return false;
			console.error(error.message);
			throw error;
		}
	};

	getFileSize = async (path: string): Promise<number> => {
		console.log(`${path} Getting file size`);
		if (!this.init) throw new Error("FS not initialized");

		if (this.directoryHandle !== undefined) {
			try {
				const fileHandle = await getFileHandle(this.directoryHandle, path);
				const file = await fileHandle.getFile();
				return file.size; // Return file size in bytes
			} catch (e) {
				const error = e as Error;
				if (error.name === "NotFoundError") {
					throw new Error(`File "${path}" does not exist.`);
				}
				throw error; // Re-throw unexpected errors
			}
		} else {
			const fileInfo = await Deno.stat(path);
			return fileInfo.size; // Return file size in bytes
		}
	};

	remove = async (path: string) => {
		if (!this.init) throw new Error("FS not initialized");

		if (this.directoryHandle !== undefined) {
			try {
				const fileHandle = await getFileHandle(this.directoryHandle, path);
				await fileHandle.remove(); // Remove the file
			} catch (e) {
				const error = e as Error;
				if (error.name === "NotFoundError") {
					throw new Error(`File "${path}" does not exist.`);
				}
				throw error; // Re-throw unexpected errors
			}
		} else {
			try {
				await Deno.remove(path); // Remove the file or directory
			} catch (error) {
				if (error instanceof Deno.errors.NotFound) {
					throw new Error(`File "${path}" does not exist.`);
				}
				throw error; // Re-throw unexpected errors
			}
		}
	};
}

export default FS;
