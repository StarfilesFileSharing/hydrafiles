import { ErrorNotFound } from "../errors.ts";

export default class StandardFileSystem {
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

	mkdir = async (path: `${string}/`) => {
		if (await this.exists(path)) return;
		await Deno.mkdir(path);
	};

	readDir = async (path: `${string}/`): Promise<string[]> => {
		const entries: string[] = [];
		for await (const entry of Deno.readDir(path)) {
			entries.push(entry.name);
		}
		return entries;
	};

	readFile = async (path: string): Promise<Uint8Array | ErrorNotFound> => {
		if (!await this.exists(path)) return new ErrorNotFound();
		return await Deno.readFile(path);
	};

	writeFile = async (path: string, data: Uint8Array): Promise<void> => {
		await Deno.writeFile(path, data);
	};

	getFileSize = async (path: string): Promise<number | ErrorNotFound> => {
		try {
			const fileInfo = await Deno.stat(path);
			return fileInfo.size;
		} catch (e) {
			if ((e as Error).name === "NotFound") return new ErrorNotFound();
			throw e;
		}
	};

	remove = async (path: string) => {
		await Deno.remove(path);
	};
}
