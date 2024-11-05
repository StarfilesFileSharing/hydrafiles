import { encode as base32Encode } from "https://deno.land/std@0.194.0/encoding/base32.ts";
import type Hydrafiles from "../hydrafiles.ts";
// import { BLOCKSDIR } from "./block.ts";
import Utils, { type Base64 } from "../utils.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { SignallingMessage } from "./peers/rtc.ts";
import { serveFile } from "https://deno.land/std@0.115.0/http/file_server.ts";
import { File } from "../file.ts";
import type { PeerAttributes } from "./peers/http.ts";

class RPCServer {
	private _client: Hydrafiles;
	cachedHostnames: { [key: string]: { body: string; headers: Headers } } = {};
	sockets: { id: string; socket: WebSocket }[] = [];
	public processingRequests = new Map<string, Promise<Response>>();
	public handleCustomRequest?: (req: Request) => Promise<string>;

	constructor(client: Hydrafiles) {
		this._client = client;

		if (typeof window !== "undefined") return;
		let port = client.config.port;
		while (true) {
			try {
				Deno.serve({
					port,
					hostname: client.config.hostname,
					onListen: ({ hostname, port }): void => {
						this.onListen(hostname, port);
					},
					handler: async (req: Request): Promise<Response> => await this.handleRequest(req),
				});
				return;
			} catch (e) {
				const err = e as Error;
				if (err.name !== "AddrInUse") throw err;
				port++;
			}
		}
	}

	private onListen = async (hostname: string, port: number): Promise<void> => {
		console.log(`Server started at ${hostname}:${port}`);
		console.log("Testing network connection");
		const file = this._client.files.files.get("04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f");
		if (!file) return;
		if (!(await file.download())) console.error("Download test failed, cannot connect to network");
		else {
			console.log("Connected to network");
			if (Utils.isIp(this._client.config.publicHostname) && Utils.isPrivateIP(this._client.config.publicHostname)) console.error("Public hostname is a private IP address, cannot announce to other nodes");
			else {
				console.log(`Testing downloads ${this._client.config.publicHostname}/download/04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f`);
				if (!file) console.error("Failed to build file");
				else {
					const response = await this._client.rpcClient.http.getSelf().downloadFile(file); // TODO: HTTPPeers.getSelf()
					if (response === false) console.error("Test: Failed to download file from self");
					else {
						console.log("Announcing HTTP server to nodes");
						this._client.rpcClient.fetch(`http://localhost/announce?host=${this._client.config.publicHostname}`);
					}
					await this._client.rpcClient.http.add(this._client.config.publicHostname);
				}
			}
		}
	};

