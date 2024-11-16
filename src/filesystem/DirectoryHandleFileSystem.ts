import { ErrorNotFound, ErrorUnreachableCodeReached } from "../errors.ts";

interface FileHandle extends FileSystemFileHandle {
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
		handle?: DirectoryHandle;
	}
}

async function getFileHandle(directoryHandle: DirectoryHandle, path: string, touch = false): Promise<FileHandle | ErrorUnreachableCodeReached> {
	const parts = path.split("/");
	let currentHandle = directoryHandle;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];

		if (i === parts.length - 1) return await currentHandle.getFileHandle(part, { create: touch });
		else currentHandle = await currentHandle.getDirectoryHandle(part, { create: true });
	}

	return new ErrorUnreachableCodeReached();
}

export default class DirectoryHandleFileSystem {
	directoryHandle = async () => {
		if ("handle" in globalThis.window && typeof globalThis.window.handle !== "undefined") return globalThis.window.handle;
		const handle = await globalThis.window.showDirectoryPicker();
		globalThis.window.handle = handle;
		return handle;
	};

	exists = async (path: string): Promise<boolean | ErrorNotFound> => {
		try {
			await getFileHandle(await this.directoryHandle(), path);
			return true;
		} catch (e) {
			const error = e as Error;
			if (error.name === "TypeMismatchError") return true;
			else if (error.name === "NotFoundError") return new ErrorNotFound();
			throw error;
		}
	};

	mkdir = async (path: string) => {
		if (await this.exists(path)) return;
		await (await this.directoryHandle()).getDirectoryHandle(path, { create: true });
	};

	readDir = async (path: string): Promise<string[]> => {
		const entries: string[] = [];
		const dirHandle = await (await this.directoryHandle()).getDirectoryHandle(path, { create: false });
		for await (const entry of dirHandle.values()) {
			entries.push(entry.name);
		}
		return entries;
	};

	readFile = async (path: string): Promise<Uint8Array | ErrorNotFound | ErrorUnreachableCodeReached> => {
		if (!await this.exists(path)) return new ErrorNotFound();
		const fileHandle = await getFileHandle(await this.directoryHandle(), path);
		if (fileHandle instanceof ErrorUnreachableCodeReached) return fileHandle;
		const file = await fileHandle.getFile();
		return new Uint8Array(await file.arrayBuffer());
	};

	writeFile = async (path: string, data: Uint8Array): Promise<boolean | ErrorUnreachableCodeReached> => {
		const fileHandle = await getFileHandle(await this.directoryHandle(), path, true);
		if (fileHandle instanceof ErrorUnreachableCodeReached) return fileHandle;
		const writable = await fileHandle.createWritable();
		await writable.write(data);
		await writable.close();
		return true;
	};

	getFileSize = async (path: string): Promise<number | ErrorUnreachableCodeReached> => {
		const fileHandle = await getFileHandle(await this.directoryHandle(), path);
		if (fileHandle instanceof ErrorUnreachableCodeReached) return fileHandle;
		const file = await fileHandle.getFile();
		return file.size;
	};

	remove = async (path: string): Promise<true | ErrorUnreachableCodeReached> => {
		const fileHandle = await getFileHandle(await this.directoryHandle(), path);
		if (fileHandle instanceof ErrorUnreachableCodeReached) return fileHandle;
		await fileHandle.remove();
		return true;
	};
}
