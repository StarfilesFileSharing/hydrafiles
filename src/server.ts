import Base32 from "npm:base32";
import type Hydrafiles from "./hydrafiles.ts";
// import { BLOCKSDIR } from "./block.ts";
import File, { fileAttributesDefaults } from "./file.ts";
import Utils from "./utils.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import type Base64 from "npm:base64";

export const hashLocks = new Map<string, Promise<Response>>();

function stripInvalidProperties<T extends File>(obj: T): File {
	const result: Partial<File> = {};
	Object.keys(obj).forEach((key) => {
		const fileKey = key as keyof File;
		if (!key.startsWith("_") && key !== "downloadCount") {
			// @ts-expect-error:
			if (obj[fileKey] !== undefined && obj[fileKey] !== null) result[fileKey] = obj[fileKey];
		}
	});

	return Object.assign({}, result as File);
}
export const handleRequest = async (req: Request, client: Hydrafiles): Promise<Response> => {
	console.log(`Received Request: ${req.url}`);
	const url = new URL(req.url);
	const headers = new Headers();
	headers.set("Access-Control-Allow-Origin", "*");

	try {
		if (url.pathname === "/" || url.pathname === undefined) {
			headers.set("Content-Type", "text/html");
			headers.set("Cache-Control", "public, max-age=604800");
			return new Response(await client.fs.readFile("public/index.html"), { headers });
		} else if (url.pathname === "/favicon.ico") {
			headers.set("Content-Type", "image/x-icon");
			headers.set("Cache-Control", "public, max-age=604800");
			return new Response(await client.fs.readFile("public/favicon.ico"), { headers });
		} else if (url.pathname === "/status") {
			headers.set("Content-Type", "application/json");
			return new Response(JSON.stringify({ status: true }), { headers });
		} else if (url.pathname === "/hydrafiles-web.esm.js") {
			headers.set("Content-Type", "application/javascript");
			headers.set("Cache-Control", "public, max-age=300");
			return new Response(await client.fs.readFile("build/hydrafiles-web.esm.js"), { headers });
		} else if (url.pathname === "/hydrafiles-web.esm.js.map") {
			headers.set("Content-Type", "application/json");
			headers.set("Cache-Control", "public, max-age=300");
			return new Response(await client.fs.readFile("build/hydrafiles-web.esm.js.map"), { headers });
		} else if (url.pathname === "/demo.html") {
			headers.set("Content-Type", "text/html");
			headers.set("Cache-Control", "public, max-age=300");
			return new Response(await client.fs.readFile("public/demo.html"), { headers });
		} else if (url.pathname === "/nodes") {
			headers.set("Content-Type", "application/json");
			headers.set("Cache-Control", "public, max-age=300");
			return new Response(JSON.stringify(await (await client.nodes).getValidNodes()), { headers });
		} else if (url.pathname === "/info") {
			headers.set("Content-Type", "application/json");
			headers.set("Cache-Control", "public, max-age=300");
			return new Response(JSON.stringify({ version: JSON.parse(await Deno.readTextFile("deno.jsonc")).version }), { headers });
		} else if (url.pathname.startsWith("/announce")) {
			const host = url.searchParams.get("host");

			if (host === null) return new Response("No hosted given\n", { status: 401 });

			const knownNodes = (await client.nodes).getNodes();
			if (knownNodes.find((node) => node.host === host) !== undefined) return new Response("Already known\n");

			if ((await (await client.nodes).downloadFromNode((await client.nodes).nodeFrom(host), new File({ hash: "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f" }, client))) !== false) {
				await (await client.nodes).add((await client.nodes).nodeFrom(host));
				return new Response("Announced\n");
			} else {
				return new Response("Invalid request\n");
			}
		} else if (url.pathname?.startsWith("/download/")) {
			const hash = url.pathname.split("/")[2];
			const fileId = url.pathname.split("/")[3] ?? "";
			const infohash = Array.from(decodeURIComponent(url.searchParams.get("info_hash") ?? "")).map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");

			if (hashLocks.has(hash)) {
				if (client.config.logLevel === "verbose") console.log(`  ${hash}  Waiting for existing request with same hash`);
				await hashLocks.get(hash);
			}
			const processingPromise = (async () => {
				const file = new File({ hash, infohash }, client);

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
					fileContent = await file.getFile();
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
				console.log(`  ${hash}  Signal Strength:`, fileContent.signal, Utils.estimateHops(fileContent.signal));

				headers.set("Content-Length", String(file.size));
				if (file.name !== null) {
					headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name.replace(/[^a-zA-Z0-9._-]/g, "").replace(/\s+/g, " ").trim()).replace(/%20/g, " ").replace(/(\.\w+)$/, " [HYDRAFILES]$1")}"`);
				}

				return new Response(fileContent.file, { headers });
			})();

			hashLocks.set(hash, processingPromise);

			let response: Response;
			try {
				response = await processingPromise;
			} finally {
				hashLocks.delete(hash);
			}
			return response;
		} else if (url.pathname?.startsWith("/infohash/")) {
			const infohash = url.pathname.split("/")[2];

			if (hashLocks.has(infohash)) {
				console.log(`  ${infohash}  Waiting for existing request with same infohash`);
				await hashLocks.get(infohash);
			}
			const processingPromise = (async () => {
				const file = new File({ infohash }, client);

				await file.getMetadata();
				let fileContent: { file: Uint8Array; signal: number } | false;
				try {
					fileContent = await file.getFile();
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

			hashLocks.set(infohash, processingPromise);

			try {
				await processingPromise;
			} finally {
				hashLocks.delete(infohash);
			}
		} else if (url.pathname === "/upload") {
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

			const hash = formData.hash[0];

			const file = new File({ hash }, client);
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
		} else if (url.pathname === "/files") {
			const rows = (client.FileDB !== undefined ? await client.FileDB.select() : []).map((row) => {
				const { downloadCount, found, ...rest } = row;
				const _ = { downloadCount, found };
				return rest;
			});
			headers.set("Content-Type", "application/json");
			headers.set("Cache-Control", "public, max-age=10800");
			return new Response(JSON.stringify(rows), { headers });
		} else if (url.pathname.startsWith("/file/")) {
			const id = url.pathname.split("/")[2];
			let file: File;
			try {
				file = stripInvalidProperties(new File({ id }, client));
			} catch (e) {
				console.error(e);
				file = fileAttributesDefaults({ id }) as File;
			}

			headers.set("Content-Type", "application/json");
			headers.set("Cache-Control", "public, max-age=10800");
			return new Response(JSON.stringify(file), { headers });
		} else if (url.pathname.startsWith("/endpoint/")) {
			const hostname = url.pathname.split("/")[2];
			const pubKey = await Utils.exportPublicKey((await client.keyPair).publicKey);
			if (hostname === `${Base32.encode(pubKey.x).toLowerCase().replaceAll("=", "")}.${Base32.encode(pubKey.y).toLowerCase().replaceAll("=", "")}`) {
				const body = client.config.reverseProxy ? await (await fetch(client.config.reverseProxy)).text() : "Hello World!"; // TODO: Reverse proxy logic
				const signature = await Utils.signMessage((await client.keyPair).privateKey, body);

				headers.set("hydra-signature", signature);
				return new Response(body, { headers });
			} else {
				const nodes = (await client.nodes).getNodes({ includeSelf: false });
				for (let i = 0; i < nodes.length; i++) {
					const node = nodes[i];
					const response = await fetch(`${node.host}/endpoint/${hostname}`);
					const body = await response.text();
					const signature = response.headers.get("hydra-signature");
					if (signature !== null) {
						const [xBase32, yBase32] = hostname.split(".");
						if (await Utils.verifySignature(body, signature as Base64, { x: Base32.decode(xBase32), y: Base32.decode(yBase32) })) return new Response(body, { headers });
					}
				}
			}

			return new Response("Not found", { headers, status: 404 });
			// } else if (url.pathname.startsWith("/block/")) {
			// 	const blockHeight = url.pathname.split("/")[2];
			// 	headers.set("Content-Type", "application/json");
			// 	// "Cache-Control": "public, max-age=" + (Number(blockHeight) > client.blockchain.lastBlock().height ? 0 : 604800),
			// 	const block = await client.fs.readFile(join(BLOCKSDIR, blockHeight));
			// 	return new Response(block, { headers });
		} else if (url.pathname === "/block_height") {
			headers.set("Content-Type", "application/json");
			headers.set("Cache-Control", "public, max-age=30");
			// return new Response(String(client.blockchain.lastBlock().height));
		} else {
			return new Response("404 Page Not Found\n", { status: 404 });
		}
	} catch (e) {
		console.error(e);
		return new Response("Internal Server Error", { status: 500 });
	}
	return new Response("Something went wrong", { status: 500 });
};

const onListen = (client: Hydrafiles): void => {
	console.log(`Server running at ${client.config.publicHostname}/`);

	const handleListen = async (): Promise<void> => {
		console.log("Testing network connection");
		const file = await (await client.nodes).getFile("04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f");
		if (file === false) console.error("Download test failed, cannot connect to network");
		else {
			console.log("Connected to network");

			if (Utils.isIp(client.config.publicHostname) && Utils.isPrivateIP(client.config.publicHostname)) console.error("Public hostname is a private IP address, cannot announce to other nodes");
			else {
				console.log(`Testing downloads ${client.config.publicHostname}/download/04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f`);

				console.log("Testing connectivity");
				const response = await (await client.nodes).downloadFromNode((await client.nodes).nodeFrom(`${client.config.publicHostname}`), new File({ hash: "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f" }, client));
				if (response === false) console.error("  04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f  ERROR: Failed to download file from self");
				else {
					console.log("  04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f  Test Succeeded");
					console.log("Announcing to nodes");
					(await client.nodes).announce();
				}
				await (await client.nodes).add((await client.nodes).nodeFrom(client.config.publicHostname));
			}
		}
	};
	handleListen().catch(console.error);
};

const startServer = (client: Hydrafiles): void => {
	if (typeof window !== "undefined") return;
	console.log("Starting server");

	Deno.serve({
		port: client.config.port,
		hostname: client.config.hostname,
		onListen({ hostname, port }): void {
			onListen(client);
			console.log(`Server started at ${hostname}:${port}`);
		},
		handler: async (req: Request): Promise<Response> => await handleRequest(req, client),
	});
};
export default startServer;
