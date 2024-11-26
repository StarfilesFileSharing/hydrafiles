import { ErrorDownloadFailed, ErrorNotFound } from "../errors.ts";
import type Hydrafiles from "../hydrafiles.ts";
import Utils from "../utils.ts";
import { router } from "./routes.ts";
import { serveFile } from "https://deno.land/std@0.115.0/http/file_server.ts";

class RPCServer {
	static _client: Hydrafiles;

	constructor() {}

	async listenHTTP(): Promise<void> {
		const rpcServer = new RPCServer();

		const onListen = ({ hostname, port }: { hostname: string; port: number }): void => {
			rpcServer.onListen(hostname, port);
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
		const certFile = await RPCServer._client.fs.readFile(RPCServer._client.config.sslCertPath);
		const keyFile = await RPCServer._client.fs.readFile(RPCServer._client.config.sslKeyPath);
		if (certFile instanceof Error) console.error(certFile);
		else if (keyFile instanceof Error) console.error(keyFile);
		else {
			const cert = new TextDecoder().decode(certFile);
			const key = new TextDecoder().decode(keyFile);
			while (true) {
				try {
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
		}
	}

	private onListen = async (hostname: string, port: number): Promise<void> => {
		console.log(`HTTP:     Listening at ${hostname}:${port}`);
		console.log("RPC:      Testing network connectivity");
		const file = RPCServer._client.files.filesHash.get("04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f");
		if (!file) return;
		if (!(await file.download())) console.error("RPC:      Download test failed, cannot connect to network");
		else {
			console.log("RPC:      Connected to network");
			if (Utils.isIp(RPCServer._client.config.publicHostname) && Utils.isPrivateIP(RPCServer._client.config.publicHostname)) console.error("Public hostname is a private IP address, cannot announce to other nodes");
			else {
				console.log(`HTTP:     Testing downloads ${RPCServer._client.config.publicHostname}/download/04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f`);
				if (!file) console.error("Failed to build file");
				else {
					const self = RPCServer._client.rpcClient.http.getSelf();
					if (self instanceof ErrorNotFound) console.error("HTTP:     Failed to find self in peers");
					else {
						const response = await self.downloadFile(file);
						if (response instanceof ErrorDownloadFailed) console.error("HTTP:      Failed to download file from self");
						else {
							console.log("HTTP:     Announcing server to nodes");
							RPCServer._client.rpcClient.fetch(`https://localhost/announce?host=${RPCServer._client.config.publicHostname}`);
						}
						await RPCServer._client.rpcClient.http.add(RPCServer._client.config.publicHostname);
					}
				}
			}
		}
	};

	handleRequest = async (req: Request): Promise<Response> => {
		const headers: { [key: string]: string } = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "hydra-signature, hydra-from",
		};
		try {
			console.log(`Request:  ${req.url}`);
			const url = new URL(req.url);

			if ((url.pathname === "/" || url.pathname === "/docs") && req.headers.get("upgrade") !== "websocket") {
				headers["Location"] = "/docs/";
				return new Response("", { headers: headers, status: 301 });
			}

			try {
				const url = new URL(req.url);
				return await serveFile(req, `./public${url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname}`);
			} catch (_) {
				try {
					return await serveFile(req, `./build${url.pathname}`);
				} catch (_) {
					if (!RPCServer._client.config.listen) return new Response("Peer has peering disabled");
					const routeHandler = req.headers.get("upgrade") === "websocket" ? RPCServer._client.rpcClient.ws.handleConnection : router.get(`/${url.pathname.split("/")[1]}`);
					if (routeHandler) {
						const response = await routeHandler(req, RPCServer._client);
						if (response instanceof Response) return response;
						response.addHeaders(headers);
						return response.response();
					}
					return new Response("404 Page Not Found\n", { status: 404, headers });
				}
			}
		} catch (e) {
			console.error(req.url, "Internal Server Error", e);
			return new Response("Internal Server Error", { status: 500, headers });
		}
	};
}

export default RPCServer;
