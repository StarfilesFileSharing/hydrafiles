import { WSRequest, type WSResponse } from "./ws.ts";
import type { RTCDataChannel, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "npm:werift";
import type { EthAddress } from "../../wallet.ts";
import { type DecodedResponse } from "../routes.ts";
import Utils from "../../utils.ts";
import { ErrorRequestFailed, type ErrorTimeout } from "../../errors.ts";
import RPCPeers from "../RPCPeers.ts";
import type Wallet from "../../wallet.ts";

export type SignallingAnnounce = { announce: true; from: EthAddress };
export type SignallingOffer = { offer: RTCSessionDescription; from: `${EthAddress}`; to: `hydra://${EthAddress}` };
export type SignallingAnswer = { answer: RTCSessionDescription; from: EthAddress; to: `hydra://${EthAddress}` };
export type SignallingIceCandidate = { iceCandidate: RTCIceCandidate; from: EthAddress; to: `hydra://${EthAddress}` };

export type SignallingMessage = SignallingAnnounce | SignallingOffer | SignallingAnswer | SignallingIceCandidate;

type PeerConnection = { conn: RTCPeerConnection; channel: RTCDataChannel; startTime: number };

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
	for (let i = 0; i < uint16Array.length; i += chunkSize) {
		const chunk = uint16Array.slice(i, i + chunkSize);
		result += String.fromCharCode(...chunk);
	}

	return result;
}

const receivedPackets: Record<string, string[]> = {};

export class RTCPeer {
	private _rpcPeers: RPCPeers;

	id: EthAddress;
	offered?: PeerConnection;
	answered?: PeerConnection;

	constructor(id: EthAddress, rpcPeers: RPCPeers) {
		this._rpcPeers = rpcPeers;
		this.id = id;
	}

	async createConnection(from: EthAddress): Promise<PeerConnection> {
		RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCOpen);
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

		channel.onmessage = (e) => {
			// @ts-expect-error:
			this.handleMessage(channel, e);
		};
		conn.addEventListener("iceconnectionstatechange", () => {
			if (conn.iceConnectionState === "disconnected" || conn.iceConnectionState === "closed" || conn.iceConnectionState === "failed") {
				console.warn(`WebRTC:   ${from}  Connection closed. Cleaning up peer connection.`);
				this.cleanupConnection(conn);
			}
		});

		conn.onicecandidate = (event) => {
			if (event.candidate) {
				if (RPCPeers._client.config.logLevel === "verbose") console.log(`WebRTC:   ${from}  Sending ICE candidate`);
				this._rpcPeers.fetch(new URL("hydra://localhosticeCandidate"), { body: JSON.stringify({ iceCandidate: event.candidate, to: from, from: this._rpcPeers.rtc.address }) });
			}
		};
		conn.onnegotiationneeded = async () => {
			try {
				if (!this.offered || this.offered.channel.readyState === "open") return;

				const offer = await conn.createOffer();
				await conn.setLocalDescription(offer);
				console.log(`WebRTC:   ${from}  Sending offer from`, extractIPAddress(offer.sdp));
				this._rpcPeers.ws.send({ offer, to: `hydra://${from}`, from: this._rpcPeers.rtc.address });
			} catch (e) {
				console.error(e);
			}
		};

