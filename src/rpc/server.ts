import type Hydrafiles from "../hydrafiles.ts";
import Utils from "../utils.ts";
import { router } from "./routes.ts";

class RPCServer {
	private _client: Hydrafiles;

	constructor(client: Hydrafiles) {
		this._client = client;

		const onListen = ({ hostname, port }: { hostname: string; port: number }): void => {
			this.onListen(hostname, port);
		};

		if (typeof window !== "undefined") return;
		let httpPort = client.config.httpPort;
		let httpsPort = client.config.httpsPort;
		while (true) {
			try {
				Deno.serve({
					port: httpPort,
					hostname: client.config.hostname,
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
					const certFile = await client.fs.readFile(client.config.sslCertPath);
					if (!certFile) throw new Error("SSL Error: Invalid cert");
					const cert = new TextDecoder().decode(certFile);
					const keyFile = await client.fs.readFile(client.config.sslKeyPath);
					if (!keyFile) throw new Error("SSL Error: Invalid key");
					const key = new TextDecoder().decode(keyFile);
					Deno.serve({
						port: httpsPort,
						cert,
						key,
						hostname: client.config.hostname,
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

		if (url.pathname === "/" || url.pathname === "/docs") {
			headers.set("Location", "/docs/");
			return new Response("", { headers, status: 301 });
		}

		try {
			const routeHandler = req.headers.get("upgrade") === "websocket" ? router.get(`/${url.pathname.split("/")[1]}`) : router.get(`WS`);
			if (routeHandler) return await routeHandler(req, headers, this._client);
			return new Response("404 Page Not Found\n", { status: 404 });
		} catch (e) {
			console.error("Internal Server Error", e);
			return new Response("Internal Server Error", { status: 500 });
		}
	};
}

export default RPCServer;
