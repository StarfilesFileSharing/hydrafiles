import type { RTCDataChannel, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "npm:werift";
import { handleRequest } from "./server.ts";
import type Hydrafiles from "./hydrafiles.ts";

type Message = { announce: true; from: number } | { offer: RTCSessionDescription; from: number; to: number } | { answer: RTCSessionDescription; from: number; to: number } | { iceCandidate: RTCIceCandidate; from: number; to: number };
type PeerConnection = { conn: RTCPeerConnection; channel: RTCDataChannel; iceCandidates: RTCIceCandidate[] };
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

class WebRTC {
	_client: Hydrafiles;
	peerId: number;
	websockets: WebSocket[];
	peerConnections: PeerConnections = {};
	messageQueue: Message[] = [];

	constructor(client: Hydrafiles) {
		this._client = client;
		this.peerId = Math.random();
		this.websockets = [new WebSocket("wss://rooms.deno.dev/")];
	}

	static async init(client: Hydrafiles): Promise<WebRTC> {
		const webRTC = new WebRTC(client);
		const peers = await client.peers.getPeers();
		for (let i = 0; i < peers.length; i++) {
			webRTC.websockets.push(new WebSocket(peers[i].host.replace("https://", "wss://").replace("http://", "ws://")));
		}

		for (let i = 0; i < webRTC.websockets.length; i++) {
			webRTC.websockets[i].onopen = () => {
				console.log(`(1/12) Announcing to ${webRTC.websockets[i].url}`);
				webRTC.wsMessage({ announce: true, from: webRTC.peerId });
			};

			webRTC.websockets[i].onmessage = async (event) => {
				const message = JSON.parse(event.data) as Message;
				if ("announce" in message) {
					if (webRTC.peerConnections[message.from]) return;
					console.log(`(2/12) ${message.from} Received announce`);
					await webRTC.handleAnnounce(message.from);
				} else if ("offer" in message) {
					if (typeof message.offer.sdp === "undefined" || message.to !== webRTC.peerId) return;
					console.log(`(4/12) ${message.from} Received offer`);
					await webRTC.handleOffer(message.from, message.offer);
				} else if ("answer" in message) {
					// @ts-expect-error:
					if (!webRTC.peerConnections[message.from] || !webRTC.peerConnections[message.from].offered || webRTC.peerConnections[message.from].offered.conn.signalingState === "stable" || message.to !== webRTC.peerId) return;
					console.log(`(7/12) ${message.from} Received answer`);
					await webRTC.handleAnswer(message.from, message.answer);
				} else if ("iceCandidate" in message) {
					if (!webRTC.peerConnections[message.from] || !webRTC.peerConnections[message.from].offered || message.to !== webRTC.peerId) return;
					console.log(`(8/12) ${message.from} Received ICE candidate`);
					// @ts-expect-error: IDK why this isn't getting caught
					await webRTC.peerConnections[message.from].offered.conn.addIceCandidate(message.iceCandidate);
				} else console.warn("Unknown message type received", message);
			};
		}
		return webRTC;
	}

	private async createPeerConnection(): Promise<PeerConnection> {
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
		const iceCandidates: RTCIceCandidate[] = [];

		channel.onmessage = async (e) => {
			console.log(`(10/12) Received request`);
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

			console.log(`(11/12) Sending response`);
			channel.send(JSON.stringify({ body, status, statusText, headers: headersObj, id }));
		};
		conn.onicecandidate = (event) => {
			if (event.candidate) iceCandidates.push(event.candidate);
		};

		return { conn, channel, iceCandidates };
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
		const conn = await this.createPeerConnection();
		if (!this.peerConnections[from]) this.peerConnections[from] = {};
		this.peerConnections[from].offered = conn;
		const offer = await conn.conn.createOffer();
		await conn.conn.setLocalDescription(offer);
		console.log(`(3/12) ${from} Sending offer`);
		this.wsMessage({ offer, to: from, from: this.peerId });
	}

	private async handleOffer(from: number, offer: RTCSessionDescription): Promise<void> {
		let remoteDesc: RTCSessionDescription;
		if (typeof window === "undefined") {
			const { RTCSessionDescription } = await import("npm:werift");
			remoteDesc = new RTCSessionDescription(offer.sdp, "offer");
			// @ts-expect-error:
		} else remoteDesc = new RTCSessionDescription(offer, "offer");
		if (!this.peerConnections[from]) this.peerConnections[from] = {};
		this.peerConnections[from].answered = await this.createPeerConnection();
		if (!this.peerConnections[from].answered) throw new Error("Unreachable code reached");
		await this.peerConnections[from].answered.conn.setRemoteDescription(remoteDesc);
		const answer = await this.peerConnections[from].answered.conn.createAnswer();
		await this.peerConnections[from].answered.conn.setLocalDescription(answer);
		for (let i = 0; i < this.websockets.length; i++) {
			console.log(`(5/12) ${from} Announcing answer`);
			this.wsMessage({ answer, to: from, from: this.peerId });
		}

		const peerConnection = this.peerConnections[from].answered;
		if (peerConnection) {
			const { iceCandidates } = peerConnection;
			for (const candidate of iceCandidates) {
				console.log(`(6/12) ${from} Sending ICE candidate`);
				this.wsMessage({ iceCandidate: candidate, to: from, from: this.peerId });
			}
		}
	}

	private async handleAnswer(from: number, answer: RTCSessionDescription): Promise<void> {
		let sessionDescription: RTCSessionDescription;
		if (typeof window === "undefined") {
			const { RTCSessionDescription } = await import("npm:werift");
			sessionDescription = new RTCSessionDescription(answer.sdp, "answer");
			// @ts-expect-error:
		} else sessionDescription = new RTCSessionDescription(answer, "answer");
		// @ts-expect-error: IDK why this isn't getting caught
		await this.peerConnections[from].offered.conn.setRemoteDescription(sessionDescription);
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

			console.log(`(9/12) Sending request to ${connIDs[i]}`);
			connection.channel.send(JSON.stringify(request));

			const responsePromise = new Promise<Response>((resolve, reject) => {
				connection.channel.onmessage = (e) => {
					try {
						console.log(`(12/12) Received response`);
						const { id, status, statusText, headers, body } = JSON.parse(e.data as string);
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
