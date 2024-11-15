import type Hydrafiles from "../../hydrafiles.ts";
import Utils from "../../utils.ts";
import { sockets } from "../routes.ts";
import type { WSMessage } from "./rtc.ts";

export default class WSPeers {
  _client: Hydrafiles;

  constructor(client: Hydrafiles) {
    this._client = client;
  }

  public fetch(input: RequestInfo, init?: RequestInit): Promise<Response | false>[] {
    const req = typeof input === "string" ? new Request(input, init) : input;

    if (!sockets.length) return [];

    const requestId = Math.random();
    const { method, url, headers } = req;
    const headersObj: Record<string, string> = {};
    headers.forEach((value, key) => headersObj[key] = value);
    const request: WSMessage = { request: { method, url, headers: headersObj, body: req.method === "GET" ? null : req.body }, id: requestId, from: this._client.rpcClient.rtc.peerId };

    const responses = sockets.map(async (socket) => {
      return await Utils.promiseWithTimeout(
        new Promise<Response | false>((resolve) => {
          socket.socket.addEventListener("message", ({ data }) => { // TODO: Change this to pull from the listener in router.ts
            const payload = JSON.parse(data) as WSMessage;
            if ("response" in payload && payload.id === requestId) {
              resolve(
                new Response(payload.response.body, {
                  status: payload.response.status,
                  statusText: payload.response.statusText,
                  headers: new Headers(headers),
                }),
              );
            }
          });
          socket.socket.send(JSON.stringify(request));
        }),
        this._client.config.timeout,
      );
    });

    return responses;
  }
}