	handleRequest = async (req: Request): Promise<Response> => {
		console.log(`Received Request: ${req.url}`);
		const url = new URL(req.url);
		const headers = new Headers();
		headers.set("Access-Control-Allow-Origin", "*");

		try {
			if (req.headers.get("upgrade") === "websocket") {
				const { socket, response } = Deno.upgradeWebSocket(req);
				this.sockets.push({ socket, id: "" });

				socket.addEventListener("message", ({ data }) => {
					const message = JSON.parse(data) as SignallingMessage | null;
					if (message === null) return;
					for (let i = 0; i < this.sockets.length; i++) {
						if (this.sockets[i].socket !== socket && (!("to" in message) || message.to === this.sockets[i].id)) {
							if (this.sockets[i].socket.readyState === 1) this.sockets[i].socket.send(data);
						} else if ("from" in message) {
							this.sockets[i].id = message.from;
						}
					}
				});

				return response;
			} else if (url.pathname === "/status") {
				headers.set("Content-Type", "application/json");
				return new Response(JSON.stringify({ status: true }), { headers });
			} else if (url.pathname === "/hydrafiles-web.esm.js") {
				headers.set("Content-Type", "application/javascript");
				headers.set("Cache-Control", "public, max-age=300");
				return new Response(await this._client.fs.readFile("build/hydrafiles-web.esm.js") || "", { headers });
			} else if (url.pathname === "/hydrafiles-web.esm.js.map") {
				headers.set("Content-Type", "application/json");
				headers.set("Cache-Control", "public, max-age=300");
				return new Response(await this._client.fs.readFile("build/hydrafiles-web.esm.js.map") || "", { headers });
			} else if (url.pathname === "/peers") {
				headers.set("Content-Type", "application/json");
				headers.set("Cache-Control", "public, max-age=300");
				return new Response(
					JSON.stringify(
						this._client.rpcClient.http.getPeers().map((peer) => {
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
			} else if (url.pathname === "/info") {
				headers.set("Content-Type", "application/json");
				headers.set("Cache-Control", "public, max-age=300");
				return new Response(JSON.stringify({ version: JSON.parse(await Deno.readTextFile("deno.jsonc")).version }), { headers });
			} else if (url.pathname.startsWith("/announce")) {
				const host = url.searchParams.get("host");
				if (host === null) return new Response("No hosted given\n", { status: 401 });
				const knownNodes = this._client.rpcClient.http.getPeers();
				if (knownNodes.find((node) => node.host === host) !== undefined) return new Response("Already known\n");
				await this._client.rpcClient.http.add(host);
				return new Response("Announced\n");
			} else if (url.pathname?.startsWith("/download/")) {
				const hash = Utils.sha256(url.pathname.split("/")[2]);
				const fileId = url.pathname.split("/")[3] ?? "";
				const infohash = Array.from(decodeURIComponent(url.searchParams.get("info_hash") ?? "")).map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");

				if (this.processingRequests.has(hash)) {
					if (this._client.config.logLevel === "verbose") console.log(`  ${hash}  Waiting for existing request with same hash`);
					await this.processingRequests.get(hash);
				}
				const processingPromise = (async () => {
					const file = await File.init({ hash, infohash }, this._client, true);
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
					console.log(`  ${hash}  Signal Strength:`, fileContent.signal, Utils.estimateHops(fileContent.signal));

					headers.set("Content-Length", String(file.size));
					if (file.name !== undefined && file.name !== null) {
						headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name.replace(/[^a-zA-Z0-9._-]/g, "").replace(/\s+/g, " ").trim()).replace(/%20/g, " ").replace(/(\.\w+)$/, " [HYDRAFILES]$1")}"`);
					}

					return new Response(fileContent.file, { headers });
				})();

				this.processingRequests.set(hash, processingPromise);

				let response: Response;
				try {
					response = await processingPromise;
				} finally {
					this.processingRequests.delete(hash);
				}
				return response;
			} else if (url.pathname?.startsWith("/infohash/")) {
				const infohash = url.pathname.split("/")[2];

				if (this.processingRequests.has(infohash)) {
					console.log(`  ${infohash}  Waiting for existing request with same infohash`);
					await this.processingRequests.get(infohash);
				}
				const processingPromise = (async () => {
					const file = this._client.files.files.get(infohash);
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

				this.processingRequests.set(infohash, processingPromise);

				try {
					await processingPromise;
				} finally {
					this.processingRequests.delete(infohash);
				}
			} else if (url.pathname === "/upload") {
				const uploadSecret = req.headers.get("x-hydra-upload-secret");
				if (uploadSecret !== this._client.config.uploadSecret) {
					return new Response("401 Unauthorized\n", { status: 401 });
				}

				const form = await req.formData();
				const formData = {
					hash: form.get("hash")?.toString(),
					file: form.get("file") as globalThis.File | null,
				};

				if (typeof formData.hash === "undefined" || typeof formData.file === "undefined" || formData.file === null) return new Response("400 Bad Request\n", { status: 400 });

				const hash = Utils.sha256(formData.hash[0]);

				const file = await File.init({ hash }, this._client, true);
				if (!file) throw new Error("Failed to build file");
				if ((file.name === null || file.name.length === 0) && formData.file.name !== null) {
					file.name = formData.file.name;
					file.cacheFile(new Uint8Array(await formData.file.arrayBuffer()));
					file.save();
				}

				console.log("Uploading", file.hash);

				if (await this._client.fs.exists(join("files", file.hash))) return new Response("200 OK\n");

				if (!this._client.config.permaFiles.includes(hash)) this._client.config.permaFiles.push(hash);
				await this._client.fs.writeFile("config.json", new TextEncoder().encode(JSON.stringify(this._client.config, null, 2)));
				return new Response("200 OK\n");
			} else if (url.pathname === "/files") {
				const rows = Array.from(this._client.files.files.values()).map((row) => {
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
			} else if (url.pathname.startsWith("/file/")) {
				const id = url.pathname.split("/")[2];
				let file: File | undefined;
				try {
					file = this._client.files.files.get(id);
				} catch (e) {
					const err = e as Error;
					if (err.message === "File not found") return new Response("File not found", { headers, status: 404 });
					else throw err;
				}

				headers.set("Content-Type", "application/json");
				headers.set("Cache-Control", "public, max-age=10800");
				if (!file) return new Response("File not found", { headers, status: 404 });
				return new Response(JSON.stringify(file.toFileAttributes()), { headers });
			} else if (url.pathname.startsWith("/endpoint/")) {
				const hostname = url.pathname.split("/")[2];
				const pubKey = await Utils.exportPublicKey(this._client.keyPair.publicKey);

				if (hostname === `${base32Encode(new TextEncoder().encode(pubKey.x)).toLowerCase().replace(/=+$/, "")}.${base32Encode(new TextEncoder().encode(pubKey.y)).toLowerCase().replace(/=+$/, "")}`) {
					const body = this._client.config.reverseProxy
						? await (await fetch(this._client.config.reverseProxy)).text()
						: (typeof this.handleCustomRequest === "undefined" ? "Hello World!" : await this.handleCustomRequest(new Request(`hydra://${hostname}/`)));
					const signature = await Utils.signMessage(this._client.keyPair.privateKey, body);

					headers.set("hydra-signature", signature);
					return new Response(body, { headers });
				} else {
					if (this.processingRequests.has(hostname)) {
						if (this._client.config.logLevel === "verbose") console.log(`  ${hostname}  Waiting for existing request with same hostname`);
						await this.processingRequests.get(hostname);
					}
					if (hostname in this.cachedHostnames) return new Response(this.cachedHostnames[hostname].body, { headers: this.cachedHostnames[hostname].headers });

					console.log(`  ${hostname}  Fetching endpoint response from peers`);
					const responses = this._client.rpcClient.fetch(`http://localhost/endpoint/${hostname}`);

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

					this.processingRequests.set(hostname, processingPromise);

					let response: Response | undefined;
					try {
						response = await processingPromise;
					} catch (e) {
						const err = e as Error;
						if (err.message === "Hstname not found") return new Response("Hostname not found", { headers, status: 404 });
						else throw err;
					} finally {
						this.processingRequests.delete(hostname);
					}
					const res = { body: await response.text(), headers: response.headers };
					this.cachedHostnames[hostname] = res;
					return new Response(res.body, { headers: res.headers });
				}
			} else {
				try {
					if (url.pathname === "/" || url.pathname === "/docs") {
						headers.set("Location", "/docs/");
						return new Response("", { headers, status: 301 });
					}
					const filePath = `./public${url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname}`;
					return await serveFile(req, filePath);
				} catch (e) {
					console.log(e);
					return new Response("404 Page Not Found\n", { status: 404 });
				}
			}
		} catch (e) {
			console.error("Internal Server Error", e);
			return new Response("Internal Server Error", { status: 500 });
		}
		return new Response("Something went wrong", { status: 500 });
	};
}

export default RPCServer;