		setTimeout(() => {
			if (conn.signalingState === "have-local-offer") {
				RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCTimeout);
				console.warn(`WebRTC:   ${from}  Connection timed out. Cleaning up peer connection.`);
				this.cleanupConnection(conn);
			}
		}, RPCPeers._client.config.timeout);

		return { conn, channel, startTime: +new Date() };
	}

	cleanupConnection(conn: RTCPeerConnection): void {
		RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCClose);
		if (this.offered?.conn === conn) {
			this.offered.conn.close();
			delete this.offered;
		} else if (this.answered?.conn === conn) {
			this.answered.conn.close();
			delete this.answered;
		}
	}

	async handleAnnounce(from: EthAddress): Promise<void> {
		RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCAnnounce);
		console.log(`WebRTC:   ${from}  Received announce`);
		if (this.offered) {
			console.warn(`WebRTC:   ${from} Already offered to peer`);
			return;
		}
		this.offered = await this.createConnection(from);
	}

	async handleOffer(offer: RTCSessionDescription): Promise<void> {
		RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCOffer);
		if (this.answered && this.answered?.channel.readyState === "open") {
			console.warn("WebRTC:   Rejecting offer - Already have open connection answered by you");
			return;
		}
		if (this.offered && this.offered.channel.readyState === "open") {
			console.warn("WebRTC:   Rejecting offer - Already have open connection offered by you");
			return;
		}

		console.log(`WebRTC:   ${this.id}  Received offer from`, extractIPAddress(offer.sdp));

		this.answered = await this.createConnection(this.id);
		if (this.answered.conn.signalingState !== "stable" && this.answered.conn.signalingState !== "have-remote-offer") {
			console.warn(`WebRTC:   ${this.id}  Peer connection in unexpected state 1: ${this.answered.conn.signalingState}`);
			return;
		}
		await this.answered.conn.setRemoteDescription(offer);
		if (this.answered.conn.signalingState !== "have-remote-offer") {
			console.warn(`WebRTC:   ${this.id}  Peer connection in unexpected state 2: ${this.answered.conn.signalingState}`);
			return;
		}
		try {
			const answer = await this.answered.conn.createAnswer();
			if (this.answered.conn.signalingState !== "have-remote-offer") return;
			await this.answered.conn.setLocalDescription(answer);

			console.log(`WebRTC:   ${this.id}  Sending answer from`, extractIPAddress(answer.sdp));
			this._rpcPeers.ws.send({ answer, to: `hydra://${this.id}`, from: this._rpcPeers.rtc.address });
		} catch (e) {
			console.error(e);
		}
	}

	async handleAnswer(answer: RTCSessionDescription): Promise<void> {
		RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCAnswer);
		if (!this.offered) {
			console.warn(`WebRTC:   ${this.id}  Rejecting answer - No open handshake`);
			return;
		}
		if (this.offered.conn.signalingState !== "have-local-offer") {
			console.warn(`WebRTC:   ${this.id}  Rejecting answer - Bad signalling state: ${this.offered?.conn.signalingState}`);
			return;
		}
		console.log(`WebRTC:   ${this.id}  Received answer`, extractIPAddress(answer.sdp));
		await this.offered.conn.setRemoteDescription(answer);
	}

	handleIceCandidate(receivedIceCandidate: RTCIceCandidate): void {
		const iceCandidate = receivedIceCandidate;
		RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCIce);
		if (RPCPeers._client.config.logLevel === "verbose") console.log(`WebRTC:   ${this.id}  Received ICE candidate`);
		// if (typeof window !== "undefined") { // TODO: Figure out why this breaks on desktop
		if (this.answered) this.answered.conn.addIceCandidate(iceCandidate).catch(console.error);
		if (this.offered && this.offered.conn.remoteDescription) this.offered.conn.addIceCandidate(iceCandidate).catch(console.error);
		// }
	}

	async handleMessage(channel: RTCDataChannel, e: MessageEvent): Promise<void> {
		console.log(`WebRTC:   Received request`);
		const { id, url, ...data } = JSON.parse(e.data as string);
		const newUrl = new URL(url);
		newUrl.protocol = "rtc:";
		newUrl.hostname = "0.0.0.0";
		const req = new Request(newUrl, data);
		const response = await RPCPeers._client.rpcPeers.handleRequest(req);
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
	}

	public async fetch(url: URL, method = "GET", headers: { [key: string]: string } = {}, body: string | undefined = undefined): Promise<DecodedResponse | ErrorTimeout | ErrorRequestFailed> {
		url.protocol = "rtc:";
		url.hostname = "0.0.0.0";

		const request: WSRequest = { request: { method, url: url.toString(), headers, body: method === "GET" ? undefined : body } };

		let channel: RTCDataChannel | undefined;
		if (this.offered && this.offered.channel.readyState === "open") channel = this.offered.channel;
		else if (this.answered && this.answered.channel.readyState === "open") channel = this.answered.channel;
		else return Promise.reject(new ErrorRequestFailed());

		console.log(`WebRTC:   ${this.id} Sending request`);
		channel.send(JSON.stringify(request));
		const requestHash = Utils.encodeBase10(new TextDecoder().decode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request)))));

		const responsePromise = new Promise<DecodedResponse>((resolve, reject) => {
			channel.onmessage = (e) => {
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
					const response = JSON.parse(e.data as string) as WSResponse;
					console.log(`WebRTC:   Received response`);
					if (response.requestHash !== requestHash) return;
					resolve(response.response);
				} catch (error) {
					reject(`Failed to process response: ${error}`);
				}
			};
		});

		return Utils.promiseWithTimeout(responsePromise, RPCPeers._client.config.timeout);
	}
}

export default class RTCPeers {
	private _rpcPeers: RPCPeers;
	address: EthAddress;
	seenMessages: Set<string> = new Set();

	constructor(rpcPeers: RPCPeers, wallet: Wallet) {
		this._rpcPeers = rpcPeers;
		this.address = wallet.account.address;

		for (let i = 0; i < rpcPeers.ws.peers.length; i++) {
			rpcPeers.ws.peers[i].socket.onopen = () => {
				console.log(`WebRTC:   Announcing to ${rpcPeers.ws.peers[i].socket.url}`);
				const message: SignallingAnnounce = { announce: true, from: this.address };
				rpcPeers.ws.send(message);
				setInterval(() => rpcPeers.ws.send(message), RPCPeers._client.config.announceSpeed);
			};

			rpcPeers.ws.peers[i].socket.onmessage = (event) => {
				this.handleSignallingMessage(event);
			};
		}
	}

	async handleSignallingMessage(event: MessageEvent): Promise<void> {
		const message = JSON.parse(event.data) as SignallingMessage;
		let peer = this._rpcPeers.peers.get(message.from);

		if ("to" in message && message.to !== `hydra://${this.address}`) return;

		this.seenMessages.add(event.data);
		if ("announce" in message) {
			if (!peer) peer = (await this._rpcPeers.add({ host: `hydra://${message.from}` }))[0];
			await (peer.peer as RTCPeer).handleAnnounce(message.from);
		} else if ("offer" in message) {
			if (!peer) peer = (await this._rpcPeers.add({ host: `hydra://${message.from}` }))[0];
			await (peer.peer as RTCPeer).handleOffer(message.offer);
		} else if ("answer" in message) {
			if (!peer) {
				console.warn("WebRTC:   Received answer from unknown peer");
				return;
			}
			await (peer.peer as RTCPeer).handleAnswer(message.answer);
		} else if ("iceCandidate" in message) {
			if (!peer) {
				console.warn("WebRTC:   Received answer from unknown peer");
				return;
			}
			(peer.peer as RTCPeer).handleIceCandidate(message.iceCandidate);
		} else if (!("request" in message) && !("response" in message)) console.warn("WebRTC:   Unknown message type received", message);
	}
}
