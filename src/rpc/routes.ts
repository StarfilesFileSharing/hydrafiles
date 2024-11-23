import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { WSMessage } from "./peers/rtc.ts";
import { File } from "../file.ts";
import type { PeerAttributes } from "./peers/http.ts";
import Utils, { type Sha256 } from "../utils.ts";
import type Hydrafiles from "../hydrafiles.ts";
import { ErrorNotFound } from "../errors.ts";

export class DecodedResponse {
	body: string | Uint8Array;
	headers: { [key: string]: string };
	status: number;
	ok: boolean;

	constructor(body: string | Uint8Array, init: { headers?: { [key: string]: string }; status?: number } = {}) {
		this.body = body;
		this.headers = init.headers ?? {};
		this.status = init.status ?? 200;
		this.ok = this.status >= 100 && this.status <= 400;
	}

	static async from(response: Response): Promise<DecodedResponse> {
		const body = await response.arrayBuffer();
		const headers: { [key: string]: string } = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});
		return new DecodedResponse(new Uint8Array(body), { headers, status: response.status });
	}

	response(): Response {
		return new Response(this.body === null ? "" : this.body, { headers: this.headers, status: this.status });
	}

	text(): string {
		return typeof this.body === "string" ? this.body : new TextDecoder().decode(this.body);
	}

	arrayBuffer(): ArrayBuffer {
		return this.body instanceof Uint8Array ? this.body.buffer : new TextEncoder().encode(this.body).buffer;
	}
}

export const router = new Map<string, (req: Request, client: Hydrafiles) => Promise<DecodedResponse> | DecodedResponse>();
export const sockets: { id: string; socket: WebSocket }[] = [];

export const pendingWSRequests = new Map<number, (response: DecodedResponse) => void>();
export const processingDownloads = new Map<string, Promise<DecodedResponse | ErrorNotFound>>();

router.set("WS", (req) => {
	const { socket, response } = Deno.upgradeWebSocket(req);
	sockets.push({ socket, id: "" });

	socket.addEventListener("message", ({ data }) => {
		const message = JSON.parse(data) as WSMessage | null;
		if (message === null) return;
		if ("response" in message) {
			const resolve = pendingWSRequests.get(message.id);
			if (resolve) {
				const { status, headers, body } = message.response;
				resolve(new DecodedResponse(body, { status, headers }));
				pendingWSRequests.delete(message.id);
			}
		}
		for (let i = 0; i < sockets.length; i++) {
			if (sockets[i].socket !== socket && (!("to" in message) || message.to === sockets[i].id)) {
				if (sockets[i].socket.readyState === 1) sockets[i].socket.send(data);
			} else if ("from" in message) {
				sockets[i].id = message.from;
			}
		}
	});

	return DecodedResponse.from(response);
});

router.set("/status", () => {
	const headers = {
		"Content-Type": "application/json",
	};
	return new DecodedResponse(JSON.stringify({ status: true }), { headers });
});

router.set("/hydrafiles-web.esm.js", async (_, client) => {
	const headers = {
		"Content-Type": "application/javascript",
		"Cache-Control": "public, max-age=300",
	};
	const fileContent = await client.fs.readFile("build/hydrafiles-web.esm.js");
	if (fileContent instanceof Error) return new DecodedResponse("File gone", { status: 403 });
	return new DecodedResponse(fileContent, { headers });
});

router.set("/dashboard.js", async (_, client) => {
	const headers = {
		"Content-Type": "application/javascript",
		"Cache-Control": "public, max-age=300",
	};
	const fileContent = await client.fs.readFile("build/dashboard.js");
	if (fileContent instanceof Error) return new DecodedResponse("File not found", { status: 404 });
	return new DecodedResponse(fileContent, { headers });
});

router.set("/hydrafiles-web.esm.js.map", async (_, client) => {
	const headers = {
		"Content-Type": "application/json",
		"Cache-Control": "public, max-age=300",
	};
	const fileContent = await client.fs.readFile("build/hydrafiles-web.esm.js.map");
	if (fileContent instanceof Error) return new DecodedResponse("File not found", { status: 404 });
	return new DecodedResponse(fileContent, { headers });
});

router.set("/dashboard.js.map", async (_, client) => {
	const headers = {
		"Content-Type": "application/json",
		"Cache-Control": "public, max-age=300",
	};
	const fileContent = await client.fs.readFile("build/dashboard.js.map");
	if (fileContent instanceof Error) return new DecodedResponse("File not found", { status: 404 });
	return new DecodedResponse(fileContent, { headers });
});

