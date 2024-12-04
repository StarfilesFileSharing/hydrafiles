import { WSRequest, type WSResponse } from "./ws.ts";
import type { RTCDataChannel, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "npm:werift";
import type { EthAddress } from "../../wallet.ts";
import { type DecodedResponse } from "../routes.ts";
import Utils from "../../utils.ts";
import { ErrorRequestFailed, type ErrorTimeout } from "../../errors.ts";
import RPCPeers from "../RPCPeers.ts";
import type Wallet from "../../wallet.ts";
import { encodeBase32 } from "https://deno.land/std@0.224.0/encoding/base32.ts";

export type SignallingAnnounce = { announce: true; from: EthAddress };
export type SignallingOffer = { offer: RTCSessionDescription; from: EthAddress; to: `rtc://${EthAddress}.hydra` };
export type SignallingAnswer = { answer: RTCSessionDescription; from: EthAddress; to: `rtc://${EthAddress}.hydra` };
export type SignallingIceCandidate = { iceCandidate: RTCIceCandidate; from: EthAddress; to: `rtc://${EthAddress}.hydra` };

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
	host: `rtc://${EthAddress}.hydra`;
	offered?: PeerConnection;
	answered?: PeerConnection;

	constructor(host: `rtc://${EthAddress}.hydra`) {
		console.log("HTTP:     Adding Peer", host);
		this.host = host;
	}

	async createConnection(from: `rtc://${EthAddress}.hydra`): Promise<PeerConnection> {
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
				console.log(`WebRTC:   ${from}  Sending ICE candidate`);
				RTCPeers._rpcPeers.ws.send({ iceCandidate: event.candidate, to: from, from: RTCPeers._rpcPeers.rtc.address });
			}
		};
		conn.onnegotiationneeded = async () => {
			try {
				if (!this.offered || this.offered.channel.readyState === "open") return;

				const offer = await conn.createOffer();
				await conn.setLocalDescription(offer);
				console.log(`WebRTC:   ${from}  Sending offer from`, extractIPAddress(offer.sdp));
				RTCPeers._rpcPeers.ws.send({ offer, to: from, from: RTCPeers._rpcPeers.rtc.address });
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

	async handleAnnounce(from: `rtc://${EthAddress}.hydra`): Promise<void> {
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

		console.log(`WebRTC:   ${this.host}  Received offer from`, extractIPAddress(offer.sdp));

		this.answered = await this.createConnection(this.host);
		if (this.answered.conn.signalingState !== "stable" && this.answered.conn.signalingState !== "have-remote-offer") {
			console.warn(`WebRTC:   ${this.host}  Peer connection in unexpected state 1: ${this.answered.conn.signalingState}`);
			return;
		}
		await this.answered.conn.setRemoteDescription(offer);
		if (this.answered.conn.signalingState !== "have-remote-offer") {
			console.warn(`WebRTC:   ${this.host}  Peer connection in unexpected state 2: ${this.answered.conn.signalingState}`);
			return;
		}
		try {
			const answer = await this.answered.conn.createAnswer();
			if (this.answered.conn.signalingState !== "have-remote-offer") return;
			await this.answered.conn.setLocalDescription(answer);

			console.log(`WebRTC:   ${this.host}  Sending answer from`, extractIPAddress(answer.sdp));
			RTCPeers._rpcPeers.ws.send({ answer, to: this.host, from: RTCPeers._rpcPeers.rtc.address });
		} catch (e) {
			console.error(e);
		}
	}

	async handleAnswer(answer: RTCSessionDescription): Promise<void> {
		RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCAnswer);
		if (!this.offered) {
			console.warn(`WebRTC:   ${this.host}  Rejecting answer - No open handshake`);
			return;
		}
		if (this.offered.conn.signalingState !== "have-local-offer") {
			console.warn(`WebRTC:   ${this.host}  Rejecting answer - Bad signalling state: ${this.offered?.conn.signalingState}`);
			return;
		}
		console.log(`WebRTC:   ${this.host}  Received answer`, extractIPAddress(answer.sdp));
		await this.offered.conn.setRemoteDescription(answer);
	}

	handleIceCandidate(receivedIceCandidate: RTCIceCandidate): void {
		const iceCandidate = receivedIceCandidate;
		RPCPeers._client.events.log(RPCPeers._client.events.rtcEvents.RTCIce);
		console.log(`WebRTC:   ${this.host}  Received ICE candidate`);
		// if (typeof window !== "undefined") { // TODO: Figure out why this breaks on desktop
		if (this.answered) this.answered.conn.addIceCandidate(iceCandidate).catch(console.error);
		if (this.offered && this.offered.conn.remoteDescription) this.offered.conn.addIceCandidate(iceCandidate).catch(console.error);
		// }
	}

	async handleMessage(channel: RTCDataChannel, e: MessageEvent): Promise<void> {
		console.log(`WebRTC:   Received request`);
		const request = (JSON.parse(e.data as string) as WSRequest).request;
		const { url, ...data } = request;
		const requestHash = encodeBase32(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request)))));
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

		console.log(`WebRTC:   Sending response`);
		const message = JSON.stringify({ body, status, headers } as DecodedResponse);
		channel.send(message);

		const maxPacketSize = 8 * 1024;
		const total = Math.ceil(message.length / maxPacketSize);

		for (let i = 0; i < total; i++) {
			const start = i * maxPacketSize;
			const end = start + maxPacketSize;
			const packet = {
				requestHash,
				i,
				total,
				body: message.slice(start, end),
			};
			channel.send(JSON.stringify(packet));
		}
	}

	public async fetch(url: `hydra://core/${string}`, method = "GET", headers: { [key: string]: string } = {}, body: string | undefined = undefined): Promise<DecodedResponse | ErrorTimeout | ErrorRequestFailed> {
		console.log(`WebRTC:   Fetching ${url} from ${this.host}`);
		const request: WSRequest = { request: { method, url: url.toString(), headers, body: method === "GET" ? undefined : body } };

		let channel: RTCDataChannel | undefined;
		if (this.offered && this.offered.channel.readyState === "open") channel = this.offered.channel;
		else if (this.answered && this.answered.channel.readyState === "open") channel = this.answered.channel;
		else return new ErrorRequestFailed();

		console.log(`WebRTC:   ${this.host} Sending request`);
		channel.send(JSON.stringify(request));
		const requestHash = encodeBase32(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request)))));

		const responsePromise = new Promise<DecodedResponse>((resolve, reject) => {
			channel.onmessage = (e) => {
				const packet = JSON.parse(e.data as string);

				if (!receivedPackets[packet.requestHash]) receivedPackets[packet.requestHash] = [];
				receivedPackets[packet.requestHash][packet.index] = packet.body;

				if (receivedPackets[packet.requestHash].filter(Boolean).length === packet.total) {
					const message = receivedPackets[packet.requestHash].join("");
					delete receivedPackets[packet.requestHash];
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

		const response = Utils.promiseWithTimeout(responsePromise, RPCPeers._client.config.timeout);
		console.log(response);
		return response;
	}
}

export default class RTCPeers {
	static _rpcPeers: RPCPeers;
	address: EthAddress;
	seenMessages: Set<string> = new Set();

	constructor(wallet: Wallet) {
		this.address = wallet.account.address;

		RTCPeers._rpcPeers.ws.onmessage((e) => this.handleSignallingMessage(e));
	}

	async handleSignallingMessage(event: MessageEvent): Promise<void> {
		const message = JSON.parse(event.data) as SignallingMessage;
		let peer = RTCPeers._rpcPeers.peers.get(`rtc://${message.from}.hydra`);

		if (("to" in message && message.to !== `rtc://${this.address}.hydra`) || message.from === RPCPeers._client.rtcWallet.address()) return;

		this.seenMessages.add(event.data);
		if ("announce" in message) {
			if (!peer) peer = (await RTCPeers._rpcPeers.add({ host: `rtc://${message.from}.hydra` }))[0];
			await (peer.peer as RTCPeer).handleAnnounce(`rtc://${message.from}.hydra`);
		} else if ("offer" in message) {
			if (!peer) peer = (await RTCPeers._rpcPeers.add({ host: `rtc://${message.from}.hydra` }))[0];
			await (peer.peer as RTCPeer).handleOffer(message.offer);
		} else if ("answer" in message) {
			if (!peer) {
				console.warn("WebRTC:   Received answer from unknown peer");
				return;
			}
			await (peer.peer as RTCPeer).handleAnswer(message.answer);
		} else if ("iceCandidate" in message) {
			if (!peer) {
				console.warn("WebRTC:   Received ice candidates from unknown peer");
				return;
			}
			(peer.peer as RTCPeer).handleIceCandidate(message.iceCandidate);
		} else if (!("request" in message) && !("response" in message)) console.warn("WebRTC:   Unknown message type received", message);
	}
}
