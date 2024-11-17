import type { RTCDataChannel, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "npm:werift";
import type RPCClient from "../client.ts";
import type { EthAddress } from "../../wallet.ts";

export type SignallingAnnounce = { announce: true; from: EthAddress };
export type SignallingOffer = { offer: RTCSessionDescription; from: EthAddress; to: EthAddress };
export type SignallingAnswer = { answer: RTCSessionDescription; from: EthAddress; to: EthAddress };
export type SignallingIceCandidate = { iceCandidate: RTCIceCandidate; from: EthAddress; to: EthAddress };
export type WSRequest = { request: { method: string; url: string; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null }; id: number; from: EthAddress };
export type WSResponse = { response: { body: string; status: number; statusText: string; headers: Record<string, string> }; id: number; from: EthAddress };
export type WSMessage = SignallingAnnounce | SignallingOffer | SignallingAnswer | SignallingIceCandidate | WSRequest | WSResponse;

type PeerConnection = { conn: RTCPeerConnection; channel: RTCDataChannel; startTime: number };
type PeerConnections = { [id: string]: { offered?: PeerConnection; answered?: PeerConnection } };

function extractIPAddress(sdp: string): string {
	const ipv4Regex = /c=IN IP4 (\d{1,3}(?:\.\d{1,3}){3})/g;
	const ipv6Regex = /c=IN IP6 ([0-9a-fA-F:]+)/g;
	const ipAddresses = [];
	let match;
	while ((match = ipv4Regex.exec(sdp)) !== null) {
		ipAddresses.push(match[1]);
	}
	while ((match = ipv6Regex.exec(sdp)) !== null) {
		ipAddresses.push(match[1]);
	}

	return ipAddresses.filter((ip) => ip !== "0.0.0.0")[0] ?? ipAddresses[0];
}

function arrayBufferToUnicodeString(buffer: ArrayBuffer): string {
	const uint16Array = new Uint16Array(buffer);
	const chunkSize = 10000;
	let result = "";
	// Process the array in chunks
	for (let i = 0; i < uint16Array.length; i += chunkSize) {
		const chunk = uint16Array.slice(i, i + chunkSize);
		result += String.fromCharCode(...chunk);
	}

	return result;
}

const receivedPackets: Record<string, string[]> = {};

class RTCPeers {
	private _rpcClient: RPCClient;
	peerId: EthAddress;
	websockets: WebSocket[];
	peerConnections: PeerConnections = {};
	messageQueue: WSMessage[] = [];
	seenMessages: Set<string> = new Set();

	constructor(rpcClient: RPCClient) {
		this._rpcClient = rpcClient;
		this.websockets = [new WebSocket("wss://rooms.deno.dev/")];

		this.peerId = rpcClient._client.wallet.address();

		const peers = rpcClient.http.getPeers(true);
		for (let i = 0; i < peers.length; i++) {
			try {
				this.websockets.push(new WebSocket(peers[i].host.replace("https://", "wss://").replace("http://", "ws://")));
			} catch (e) {
				if (rpcClient._client.config.logLevel === "verbose") console.error(e);
				continue;
			}
		}

		for (let i = 0; i < this.websockets.length; i++) {
			this.websockets[i].onopen = () => {
				console.log(`WebRTC:   Announcing to ${this.websockets[i].url}`);
				const message: WSMessage = { announce: true, from: this.peerId };
				this.wsMessage(message);
				setInterval(() => this.wsMessage(message), rpcClient._client.config.announceSpeed);
			};

			this.websockets[i].onmessage = async (event) => {
				const message = JSON.parse(event.data) as WSMessage;
				if (message === null || message.from === this.peerId || this.seenMessages.has(event.data) || ("to" in message && message.to !== this.peerId)) return;
				this.seenMessages.add(event.data);
				if ("announce" in message) await this.handleAnnounce(message.from);
				else if ("offer" in message) await this.handleOffer(message.from, message.offer);
				else if ("answer" in message) await this.handleAnswer(message.from, message.answer);
				else if ("iceCandidate" in message) this.handleIceCandidate(message.from, message.iceCandidate);
				else if ("request" in message) this.handleWsRequest(this.websockets[i], message);
				else if (!("response" in message)) console.warn("WebRTC:   Unknown message type received", message);
			};
		}
	}

	async createPeerConnection(from: EthAddress): Promise<PeerConnection> {
		this._rpcClient._client.events.log(this._rpcClient._client.events.rtcEvents.RTCOpen);
		const config = {
			iceServers: [
				{ urls: "stun:stun.l.google.com:19302" },
				{ urls: "stun:stun.ekiga.net" },
				{ urls: "stun:stun.stunprotocol.org:3478" },
				{ urls: "stun:stun.voipbuster.com" },
			],
		};
		let conn: RTCPeerConnection;
		if (typeof window === "undefined") {
			const { RTCPeerConnection } = await import("npm:werift");
			conn = new RTCPeerConnection(config);
			// @ts-expect-error:
		} else conn = new RTCPeerConnection(config);
		const channel = conn.createDataChannel("chat", { negotiated: true, id: 0 });

		channel.onmessage = async (e) => {
			console.log(`WebRTC:   Received request`);
			const { id, url, ...data } = JSON.parse(e.data as string);
			const req = new Request(url, data);
			const response = await this._rpcClient._client.rpcServer.handleRequest(req);
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			const body = arrayBufferToUnicodeString(new Uint8Array(await response.arrayBuffer()));
			const status = response.status;
			const statusText = response.statusText;

			console.log(`WebRTC:   Sending response`);
			const message = JSON.stringify({ body, status, statusText, headers, id });
			channel.send(message);

			const maxPacketSize = 8 * 1024;
			const total = Math.ceil(message.length / maxPacketSize);

			for (let i = 0; i < total; i++) {
				const start = i * maxPacketSize;
				const end = start + maxPacketSize;
				const packet = {
					id,
					i,
					total,
					body: message.slice(start, end),
				};
				channel.send(JSON.stringify(packet));
			}
		};
		conn.addEventListener("iceconnectionstatechange", () => {
			if (conn.iceConnectionState === "disconnected" || conn.iceConnectionState === "closed" || conn.iceConnectionState === "failed") {
				console.warn(`WebRTC:   ${from}  Connection closed. Cleaning up peer connection.`);
				this.cleanupPeerConnection(conn);
			}
		});

		conn.onicecandidate = (event) => {
			if (event.candidate) {
				if (this._rpcClient._client.config.logLevel === "verbose") console.log(`WebRTC:   ${from}  Sending ICE candidate`);
				this.wsMessage({ iceCandidate: event.candidate, to: from, from: this.peerId });
			}
		};
		conn.onnegotiationneeded = async () => {
			try {
				if (!this.peerConnections[from] || !this.peerConnections[from].offered || this.peerConnections[from].offered.channel.readyState === "open") return;

				const offer = await conn.createOffer();
				await conn.setLocalDescription(offer);
				console.log(`WebRTC:   ${from}  Sending offer from`, extractIPAddress(offer.sdp));
				this.wsMessage({ offer, to: from, from: this.peerId });
			} catch (e) {
				console.error(e);
			}
		};

		setTimeout(() => {
			if (conn.signalingState === "have-local-offer") {
				this._rpcClient._client.events.log(this._rpcClient._client.events.rtcEvents.RTCTimeout);
				console.warn(`WebRTC:   ${from}  Connection timed out. Cleaning up peer connection.`);
				this.cleanupPeerConnection(conn);
			}
		}, this._rpcClient._client.config.timeout);

		return { conn, channel, startTime: +new Date() };
	}

	cleanupPeerConnection(conn: RTCPeerConnection): void {
		this._rpcClient._client.events.log(this._rpcClient._client.events.rtcEvents.RTCClose);
		const remotePeerId = Object.keys(this.peerConnections).find((id) => this.peerConnections[id].offered?.conn === conn || this.peerConnections[id].answered?.conn === conn);

		if (remotePeerId) {
			const peerConns = this.peerConnections[remotePeerId];
			if (peerConns.offered?.conn === conn) {
				peerConns.offered.conn.close();
				delete peerConns.offered;
			} else if (peerConns.answered?.conn === conn) {
				peerConns.answered.conn.close();
				delete peerConns.answered;
			}
			if (!peerConns.offered && !peerConns.answered) delete this.peerConnections[remotePeerId];
		}
	}

	wsMessage(message: WSMessage): void {
		this.messageQueue.push(message);
		for (let i = 0; i < this.websockets.length; i++) {
			if (this.websockets[i].readyState === 1) this.websockets[i].send(JSON.stringify(message));
			else {
				this.websockets[i].addEventListener("open", () => {
					this.websockets[i].send(JSON.stringify(message));
				});
			}
		}
	}

	async handleAnnounce(from: EthAddress): Promise<void> {
		this._rpcClient._client.events.log(this._rpcClient._client.events.rtcEvents.RTCAnnounce);
		console.log(`WebRTC:   ${from}  Received announce`);
		if (this.peerConnections[from] && this.peerConnections[from].offered) {
			console.warn(`WebRTC:   ${from} Already offered to peer`);
			return;
		}
		if (!this.peerConnections[from]) this.peerConnections[from] = {};
		this.peerConnections[from].offered = await this.createPeerConnection(from);
	}

	async handleOffer(from: EthAddress, offer: RTCSessionDescription): Promise<void> {
		this._rpcClient._client.events.log(this._rpcClient._client.events.rtcEvents.RTCOffer);
		if (typeof this.peerConnections[from] === "undefined") this.peerConnections[from] = {};
		if (this.peerConnections[from].answered && this.peerConnections[from].answered?.channel.readyState === "open") {
			console.warn("WebRTC:   Rejecting offer - Already have open connection answered by you");
			return;
		}
		if (this.peerConnections[from].offered && this.peerConnections[from].offered?.channel.readyState === "open") {
			console.warn("WebRTC:   Rejecting offer - Already have open connection offered by you");
			return;
		}

		console.log(`WebRTC:   ${from}  Received offer from`, extractIPAddress(offer.sdp));

		this.peerConnections[from].answered = await this.createPeerConnection(from);
		if (this.peerConnections[from].answered.conn.signalingState !== "stable" && this.peerConnections[from].answered.conn.signalingState !== "have-remote-offer") {
			console.warn(`WebRTC:   ${from}  Peer connection in unexpected state 1: ${this.peerConnections[from].answered.conn.signalingState}`);
			return;
		}
		await this.peerConnections[from].answered.conn.setRemoteDescription(offer);
		if (this.peerConnections[from].answered.conn.signalingState !== "have-remote-offer") {
			console.warn(`WebRTC:   ${from}  Peer connection in unexpected state 2: ${this.peerConnections[from].answered.conn.signalingState}`);
			return;
		}
		try {
			const answer = await this.peerConnections[from].answered.conn.createAnswer();
			if (this.peerConnections[from].answered.conn.signalingState !== "have-remote-offer") return;
			await this.peerConnections[from].answered.conn.setLocalDescription(answer);

			console.log(`WebRTC:   ${from}  Sending answer from`, extractIPAddress(answer.sdp));
			this.wsMessage({ answer, to: from, from: this.peerId });
		} catch (e) {
			console.error(e);
		}
	}

	async handleAnswer(from: EthAddress, answer: RTCSessionDescription): Promise<void> {
		this._rpcClient._client.events.log(this._rpcClient._client.events.rtcEvents.RTCAnswer);
		if (!this.peerConnections[from] || !this.peerConnections[from].offered) {
			console.warn(`WebRTC:   ${from}  Rejecting answer - No open handshake`);
			return;
		}
		if (this.peerConnections[from].offered.conn.signalingState !== "have-local-offer") {
			console.warn(`WebRTC:   ${from}  Rejecting answer - Bad signalling state: ${this.peerConnections[from].offered?.conn.signalingState}`);
			return;
		}
		console.log(`WebRTC:   ${from}  Received answer`, extractIPAddress(answer.sdp));
		await this.peerConnections[from].offered.conn.setRemoteDescription(answer);
	}

	handleIceCandidate(from: EthAddress, receivedIceCandidate: RTCIceCandidate): void {
		const iceCandidate = receivedIceCandidate;
		this._rpcClient._client.events.log(this._rpcClient._client.events.rtcEvents.RTCIce);
		if (!this.peerConnections[from]) {
			console.warn(`WebRTC:   ${from}  Rejecting Ice candidates received - No open handshake`);
			return;
		}
		if (this._rpcClient._client.config.logLevel === "verbose") console.log(`WebRTC:   ${from}  Received ICE candidate`);
		if (typeof window !== "undefined") { // TODO: Figure out why this breaks on desktop
			if (this.peerConnections[from].answered) this.peerConnections[from].answered.conn.addIceCandidate(iceCandidate).catch(console.error);
			if (this.peerConnections[from].offered && this.peerConnections[from].offered.conn.remoteDescription) this.peerConnections[from].offered.conn.addIceCandidate(iceCandidate).catch(console.error);
		}
	}

	async handleWsRequest(ws: WebSocket, message: WSRequest): Promise<void> {
		const response = await this._rpcClient._client.rpcServer.handleRequest(new Request(message.request.url, { body: message.request.body, headers: message.request.headers, method: message.request.method }));
		const headersObj: Record<string, string> = {};
		response.headers.forEach((value, key) => headersObj[key] = value);
		const responseMessage: WSResponse = { id: message.id, from: this.peerId, response: { body: await response.text(), headers: headersObj, status: response.status, statusText: response.statusText } };
		if (ws.readyState === 1) ws.send(JSON.stringify(responseMessage));
	}

	public fetch(input: RequestInfo, init?: RequestInit): Promise<Response>[] {
		const req = typeof input === "string" ? new Request(input, init) : input;
		const requestId = Math.random();
		const { method, url, headers } = req;
		const headersObj: Record<string, string> = {};
		headers.forEach((value, key) => headersObj[key] = value);
		const request = { method, url, headers: headersObj, body: req.method === "GET" ? null : req.body, id: requestId };
		const connIDs = Object.keys(this.peerConnections);
		const responses: Promise<Response>[] = [];
		for (let i = 0; i < connIDs.length; i++) {
			const connections = Object.values(this.peerConnections[connIDs[i]]);
			let connection: PeerConnection | undefined;
			for (let j = 0; j < connections.length; j++) {
				if (connections[j].channel.readyState === "open") {
					connection = connections[j];
					break;
				}
			}

			if (!connection) continue;

			console.log(`WebRTC:   ${connIDs[i]} Sending request`);
			connection.channel.send(JSON.stringify(request));

			const responsePromise = new Promise<Response>((resolve, reject) => {
				connection.channel.onmessage = (e) => {
					const packet = JSON.parse(e.data as string);

					if (!receivedPackets[packet.id]) receivedPackets[packet.id] = [];
					receivedPackets[packet.id][packet.index] = packet.body;

					if (receivedPackets[packet.id].filter(Boolean).length === packet.total) {
						const message = receivedPackets[packet.id].join("");
						delete receivedPackets[packet.id];
						const fullMessage = JSON.parse(message);
						console.log("Received full message:", fullMessage);
					}

					try {
						const { id, status, statusText, headers, body } = JSON.parse(e.data as string);
						console.log(`WebRTC:   ${id}  Received response`);
						if (id !== requestId) return;
						const response = new Response(body, {
							status,
							statusText,
							headers: new Headers(headers),
						});
						resolve(response);
					} catch (error) {
						reject(`Failed to process response: ${error}`);
					}
				};
			});

			responses.push(responsePromise);
		}
		return responses;
	}
}

export default RTCPeers;
