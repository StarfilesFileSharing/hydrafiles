import { ErrorNotFound, ErrorUnreachableCodeReached } from "../errors.ts";

interface FileHandle extends FileSystemFileHandle {
	remove(): Promise<void>;
}

interface DirectoryHandle extends FileSystemDirectoryHandle {
	values(): IterableIterator<FileSystemHandle>;
	getDirectoryHandle(path: string, options: { create: boolean }): Promise<DirectoryHandle>;
	getFileHandle(path: string, opts?: { create: boolean }): Promise<FileHandle>;
}

declare global {
	interface Window {
		showDirectoryPicker: () => Promise<DirectoryHandle>;
		handle?: DirectoryHandle;
	}
}

async function getDirectoryFromPath(rootHandle: DirectoryHandle, path: string, create = false): Promise<DirectoryHandle> {
	let currentHandle = rootHandle;
	for (const part of path.split("/").filter((part) => part.length > 0)) {
		currentHandle = await currentHandle.getDirectoryHandle(part, { create });
	}
	return currentHandle;
}

async function getFileFromPath(rootHandle: DirectoryHandle, path: string, create = false): Promise<FileHandle | ErrorUnreachableCodeReached> {
	const parts = path.split("/").filter((part) => part.length > 0);
	if (parts.length === 0) return new ErrorUnreachableCodeReached();

	let currentHandle = rootHandle;
	for (const part of parts) {
		currentHandle = await currentHandle.getDirectoryHandle(part, { create });
	}

	const fileName = parts.pop();
	if (typeof fileName === "undefined") return new ErrorNotFound();
	return await currentHandle.getFileHandle(fileName, { create });
}

export default class DirectoryHandleFileSystem {
	directoryHandle = async (): Promise<DirectoryHandle> => {
		if ("handle" in globalThis.window && typeof globalThis.window.handle !== "undefined") return globalThis.window.handle;
		const handle = await globalThis.window.showDirectoryPicker();
		globalThis.window.handle = handle;
		return handle;
	};

	exists = async (path: string): Promise<boolean> => {
		try {
			const rootHandle = await this.directoryHandle();
			if (path.endsWith("/")) await getDirectoryFromPath(rootHandle, path.replace(/\/+$/, ""), false);
			else await getFileFromPath(rootHandle, path, false);
			return true;
		} catch (e) {
			if ((e as Error).name === "NotFoundError") return false;
			throw e;
		}
	};

	mkdir = async (path: `${string}/`): Promise<void> => {
		if (await this.exists(path)) return;
		await getDirectoryFromPath(await this.directoryHandle(), path.replace(/\/+$/, ""), true);
	};

	readDir = async (path: `${string}/`): Promise<string[]> => {
		const entries: string[] = [];
		for await (const entry of (await getDirectoryFromPath(await this.directoryHandle(), path.replace(/\/+$/, ""), false)).values()) {
			entries.push(entry.name);
		}
		return entries;
	};

	readFile = async (path: string): Promise<Uint8Array | ErrorNotFound | ErrorUnreachableCodeReached> => {
		if (!await this.exists(path)) return new ErrorNotFound();

		const fileHandle = await getFileFromPath(await this.directoryHandle(), path);
		if (fileHandle instanceof ErrorUnreachableCodeReached) return fileHandle;

		const file = await fileHandle.getFile();
		return new Uint8Array(await file.arrayBuffer());
	};

	writeFile = async (path: string, data: Uint8Array): Promise<boolean | ErrorUnreachableCodeReached> => {
		const fileHandle = await getFileFromPath(await this.directoryHandle(), path, true);
		if (fileHandle instanceof ErrorUnreachableCodeReached) return fileHandle;

		const writable = await fileHandle.createWritable();
		await writable.write(data);
		await writable.close();
		return true;
	};

	getFileSize = async (path: string): Promise<number | ErrorUnreachableCodeReached> => {
		const fileHandle = await getFileFromPath(await this.directoryHandle(), path);
		if (fileHandle instanceof ErrorUnreachableCodeReached) return fileHandle;

		const file = await fileHandle.getFile();
		return file.size;
	};

	remove = async (path: string): Promise<true | ErrorUnreachableCodeReached> => {
		const fileHandle = await getFileFromPath(await this.directoryHandle(), path);
		if (fileHandle instanceof ErrorUnreachableCodeReached) return fileHandle;

		await fileHandle.remove();
		return true;
	};
}
