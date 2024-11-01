export default class StandardFileSystem {
	static exists = async (path: string): Promise<boolean> => {
		try {
			await Deno.stat(path);
			return true;
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) return false;
			console.error((e as Error).message);
			throw e;
		}
	};

	static mkdir = async (path: string) => {
		if (await this.exists(path)) return;
		await Deno.mkdir(path);
	};

	static readDir = async (path: string): Promise<string[]> => {
		const entries: string[] = [];
		for await (const entry of Deno.readDir(path)) {
			entries.push(entry.name);
		}
		return entries;
	};

	static readFile = async (path: string): Promise<Uint8Array> => {
		if (!await this.exists(path)) throw new Error(`${path} File doesn't exist`);
		return await Deno.readFile(path);
	};

	static writeFile = async (path: string, data: Uint8Array): Promise<void> => {
		await Deno.writeFile(path, data);
	};

	static getFileSize = async (path: string): Promise<number> => {
		const fileInfo = await Deno.stat(path);
		return fileInfo.size;
	};

	static remove = async (path: string) => {
		await Deno.remove(path);
	};
}