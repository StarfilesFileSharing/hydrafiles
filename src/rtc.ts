import type { RTCDataChannel, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "npm:werift";
import { handleRequest } from "./server.ts";
import type Hydrafiles from "./hydrafiles.ts";

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

type Message = { announce: true; from: number } | { offer: RTCSessionDescription; from: number; to: number } | { answer: RTCSessionDescription; from: number; to: number } | { iceCandidate: RTCIceCandidate; from: number; to: number };
type PeerConnection = { conn: RTCPeerConnection; channel: RTCDataChannel };
type PeerConnections = { [id: string]: { offered?: PeerConnection; answered?: PeerConnection } };

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

const peerId = Math.random();

class WebRTC {
	_client: Hydrafiles;
	peerId: number;
	websockets: WebSocket[];
	peerConnections: PeerConnections = {};
	messageQueue: Message[] = [];
	seenMessages: Set<string>;

	constructor(client: Hydrafiles) {
		this._client = client;
		this.peerId = peerId;
		this.websockets = [new WebSocket("wss://rooms.deno.dev/")];
		this.seenMessages = new Set();
	}

	static async init(client: Hydrafiles): Promise<WebRTC> {
		const webRTC = new WebRTC(client);
		const peers = await client.peers.getPeers(true);
		for (let i = 0; i < peers.length; i++) {
			try {
				webRTC.websockets.push(new WebSocket(peers[i].host.replace("https://", "wss://").replace("http://", "ws://")));
			} catch (e) {
				console.error(e);
				continue;
			}
		}

		for (let i = 0; i < webRTC.websockets.length; i++) {
			webRTC.websockets[i].onopen = () => {
				console.log(`WebRTC: (1/12): Announcing to ${webRTC.websockets[i].url}`);
				const message: Message = { announce: true, from: webRTC.peerId };
				webRTC.wsMessage(message);
				setInterval(() => webRTC.wsMessage(message), client.config.announceSpeed);
			};

			webRTC.websockets[i].onmessage = async (event) => {
				const message = JSON.parse(event.data) as Message;
				if (message === null) return;

				if (webRTC.seenMessages.has(event.data)) return;
				webRTC.seenMessages.add(event.data);

				const conns = webRTC.peerConnections[message.from];
				if ("announce" in message) {
					if (conns || message.from === peerId) return;
					console.log(`WebRTC: (2/12): ${message.from} Received announce`);
					await webRTC.handleAnnounce(message.from);
				} else if ("offer" in message) {
					if (message.to === webRTC.peerId) await webRTC.handleOffer(message.from, message.offer);
				} else if ("answer" in message) {
					if (!conns || !conns.offered || message.to !== webRTC.peerId) return;
					await webRTC.handleAnswer(message.from, message.answer);
				} else if ("iceCandidate" in message) {
					if (!conns || !conns.offered || message.to !== webRTC.peerId) return;
					console.log(`WebRTC: (8/12): ${message.from} Received ICE candidate`);
					await conns.offered.conn.addIceCandidate(message.iceCandidate);
				} else console.warn("Unknown message type received", message);
			};
		}
		return webRTC;
	}

	private async createPeerConnection(from: number): Promise<PeerConnection> {
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
			console.log(`WebRTC: (10/12): Received request`);
			const { id, url, ...data } = JSON.parse(e.data as string);
			const req = new Request(url, data);
			const response = await handleRequest(req, this._client);
			const headersObj: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headersObj[key] = value;
			});
			const body = arrayBufferToUnicodeString(new Uint8Array(await response.arrayBuffer()));
			const status = response.status;
			const statusText = response.statusText;

			console.log(`WebRTC: (11/12): Sending response`);
			channel.send(JSON.stringify({ body, status, statusText, headers: headersObj, id }));
		};
		conn.addEventListener("iceconnectionstatechange", () => {
			if (conn.iceConnectionState === "disconnected" || conn.iceConnectionState === "closed" || conn.iceConnectionState === "failed") {
				console.log("WebRTC (13/12) Connection closed. Cleaning up peer connection.");
				this.cleanupPeerConnection(conn);
			}
		});

		conn.onicecandidate = (event) => {
			if (event.candidate) {
				console.log(`WebRTC: (6/12): ${from} Sending ICE candidate`);
				this.wsMessage({ iceCandidate: event.candidate, to: from, from: this.peerId });
			}
		};
		conn.onnegotiationneeded = async () => {
			if (conn.signalingState === "stable" || this.peerConnections[from]?.offered?.channel.readyState === "open" || this.peerConnections[from]?.answered?.channel.readyState === "open") return;

			const offer = await conn.createOffer();
			await conn.setLocalDescription(offer);
			console.log(`WebRTC: (3/12): ${from} Sending offer from`, extractIPAddress(offer.sdp));
			this.wsMessage({ offer, to: from, from: this.peerId });
		};

		return { conn, channel };
	}

	private cleanupPeerConnection(conn: RTCPeerConnection): void {
		const remotePeerId = Object.keys(this.peerConnections).find((id) => this.peerConnections[id].offered?.conn === conn || this.peerConnections[id].answered?.conn === conn);

		if (remotePeerId) {
			const peerConns = this.peerConnections[remotePeerId];
			if (peerConns.offered?.conn === conn) {
				console.log(`WebRTC (13/12):  ${remotePeerId}  Offered connecton has ${conn.iceConnectionState}`);
				peerConns.offered.conn.close();
				delete peerConns.offered;
			} else if (peerConns.answered?.conn === conn) {
				console.log(`WebRTC: (13/12):  ${remotePeerId}  Answered connecton has ${conn.iceConnectionState}`);
				peerConns.answered.conn.close();
				delete peerConns.answered;
			}
			if (!peerConns.offered && !peerConns.answered) delete this.peerConnections[remotePeerId];
		}
	}

	private wsMessage(message: Message): void {
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

	private async handleAnnounce(from: number): Promise<void> {
		if (this.peerConnections[from] && this.peerConnections[from].offered) return;
		if (!this.peerConnections[from]) this.peerConnections[from] = {};
		this.peerConnections[from].offered = await this.createPeerConnection(from);
	}

	private async handleOffer(from: number, offer: RTCSessionDescription): Promise<void> {
		if (typeof this.peerConnections[from] === "undefined") this.peerConnections[from] = {};
		if (this.peerConnections[from].answered && this.peerConnections[from].answered?.channel.readyState === "open") {
			console.warn("WebRTC: (13/12): Rejecting offer - Already have open connection answered by you");
			return;
		}
		if (this.peerConnections[from].offered && this.peerConnections[from].offered?.channel.readyState === "open") {
			console.warn("WebRTC: (13/12): Rejecting offer - Already have open connection offered by you");
			return;
		}

		console.log(`WebRTC: (4/12): ${from} Received offer`);

		this.peerConnections[from].answered = await this.createPeerConnection(from);
		if (this.peerConnections[from].answered.conn.signalingState !== "stable" && this.peerConnections[from].answered.conn.signalingState !== "have-remote-offer") {
			console.warn("Peer connection in unexpected state 1:", this.peerConnections[from].answered.conn.signalingState);
			return;
		}
		await this.peerConnections[from].answered.conn.setRemoteDescription(offer);
		if (this.peerConnections[from].answered.conn.signalingState !== "have-remote-offer") {
			console.warn("Peer connection in unexpected state 2:", this.peerConnections[from].answered.conn.signalingState);
			return;
		}
		console.log("Current signaling state:", this.peerConnections[from].answered.conn.signalingState);
		try {
			const answer = await this.peerConnections[from].answered.conn.createAnswer();
			if (this.peerConnections[from].answered.conn.signalingState !== "have-remote-offer") return;
			await this.peerConnections[from].answered.conn.setLocalDescription(answer);

			console.log(`WebRTC: (5/12): ${from} Sending answer from`, extractIPAddress(answer.sdp));
			this.wsMessage({ answer, to: from, from: this.peerId });
		} catch (e) {
			console.error(e);
		}
	}

	private async handleAnswer(from: number, answer: RTCSessionDescription): Promise<void> {
		if (!this.peerConnections[from].offered || this.peerConnections[from].offered.conn.signalingState !== "have-local-offer") {
			console.warn("WebRTC: (13/12): Rejecting answer");
			return;
		}
		console.log(`WebRTC: (7/12): ${from} Received answer`, answer, this.peerConnections[from].offered.conn.signalingState);
		await this.peerConnections[from].offered.conn.setRemoteDescription(answer);
	}

	public sendRequest(input: RequestInfo, init?: RequestInit): Promise<Response>[] {
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

			console.log(`WebRTC: (9/12): ${connIDs[i]} Sending request`);
			connection.channel.send(JSON.stringify(request));

			const responsePromise = new Promise<Response>((resolve, reject) => {
				connection.channel.onmessage = (e) => {
					try {
						const { id, status, statusText, headers, body } = JSON.parse(e.data as string);
						console.log(`WebRTC: (12/12):  ${id}  Received response`);
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

export default WebRTC;
