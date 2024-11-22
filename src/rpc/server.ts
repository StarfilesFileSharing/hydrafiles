import { ErrorDownloadFailed, ErrorNotFound } from "../errors.ts";
import type Hydrafiles from "../hydrafiles.ts";
import Utils from "../utils.ts";
import { router } from "./routes.ts";
import { serveFile } from "https://deno.land/std@0.115.0/http/file_server.ts";

class RPCServer {
	static _client: Hydrafiles;

	constructor() {
		const onListen = ({ hostname, port }: { hostname: string; port: number }): void => {
			this.onListen(hostname, port);
		};

		if (typeof window !== "undefined") return;
		let httpPort = RPCServer._client.config.httpPort;
		let httpsPort = RPCServer._client.config.httpsPort;
		while (true) {
			try {
				Deno.serve({
					port: httpPort,
					hostname: RPCServer._client.config.hostname,
					onListen,
					handler: async (req: Request): Promise<Response> => await this.handleRequest(req),
				});
				break;
			} catch (e) {
				const err = e as Error;
				if (err.name !== "AddrInUse") throw err;
				httpPort++;
			}
		}
		(async () => {
			while (true) {
				try {
					const certFile = await RPCServer._client.fs.readFile(RPCServer._client.config.sslCertPath);
					if (certFile instanceof Error) {
						console.error(certFile);
						break;
					}
					const cert = new TextDecoder().decode(certFile);
					const keyFile = await RPCServer._client.fs.readFile(RPCServer._client.config.sslKeyPath);
					if (keyFile instanceof Error) {
						console.error(keyFile);
						break;
					}
					const key = new TextDecoder().decode(keyFile);
					Deno.serve({
						port: httpsPort,
						cert,
						key,
						hostname: RPCServer._client.config.hostname,
						onListen,
						handler: async (req: Request): Promise<Response> => await this.handleRequest(req),
					});
					break;
				} catch (e) {
					const err = e as Error;
					if (err.name !== "AddrInUse") throw err;
					httpsPort++;
				}
			}
		})();
	}

	private onListen = async (hostname: string, port: number): Promise<void> => {
		console.log(`Server started at ${hostname}:${port}`);
		console.log("Testing network connection");
		const file = RPCServer._client.files.filesHash.get("04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f");
		if (!file) return;
		if (!(await file.download())) console.error("Download test failed, cannot connect to network");
		else {
			console.log("Connected to network");
			if (Utils.isIp(RPCServer._client.config.publicHostname) && Utils.isPrivateIP(RPCServer._client.config.publicHostname)) console.error("Public hostname is a private IP address, cannot announce to other nodes");
			else {
				console.log(`Testing downloads ${RPCServer._client.config.publicHostname}/download/04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f`);
				if (!file) console.error("Failed to build file");
				else {
					const self = RPCServer._client.rpcClient.http.getSelf();
					if (self instanceof ErrorNotFound) console.error("Failed to find self in peers");
					else {
						const response = await self.downloadFile(file);
						if (response instanceof ErrorDownloadFailed) console.error("Test: Failed to download file from self");
						else {
							console.log("Announcing HTTP server to nodes");
							RPCServer._client.rpcClient.fetch(`http://localhost/announce?host=${RPCServer._client.config.publicHostname}`);
						}
						await RPCServer._client.rpcClient.http.add(RPCServer._client.config.publicHostname);
					}
				}
			}
		}
	};

	handleRequest = async (req: Request): Promise<Response> => {
		console.log(`Request:  ${req.url}`);
		const url = new URL(req.url);

		const headers = new Headers();
		headers.set("Access-Control-Allow-Origin", "*");

		if ((url.pathname === "/" || url.pathname === "/docs") && req.headers.get("upgrade") !== "websocket") {
			headers.set("Location", "/docs/");
			return new Response("", { headers, status: 301 });
		}

		try {
			try {
				const url = new URL(req.url);
				const filePath = `./public${url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname}`;
				return await serveFile(req, filePath);
			} catch (_) {
				const routeHandler = req.headers.get("upgrade") === "websocket" ? router.get(`WS`) : router.get(`/${url.pathname.split("/")[1]}`);
				if (routeHandler) return await routeHandler(req, headers, RPCServer._client);
				return new Response("404 Page Not Found\n", { status: 404 });
			}
		} catch (e) {
			console.error("Internal Server Error", e);
			return new Response("Internal Server Error", { status: 500 });
		}
	};
}

export default RPCServer;
