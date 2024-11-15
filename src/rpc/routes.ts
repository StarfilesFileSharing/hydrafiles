import { encode as base32Encode } from "https://deno.land/std@0.194.0/encoding/base32.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { WSMessage } from "./peers/rtc.ts";
import { File } from "../file.ts";
import type { PeerAttributes } from "./peers/http.ts";
import Utils, { type Base64 } from "../utils.ts";
import type Hydrafiles from "../hydrafiles.ts";

export const router = new Map<string, (req: Request, headers: Headers, client: Hydrafiles) => Promise<Response> | Response>();
export const sockets: { id: string; socket: WebSocket }[] = [];
export const processingRequests = new Map<string, Promise<Response>>();
const cachedHostnames: { [key: string]: { body: string; headers: Headers } } = {};

router.set("WS", (req) => {
	const { socket, response } = Deno.upgradeWebSocket(req);
	sockets.push({ socket, id: "" });

	socket.addEventListener("message", ({ data }) => {
		const message = JSON.parse(data) as WSMessage | null;
		if (message === null) return;
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

router.set("/status", (_, headers) => {
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify({ status: true }), { headers });
});

router.set("/hydrafiles-web.esm.js", async (_, headers, client) => {
	headers.set("Content-Type", "application/javascript");
	headers.set("Cache-Control", "public, max-age=300");
	return new Response(await client.fs.readFile("build/hydrafiles-web.esm.js") || "", { headers });
});

router.set("/dashboard.js", async (_, headers, client) => {
	headers.set("Content-Type", "application/javascript");
	headers.set("Cache-Control", "public, max-age=300");
	return new Response(await client.fs.readFile("build/dashboard.js") || "", { headers });
});

router.set("/hydrafiles-web.esm.js.map", async (_, headers, client) => {
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=300");
	return new Response(await client.fs.readFile("build/hydrafiles-web.esm.js.map") || "", { headers });
});

router.set("/dashboard.js.map", async (_, headers, client) => {
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=300");
	return new Response(await client.fs.readFile("build/dashboard.js.map") || "", { headers });
});

router.set("/peers", (_, headers, client) => {
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

router.set("/info", async (_, headers) => {
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=300");
	return new Response(JSON.stringify({ version: JSON.parse(await Deno.readTextFile("deno.jsonc")).version }), { headers });
});

router.set("/announce", async (req, _, client) => {
	const url = new URL(req.url);
	const host = url.searchParams.get("host");
	if (host === null) return new Response("No hosted given\n", { status: 401 });
	const knownNodes = client.rpcClient.http.getPeers();
	if (knownNodes.find((node) => node.host === host) !== undefined) return new Response("Already known\n");
	await client.rpcClient.http.add(host);
	return new Response("Announced\n");
});

router.set("/download", async (req, headers, client) => {
	const url = new URL(req.url);
	const hash = Utils.sha256(url.pathname.split("/")[2]);
	const fileId = url.pathname.split("/")[3] ?? "";
	const infohash = Array.from(decodeURIComponent(url.searchParams.get("info_hash") ?? "")).map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");

	if (processingRequests.has(hash)) {
		if (client.config.logLevel === "verbose") console.log(`  ${hash}  Waiting for existing request with same hash`);
		await processingRequests.get(hash);
	}
	const processingPromise = (async () => {
		const file = await File.init({ hash, infohash }, client, true);
		if (!file) throw new Error("Failed to build file");

		if (fileId.length !== 0) {
			const id = file.id;
			if (id === undefined || id === null || id.length === 0) {
				file.id = fileId;
				file.save();
			}
		}

		await file.getMetadata();
		let fileContent: { file: Uint8Array; signal: number } | false;
		try {
			fileContent = await file.getFile({ logDownloads: true });
		} catch (e) {
			const err = e as { message: string };
			if (err.message === "Promise timed out") {
				fileContent = false;
			} else {
				throw e;
			}
		}

		if (fileContent === false) {
			file.found = false;
			file.save();
			return new Response("404 File Not Found\n", {
				status: 404,
			});
		}

		headers.set("Content-Type", "application/octet-stream");
		headers.set("Cache-Control", "public, max-age=31536000");
		headers.set("Content-Length", fileContent.file.byteLength.toString());
		headers.set("Signal-Strength", String(fileContent.signal));
		const address = client.wallet.address();
		if (address) headers.set("Ethereum-Address", address);
		console.log(`  ${hash}  Signal Strength:`, fileContent.signal, Utils.estimateHops(fileContent.signal));

		headers.set("Content-Length", String(file.size));
		if (file.name !== undefined && file.name !== null) {
			headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name.replace(/[^a-zA-Z0-9._-]/g, "").replace(/\s+/g, " ").trim()).replace(/%20/g, " ").replace(/(\.\w+)$/, " [HYDRAFILES]$1")}"`);
		}

		return new Response(fileContent.file, { headers });
	})();

	processingRequests.set(hash, processingPromise);

	let response: Response;
	try {
		response = await processingPromise;
	} finally {
		processingRequests.delete(hash);
	}
	return response;
});

router.set("/infohash", async (req, headers, client) => {
	const url = new URL(req.url);
	const infohash = url.pathname.split("/")[2];

	if (processingRequests.has(infohash)) {
		console.log(`  ${infohash}  Waiting for existing request with same infohash`);
		await processingRequests.get(infohash);
	}
	const processingPromise = (async () => {
		const file = client.files.files.get(infohash);
		if (!file) throw new Error("Failed to find file");

		await file.getMetadata();
		let fileContent: { file: Uint8Array; signal: number } | false;
		try {
			fileContent = await file.getFile({ logDownloads: true });
		} catch (e) {
			const err = e as { message: string };
			if (err.message === "Promise timed out") {
				fileContent = false;
			} else {
				throw e;
			}
		}

		if (fileContent === false) {
			file.found = false;
			file.save();
			return new Response("404 File Not Found\n", {
				status: 404,
			});
		}

		headers.set("Content-Type", "application/octet-stream");
		headers.set("Cache-Control", "public, max-age=31536000");

		headers.set("Signal-Strength", String(fileContent.signal));
		console.log(`  ${file.hash}  Signal Strength:`, fileContent.signal, Utils.estimateHops(fileContent.signal));

		headers.set("Content-Length", String(file.size));
		if (file.name !== null) headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name).replace(/%20/g, " ").replace(/(\.\w+)$/, " [HYDRAFILES]$1")}"`);

		return new Response(fileContent.file, { headers });
	})();

	processingRequests.set(infohash, processingPromise);

	let response: Response;
	try {
		response = await processingPromise;
	} finally {
		processingRequests.delete(infohash);
	}
	return response;
});

router.set("/upload", async (req, _, client) => {
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

	const file = await File.init({ hash }, client, true);
	if (!file) throw new Error("Failed to build file");
	if ((file.name === null || file.name.length === 0) && formData.file.name !== null) {
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

router.set("/files", (_, headers, client) => {
	const rows = Array.from(client.files.files.values()).map((row) => {
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
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=10800");
	return new Response(JSON.stringify(rows), { headers });
});

router.set("/file", (req, headers, client) => {
	const url = new URL(req.url);
	const id = url.pathname.split("/")[2];
	let file: File | undefined;
	try {
		file = client.files.files.get(id);
	} catch (e) {
		const err = e as Error;
		if (err.message === "File not found") return new Response("File not found", { headers, status: 404 });
		else throw err;
	}

	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "public, max-age=10800");
	if (!file) return new Response("File not found", { headers, status: 404 });
	return new Response(JSON.stringify(file.toFileAttributes()), { headers });
});

router.set("/endpoint", async (req, headers, client) => {
	const url = new URL(req.url);
	const hostname = url.pathname.split("/")[2];
	const pubKey = await Utils.exportPublicKey(client.keyPair.publicKey);

	if (hostname === `${base32Encode(new TextEncoder().encode(pubKey.x)).toLowerCase().replace(/=+$/, "")}.${base32Encode(new TextEncoder().encode(pubKey.y)).toLowerCase().replace(/=+$/, "")}`) {
		const body = await (client.config.reverseProxy ? await fetch(client.config.reverseProxy) : await client.handleCustomRequest(new Request(`hydra://${hostname}/`))).text();
		const signature = await Utils.signMessage(client.keyPair.privateKey, body);

		headers.set("hydra-signature", signature);
		return new Response(body, { headers });
	} else {
		if (processingRequests.has(hostname)) {
			if (client.config.logLevel === "verbose") console.log(`  ${hostname}  Waiting for existing request with same hostname`);
			await processingRequests.get(hostname);
		}
		if (hostname in cachedHostnames) return new Response(cachedHostnames[hostname].body, { headers: cachedHostnames[hostname].headers });

		console.log(`  ${hostname}  Fetching endpoint response from peers`);
		const responses = client.rpcClient.fetch(`http://localhost/endpoint/${hostname}`);

		const processingPromise = new Promise<Response>((resolve, reject) => {
			(async () => {
				await Promise.all(responses.map(async (res) => {
					try {
						const response = await res;
						if (response) {
							const body = await response.text();
							const signature = response.headers.get("hydra-signature");
							if (signature !== null) {
								const [xBase32, yBase32] = hostname.split(".");
								if (await Utils.verifySignature(body, signature as Base64, { xBase32, yBase32 })) resolve(new Response(body, { headers: response.headers }));
							}
						}
					} catch (e) {
						const err = e as Error;
						if (err.message !== "Hostname not found" && err.message !== "Promise timed out") console.error(e);
					}
				}));
				reject(new Error("Hostname not found"));
			})();
		});

		processingRequests.set(hostname, processingPromise);

		let response: Response | undefined;
		try {
			response = await processingPromise;
		} catch (e) {
			const err = e as Error;
			if (err.message === "Hostname not found") return new Response("Hostname not found", { headers, status: 404 });
			else throw err;
		} finally {
			processingRequests.delete(hostname);
		}
		const res = { body: await response.text(), headers: response.headers };
		cachedHostnames[hostname] = res;
		return new Response(res.body, { headers: res.headers });
	}
});
