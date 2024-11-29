import Utils from "../../utils.ts";
import { ErrorDownloadFailed, ErrorRequestFailed, ErrorTimeout } from "../../errors.ts";
import { ErrorNotFound } from "../../errors.ts";
import RPCPeers from "../RPCPeers.ts";
import { type DecodedResponse, HydraResponse } from "../routes.ts";
import RPCPeer from "../RPCPeer.ts";

export class HTTPClient {
	private host: string;

	constructor(host: string) {
		this.host = host;
	}

	public async fetch(url: URL, method = "GET", headers: { [key: string]: string } = {}, body: string | undefined = undefined): Promise<DecodedResponse | ErrorRequestFailed | ErrorTimeout> {
		try {
			const peerUrl = new URL(this.host);
			url.hostname = peerUrl.hostname;
			url.protocol = peerUrl.protocol;
			const res = await Utils.promiseWithTimeout(fetch(url.toString(), { method, headers, body }), RPCPeers._client.config.timeout);
			if (res instanceof Error) return res;
			return (await HydraResponse.from(res)).toDecodedResponse();
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			if (message !== "Failed to fetch") throw new ErrorRequestFailed();
			return (await HydraResponse.from(new Response(message, { status: 500 }))).toDecodedResponse();
		}
	}
}

export default class HTTPServer {
	private _rpcPeers: RPCPeers;
	constructor(rpcPeer: RPCPeers) {
		this._rpcPeers = rpcPeer;
		if (typeof window === "undefined") this.listen();
	}

	private async listen(): Promise<void> {
		const onListen = ({ hostname, port }: { hostname: string; port: number }): void => {
			this.onListen(hostname, port);
		};

		if (typeof window !== "undefined") return;
		let httpPort = RPCPeers._client.config.httpPort;
		let httpsPort = RPCPeers._client.config.httpsPort;
		while (true) {
			try {
				Deno.serve({
					port: httpPort,
					hostname: RPCPeers._client.config.hostname,
					onListen,
					handler: async (req: Request): Promise<Response> => await RPCPeers._client.rpcPeers.handleRequest(req),
				});
				break;
			} catch (e) {
				const err = e as Error;
				if (err.name !== "AddrInUse") throw err;
				httpPort++;
			}
		}
		const certFile = await RPCPeers._client.fs.readFile(RPCPeers._client.config.sslCertPath);
		const keyFile = await RPCPeers._client.fs.readFile(RPCPeers._client.config.sslKeyPath);
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
						hostname: RPCPeers._client.config.hostname,
						onListen,
						handler: async (req: Request): Promise<Response> => await RPCPeers._client.rpcPeers.handleRequest(req),
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
		const file = RPCPeers._client.files.filesHash.get("04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f");
		if (!file) return;
		if (!(await file.download())) console.error("RPC:      Download test failed, cannot connect to network");
		else {
			console.log("RPC:      Connected to network");
			if (Utils.isIp(RPCPeers._client.config.publicHostname) && Utils.isPrivateIP(RPCPeers._client.config.publicHostname)) console.error("Public hostname is a private IP address, cannot announce to other nodes");
			else {
				console.log(`HTTP:     Testing downloads ${RPCPeers._client.config.publicHostname}/download/04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f`);
				const self = RPCPeers._client.rpcPeers.http.getSelf();
				if (self instanceof ErrorNotFound) console.error("HTTP:     Failed to find self in peers");
				else {
					const response = await self.downloadFile(file);
					if (response instanceof ErrorDownloadFailed) console.error("HTTP:      Failed to download file from self");
					else {
						console.log("HTTP:     Announcing server to nodes");
						RPCPeers._client.rpcPeers.fetch(new URL(`https://localhost/announce?host=${RPCPeers._client.config.publicHostname}`));
					}
					await RPCPeers._client.rpcPeers.add({ host: RPCPeers._client.config.publicHostname });
				}
			}
		}
	};

	public getSelf(): RPCPeer | ErrorNotFound {
		const peer = this._rpcPeers.peers.get(RPCPeers._client.config.publicHostname);
		if (!peer) throw new ErrorNotFound();
		return peer;
	}
}
