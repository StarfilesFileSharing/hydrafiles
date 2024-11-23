import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { WSMessage } from "./peers/rtc.ts";
import { File } from "../file.ts";
import type { PeerAttributes } from "./peers/http.ts";
import Utils, { type Sha256 } from "../utils.ts";
import type Hydrafiles from "../hydrafiles.ts";
import { ErrorNotFound } from "../errors.ts";

export const router = new Map<string, (req: Request, client: Hydrafiles) => Promise<Response> | Response>();
export const sockets: { id: string; socket: WebSocket }[] = [];

export const pendingWSRequests = new Map<number, (response: Response) => void>();
export const processingDownloads = new Map<string, Promise<Response | ErrorNotFound>>();

router.set("WS", (req) => {
	const { socket, response } = Deno.upgradeWebSocket(req);
	sockets.push({ socket, id: "" });

	socket.addEventListener("message", ({ data }) => {
		const message = JSON.parse(data) as WSMessage | null;
		if (message === null) return;
		if ("response" in message) {
			const resolve = pendingWSRequests.get(message.id);
			if (resolve) {
				const { status, statusText, headers, body } = message.response;
				resolve(new Response(body, { status, statusText, headers: new Headers(headers) }));
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

	return response;
});

router.set("/status", () => {
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify({ status: true }), { headers });
});

router.set("/hydrafiles-web.esm.js", async (_, client) => {
	const headers = new Headers();
	headers.set("Content-Type", "application/javascript");
	headers.set("Cache-Control", "public, max-age=300");
	const fileContent = await client.fs.readFile("build/hydrafiles-web.esm.js");
	if (fileContent instanceof Error) return new Response("File gone", { status: 403 });
	return new Response(fileContent, { headers });
});

router.set("/dashboard.js", async (_, client) => {
	const headers = new Headers();
	headers.set("Content-Type", "application/javascript");
	headers.set("Cache-Control", "public, max-age=300");
	const fileContent = await client.fs.readFile("build/dashboard.js");
	if (fileContent instanceof Error) return new Response("File not found", { status: 404 });
	return new Response(fileContent, { headers });
});

router.set("/hydrafiles-web.esm.js.map", async (_, client) => {
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=300");
	const fileContent = await client.fs.readFile("build/hydrafiles-web.esm.js.map");
	if (fileContent instanceof Error) return new Response("File not found", { status: 404 });
	return new Response(fileContent, { headers });
});

router.set("/dashboard.js.map", async (_, client) => {
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=300");
	const fileContent = await client.fs.readFile("build/dashboard.js.map");
	if (fileContent instanceof Error) return new Response("File not found", { status: 404 });
	return new Response(fileContent, { headers });
});

router.set("/peers", (_, client) => {
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=300");
	return new Response(
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
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=300");
	return new Response(JSON.stringify({ version: JSON.parse(await Deno.readTextFile("deno.jsonc")).version }), { headers });
});

router.set("/announce", async (req, client) => {
	const url = new URL(req.url);
	const host = url.searchParams.get("host");
	if (host === null) return new Response("No hosted given\n", { status: 401 });
	const knownNodes = client.rpcClient.http.getPeers();
	if (knownNodes.find((node) => node.host === host) !== undefined) return new Response("Already known\n");
	await client.rpcClient.http.add(host);
	return new Response("Announced\n");
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
			return new Response("404 File Not Found\n", {
				status: 404,
			});
		}

		const headers = new Headers();
		headers.set("Content-Type", "application/octet-stream");
		headers.set("Cache-Control", "public, max-age=31536000");
		headers.set("Content-Length", fileContent.file.byteLength.toString());
		headers.set("Signal-Strength", String(fileContent.signal));
		const address = client.filesWallet.address();
		if (address) headers.set("Ethereum-Address", address);
		console.log(`File:     ${hash}  Signal Strength:`, fileContent.signal, Utils.estimateHops(fileContent.signal));

		headers.set("Content-Length", String(file.size));
		if (file.name !== undefined && file.name !== null) {
			headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name.replace(/[^a-zA-Z0-9._-]/g, "").replace(/\s+/g, " ").trim()).replace(/%20/g, " ").replace(/(\.\w+)$/, " [HYDRAFILES]$1")}"`);
		}

		return new Response(fileContent.file, { headers });
	})();

	processingDownloads.set(hash, processingPromise);

	let response: Response;
	try {
		response = await processingPromise;
	} finally {
		processingDownloads.delete(hash);
	}
	return response;
});

router.set("/infohash", async (req, client): Promise<Response> => {
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
			return new Response("404 File Not Found\n", {
				status: 404,
			});
		}

		const headers = new Headers();
		headers.set("Content-Type", "application/octet-stream");
		headers.set("Cache-Control", "public, max-age=31536000");

		headers.set("Signal-Strength", String(fileContent.signal));
		console.log(`File:     ${file.hash}  Signal Strength:`, fileContent.signal, Utils.estimateHops(fileContent.signal));

		headers.set("Content-Length", String(file.size));
		if (file.name) headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name).replace(/%20/g, " ").replace(/(\.\w+)$/, " [HYDRAFILES]$1")}"`);

		return new Response(fileContent.file, { headers });
	})();

	processingDownloads.set(infohash, processingPromise);

	let response: Response | ErrorNotFound;
	try {
		response = await processingPromise;
	} finally {
		processingDownloads.delete(infohash);
	}

	if (response instanceof ErrorNotFound) return new Response("Error Not Found", { status: 404 });

	return response;
});

router.set("/upload", async (req, client) => {
	const uploadSecret = req.headers.get("x-hydra-upload-secret");
	if (uploadSecret !== client.config.uploadSecret) {
		return new Response("401 Unauthorized\n", { status: 401 });
	}

	const form = await req.formData();
	const formData = {
		hash: form.get("hash")?.toString(),
		file: form.get("file") as globalThis.File | null,
	};

	if (typeof formData.hash === "undefined" || typeof formData.file === "undefined" || formData.file === null) return new Response("400 Bad Request\n", { status: 400 });

	const hash = Utils.sha256(formData.hash[0]);

	const file = await File.init({ hash }, true);
	if (!file) throw new Error("Failed to build file");
	if (!file.name && formData.file.name !== null) {
		file.name = formData.file.name;
		file.cacheFile(new Uint8Array(await formData.file.arrayBuffer()));
		file.save();
	}

	console.log("Uploading", file.hash);

	if (await client.fs.exists(join("files", file.hash))) return new Response("200 OK\n");

	if (!client.config.permaFiles.includes(hash)) client.config.permaFiles.push(hash);
	await client.fs.writeFile("config.json", new TextEncoder().encode(JSON.stringify(client.config, null, 2)));
	return new Response("200 OK\n");
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

	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=10800");
	return new Response(JSON.stringify(rows), { headers });
});

router.set("/file", (req, client) => {
	const url = new URL(req.url);
	const id = url.pathname.split("/")[2];
	let file: File | undefined;
	try {
		file = client.files.filesId.get(id);
	} catch (e) {
		const err = e as Error;
		if (err.message === "File not found") return new Response("File not found", { status: 404 });
		else throw err;
	}

	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=10800");
	if (!file) return new Response("File not found", { headers, status: 404 });
	return new Response(JSON.stringify(file), { headers });
});

router.set("/endpoint", async (req, client): Promise<Response> => {
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
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=10800");
	return new Response(JSON.stringify(client.nameService.blocks), { headers });
});