router.set("/peers", (_, client) => {
	const headers = {
		"Content-Type": "application/json",
		"Cache-Control": "public, max-age=300",
	};
	return new DecodedResponse(
		JSON.stringify(
			client.rpcClient.http.getPeers().map((peer) => {
				const outputPeer: Partial<PeerAttributes> = {};
				for (const [key, value] of Object.entries(peer)) {
					if (key.startsWith("_")) continue;
					outputPeer[key as keyof PeerAttributes] = value;
				}
				return outputPeer;
			}),
		),
		{ headers },
	);
});

router.set("/info", async () => {
	const headers = {
		"Content-Type": "application/json",
		"Cache-Control": "public, max-age=300",
	};
	return new DecodedResponse(JSON.stringify({ version: JSON.parse(await Deno.readTextFile("deno.jsonc")).version }), { headers });
});

router.set("/announce", async (req, client) => {
	const url = new URL(req.url);
	const host = url.searchParams.get("host");
	if (host === null) return new DecodedResponse("No hosted given\n", { status: 401 });
	const knownNodes = client.rpcClient.http.getPeers();
	if (knownNodes.find((node) => node.host === host) !== undefined) return new DecodedResponse("Already known\n");
	await client.rpcClient.http.add(host);
	return new DecodedResponse("Announced\n");
});

router.set("/download", async (req, client) => {
	const url = new URL(req.url);
	const hash = Utils.sha256(url.pathname.split("/")[2]);
	const fileId = url.pathname.split("/")[3] ?? "";
	const infohash = Array.from(decodeURIComponent(url.searchParams.get("info_hash") ?? "")).map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");

	if (processingDownloads.has(hash)) {
		if (client.config.logLevel === "verbose") console.log(`  ${hash}  Waiting for existing request with same hash`);
		await processingDownloads.get(hash);
	}
	const processingPromise = (async () => {
		const fileParams: { hash: Sha256; infohash?: string } = { hash };
		if (infohash) {
			fileParams.infohash = infohash;
		}
		const file = await File.init(fileParams, true);
		if (!file) throw new Error("Failed to build file");

		if (fileId.length !== 0) {
			const id = file.id;
			if (id === undefined || id === null || id.length === 0) {
				file.id = fileId;
				file.save();
			}
		}

		await file.getMetadata();
		const fileContent: { file: Uint8Array; signal: number } | Error = await file.getFile({ logDownloads: true });

		if (fileContent instanceof Error) {
			file.found = false;
			file.save();
			return new DecodedResponse("404 File Not Found\n", {
				status: 404,
			});
		}

		const headers: { [key: string]: string } = {
			"Content-Type": "application/octet-stream",
			"Cache-Control": "public, max-age=31536000",
			"Content-Length": String(file.size) ?? fileContent.file.byteLength.toString(),
			"Signal-Strength": String(fileContent.signal),
		};

		const address = client.filesWallet.address();
		if (address) headers["Ethereum-Address"] = address;
		console.log(`File:     ${hash}  Signal Strength:`, fileContent.signal, Utils.estimateHops(fileContent.signal));

		if (file.name !== undefined && file.name !== null) {
			headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(file.name.replace(/[^a-zA-Z0-9._-]/g, "").replace(/\s+/g, " ").trim()).replace(/%20/g, " ").replace(/(\.\w+)$/, " [HYDRAFILES]$1")}"`;
		}

		return new DecodedResponse(fileContent.file, { headers });
	})();

	processingDownloads.set(hash, processingPromise);

	let response: DecodedResponse;
	try {
		response = await processingPromise;
	} finally {
		processingDownloads.delete(hash);
	}
	return response;
});

