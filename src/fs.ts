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

declare global {
	interface Window {
		showDirectoryPicker: () => Promise<DirectoryHandle>;
	}
}

class FS {
	init = false;
	directoryHandle: DirectoryHandle | undefined;
	constructor() {
		this.initialize();
	}
	initialize = async () => {
		if (typeof window !== "undefined") {
			this.directoryHandle = await globalThis.window.showDirectoryPicker();
		}
		this.init = true;
	};

	mkdir = async (path: string) => {
		if (!this.init) throw new Error("FS not initialized");
		if (this.directoryHandle !== undefined) await this.directoryHandle.getDirectoryHandle(path, { create: true });
		else await Deno.mkdir(path);
	};

	readDir = async (path: string): Promise<string[]> => {
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
		if (!this.init) throw new Error("FS not initialized");
		if (this.directoryHandle !== undefined) {
			const fileHandle = await this.directoryHandle.getFileHandle(path);
			const file = await fileHandle.getFile();
			return new Uint8Array(await file.arrayBuffer());
		} else return await Deno.readFile(path);
	};

	writeFile = async (path: string, data: Uint8Array) => {
		if (!this.init) throw new Error("FS not initialized");
		if (this.directoryHandle !== undefined) {
			const fileHandle = await this.directoryHandle.getFileHandle(path, { create: true });
			const writable = await fileHandle.createWritable();
			await writable.write(data);
			await writable.close();
		} else {
			await Deno.writeFile(path, data);
		}
	};

	exists = async (path: string): Promise<boolean> => {
		if (!this.init) throw new Error("FS not initialized");

		try {
			if (this.directoryHandle !== undefined) {
				await this.directoryHandle.getFileHandle(path);
				return true; // File exists
			} else {
				await Deno.stat(path);
				return true; // File exists
			}
		} catch (e) {
			const error = e as Error;
			if (this.directoryHandle !== undefined && error.name === "NotFoundError") {
				return false; // File not found in the web environment
			}
			if (error instanceof Deno.errors.NotFound) {
				return false; // File not found in Deno environment
			}
			throw error; // Re-throw unexpected errors
		}
	};

	getFileSize = async (path: string): Promise<number> => {
		if (!this.init) throw new Error("FS not initialized");

		if (this.directoryHandle !== undefined) {
			try {
				const fileHandle = await this.directoryHandle.getFileHandle(path);
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
				const fileHandle = await this.directoryHandle.getFileHandle(path);
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