router.set("/infohash", async (req, client): Promise<DecodedResponse> => {
	const url = new URL(req.url);
	const infohash = url.pathname.split("/")[2];

	if (processingDownloads.has(infohash)) {
		console.log(`  ${infohash}  Waiting for existing request with same infohash`);
		await processingDownloads.get(infohash);
	}
	const processingPromise = (async () => {
		const file = client.files.filesInfohash.get(infohash);
		if (!file) return new ErrorNotFound();

		await file.getMetadata();
		const fileContent: { file: Uint8Array; signal: number } | Error = await file.getFile({ logDownloads: true });

		if (fileContent instanceof Error) {
			file.found = false;
			file.save();
			return new DecodedResponse("404 File Not Found\n", {
				status: 404,
			});
		}

		const headers: { [key: string]: string } = {
			"Content-Type": "application/octet-stream",
			"Cache-Control": "public, max-age=31536000",
			"Signal-Strength": String(fileContent.signal),
			"Content-Length": String(file.size),
		};
		console.log(`File:     ${file.hash}  Signal Strength:`, fileContent.signal, Utils.estimateHops(fileContent.signal));

		if (file.name) headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(file.name).replace(/%20/g, " ").replace(/(\.\w+)$/, " [HYDRAFILES]$1")}"`;

		return new DecodedResponse(fileContent.file, { headers });
	})();

	processingDownloads.set(infohash, processingPromise);

	let response: DecodedResponse | ErrorNotFound;
	try {
		response = await processingPromise;
	} finally {
		processingDownloads.delete(infohash);
	}

	if (response instanceof ErrorNotFound) return new DecodedResponse("Error Not Found", { status: 404 });

	return response;
});

router.set("/upload", async (req, client) => {
	const uploadSecret = req.headers.get("x-hydra-upload-secret");
	if (uploadSecret !== client.config.uploadSecret) {
		return new DecodedResponse("401 Unauthorized\n", { status: 401 });
	}

	const form = await req.formData();
	const formData = {
		hash: form.get("hash")?.toString(),
		file: form.get("file") as globalThis.File | null,
	};

	if (typeof formData.hash === "undefined" || typeof formData.file === "undefined" || formData.file === null) return new DecodedResponse("400 Bad Request\n", { status: 400 });

	const hash = Utils.sha256(formData.hash[0]);

	const file = await File.init({ hash }, true);
	if (!file) throw new Error("Failed to build file");
	if (!file.name && formData.file.name !== null) {
		file.name = formData.file.name;
		file.cacheFile(new Uint8Array(await formData.file.arrayBuffer()));
		file.save();
	}

	console.log("Uploading", file.hash);

	if (await client.fs.exists(join("files", file.hash))) return new DecodedResponse("200 OK\n");

	if (!client.config.permaFiles.includes(hash)) client.config.permaFiles.push(hash);
	await client.fs.writeFile("config.json", new TextEncoder().encode(JSON.stringify(client.config, null, 2)));
	return new DecodedResponse("200 OK\n");
});

router.set("/files", (_, client) => {
	const rows = Array.from(client.files.getFiles()).map((row) => {
		const { downloadCount, found, ...rest } = row;
		const _ = { downloadCount, found };
		const filteredRest = Object.keys(rest)
			.filter((key) => !key.startsWith("_"))
			.reduce((obj, key) => {
				// @ts-expect-error:
				obj[key] = rest[key];
				return obj;
			}, {});
		return filteredRest;
	});

	const headers = {
		"Content-Type": "application/json",
		"Cache-Control": "public, max-age=10800",
	};
	return new DecodedResponse(JSON.stringify(rows), { headers });
});

router.set("/file", (req, client) => {
	const url = new URL(req.url);
	const id = url.pathname.split("/")[2];
	if (!id) return new DecodedResponse("No File ID Set", { status: 401 });
	let file: File | undefined;
	try {
		file = client.files.filesId.get(id);
	} catch (e) {
		const err = e as Error;
		if (err.message === "File not found") return new DecodedResponse("File not found", { status: 404 });
		else throw err;
	}

	const headers = {
		"Content-Type": "application/json",
		"Cache-Control": "public, max-age=10800",
	};
	if (!file) return new DecodedResponse("File not found", { headers, status: 404 });
	return new DecodedResponse(JSON.stringify(file), { headers });
});

router.set("/service", async (req, client) => {
	const url = new URL(req.url);
	url.protocol = "https:";
	url.hostname = "localhost";

	const newRequest = new Request(url.toString(), {
		method: req.method,
		headers: req.headers,
		body: req.body,
	});

	return await client.services.fetch(newRequest);
});

router.set("/blocks", (_, client) => {
	const headers = {
		"Content-Type": "application/json",
		"Cache-Control": "public, max-age=10800",
	};
	return new DecodedResponse(JSON.stringify(client.nameService.blocks), { headers });
});
