import { crypto } from "jsr:@std/crypto";
import { encodeHex } from "jsr:@std/encoding/hex";
import type { Receipt } from "./block.ts";
import type Hydrafiles from "./hydrafiles.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

type Base64 = string & { __brand: "Base64" };

class Utils {
	_client: Hydrafiles;
	constructor(client: Hydrafiles) {
		this._client = client;
	}

	static getRandomNumber = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;
	static isValidSHA256Hash = (hash: string): boolean => /^[a-f0-9]{64}$/.test(hash);
	static hashUint8Array = async (uint8Array: Uint8Array): Promise<string> => encodeHex(await crypto.subtle.digest("SHA-256", uint8Array));
	static isValidInfoHash = (hash: string): boolean => /^[a-f0-9]{40}$/.test(hash);
	static isIp = (host: string): boolean => /^https?:\/\/(?:\d+\.){3}\d+(?::\d+)?$/.test(host);
	static isPrivateIP = (ip: string): boolean => /^https?:\/\/(?:10\.|(?:172\.(?:1[6-9]|2\d|3[0-1]))\.|192\.168\.|169\.254\.|127\.|224\.0\.0\.|255\.255\.255\.255)/.test(ip);
	static interfere = (signalStrength: number): number => signalStrength >= 95 ? this.getRandomNumber(90, 100) : Math.ceil(signalStrength * (1 - (this.getRandomNumber(0, 10) / 100)));
	hasSufficientMemory = async (fileSize: number): Promise<boolean> => {
		if (typeof window !== "undefined") return true;
		const os = await import("https://deno.land/std@0.170.0/node/os.ts");
		return os.freemem() > (fileSize + this._client.config.memoryThreshold);
	};
	static promiseWithTimeout = async <T>(promise: Promise<T>, timeoutDuration: number): Promise<T> =>
		await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) =>
				setTimeout(
					() => reject(new Error("Promise timed out")),
					timeoutDuration,
				)
			),
		]);

	static promiseWrapper = <T>(promise: Promise<T>): { promise: Promise<T>; isFulfilled: boolean } => {
		let isFulfilled = false;
		const wrappedPromise = promise
			.then((value: T) => {
				isFulfilled = true;
				return value;
			})
			.catch((error: unknown) => {
				isFulfilled = true;
				throw error;
			});
		return {
			promise: wrappedPromise,
			isFulfilled,
		};
	};

	static estimateHops = (signalStrength: number): { hop: number | null; certainty: number } => {
		const hopData = [
			{ hop: 1, min: 90, avg: 95 },
			{ hop: 2, min: 81, avg: 92 },
			{ hop: 3, min: 73, avg: 88 },
			{ hop: 4, min: 66, avg: 85 },
			{ hop: 5, min: 61, avg: 81 },
			{ hop: 6, min: 56, avg: 78 },
			{ hop: 7, min: 51, avg: 74 },
			{ hop: 8, min: 49, avg: 71 },
			{ hop: 9, min: 45, avg: 68 },
			{ hop: 10, min: 43, avg: 65 },
		];
		const avgDistance = hopData.reduce(
			(sum, hop) => sum + Math.abs(signalStrength - hop.avg),
			0,
		) / hopData.length;

		let closestHop: number | null = null;
		let closestDistance = Infinity; // Diff between signal strength and avg
		let closestCertainty = Infinity;

		for (const hop of hopData) {
			if (signalStrength < hop.min) continue;
			const distance = Math.abs(signalStrength - hop.avg);
			const range = 100 - hop.min;
			const distanceMinMax = Math.min(
				Math.abs(signalStrength - hop.min),
				Math.abs(100 - signalStrength),
			);
			const certaintyAvg = avgDistance > 0 ? (1 - (distance / avgDistance)) : 0;
			// const certaintyAvg = range > 0 ? (1 - (distance / (range / 2))) : 0
			const certaintyMinMax = 1 - (distanceMinMax / Math.max(range, 1));
			const finalCertainty = (certaintyAvg + certaintyMinMax) / 2;
			if (distance < closestDistance) {
				closestDistance = distance;
				closestHop = hop.hop;
				closestCertainty = finalCertainty;
			}
		}

		return {
			hop: closestHop,
			certainty: Math.round(closestCertainty * 10000) / 100,
		};
	};

	remainingStorage = async (): Promise<number> => this._client.config.maxCache - await this.calculateUsedStorage();

	calculateUsedStorage = async (): Promise<number> => {
		if (typeof window !== "undefined") return 0;
		const filesPath = "files/";
		let usedStorage = 0;

		if (await (await this._client.fs).exists(filesPath)) {
			const files = await (await this._client.fs).readDir(filesPath);
			for (const file of files) {
				usedStorage += await (await this._client.fs).getFileSize(join(filesPath, file));
			}
		}

		return usedStorage;
	};

	purgeCache = async (requiredSpace: number, remainingSpace: number): Promise<void> => {
		if (typeof window !== "undefined") return;
		console.warn("WARNING: Your node has reached max storage, some files are getting purged. To prevent this, increase your limit at config.json or add more storage to your machine.");

		const filesPath = "files/";
		const files = await (await this._client.fs).readDir(filesPath);

		for (const file of files) {
			if (this._client.config.permaFiles.includes(file)) continue;

			const filePath = join(filesPath, file);

			(await this._client.fs).remove(filePath).catch(console.error);
			remainingSpace += await (await this._client.fs).getFileSize(filePath);

			if (requiredSpace <= remainingSpace && await this.calculateUsedStorage() * (1 - this._client.config.burnRate) <= remainingSpace) {
				break;
			}
		}
	};

	static convertTime = (duration: number): string => {
		const msPerSecond = 1000;
		const msPerMinute = msPerSecond * 60;
		const msPerHour = msPerMinute * 60;
		const msPerDay = msPerHour * 24;

		if (duration < msPerMinute) {
			return (duration / msPerSecond).toFixed(2) + " seconds";
		} else if (duration < msPerHour) {
			return (duration / msPerMinute).toFixed(2) + " minutes";
		} else if (duration < msPerDay) {
			return (duration / msPerHour).toFixed(2) + " hours";
		} else return (duration / msPerDay).toFixed(2) + " days";
	};

	static bufferToBase64(buffer: ArrayBuffer): string {
		const byteArray = new Uint8Array(buffer);
		let binary = "";
		byteArray.forEach((byte) => {
			binary += String.fromCharCode(byte);
		});
		return btoa(binary);
	}

	static base64ToBuffer(base64: Base64): ArrayBuffer {
		const binaryString = atob(base64);
		const byteArray = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			byteArray[i] = binaryString.charCodeAt(i);
		}
		return byteArray.buffer;
	}

	static async hashString(input: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(input);
		const hashBuffer = await crypto.subtle.digest("SHA-256", data);
		const hashArray = new Uint8Array(hashBuffer);
		const hexHash = Array.from(hashArray).map((byte) => byte.toString(16).padStart(2, "0")).join("");
		return hexHash;
	}

	static async generateKeyPair(): Promise<CryptoKeyPair> {
		return await crypto.subtle.generateKey(
			{
				name: "ECDSA",
				namedCurve: "P-256",
			},
			true,
			["sign", "verify"],
		) as CryptoKeyPair;
	}
	static exportPublicKey = async (keyPair: CryptoKey) => (await crypto.subtle.exportKey("jwk", keyPair))["x"] as string;
	static buildJWT = (key: string) => {
		return {
			"kty": "OKP",
			"crv": "Ed25519",
			"x": key,
			"key_ops": ["verify"],
			"ext": true,
		};
	};

	static async signMessage(privateKey: CryptoKey, message: string): Promise<Base64> {
		const encoder = new TextEncoder();
		const data = encoder.encode(message);
		return this.bufferToBase64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data)) as Base64;
	}

	static async verifySignature(receipt: Receipt): Promise<boolean> {
		const encoder = new TextEncoder();
		const data = encoder.encode(receipt.message);

		const importedPublicKey = await crypto.subtle.importKey(
			"jwk",
			this.buildJWT(receipt.issuer),
			{ name: "Ed25519" },
			true,
			["verify"],
		);

		return await crypto.subtle.verify(
			{ name: "Ed25519" },
			importedPublicKey,
			this.base64ToBuffer(receipt.signature),
			data,
		);
	}
	static extractBufferSection(buffer: Uint8Array, start: number, end: number): Uint8Array {
		if (start < 0 || end >= buffer.length || start > end) throw new RangeError("Invalid start or end range.");
		return buffer.subarray(start, end + 1);
	}
	async countFilesInDir(dirPath: string): Promise<number> {
		if (typeof window !== "undefined") return 0;
		let count = 0;
		for await (const _ of await (await this._client.fs).readDir(dirPath)) {
			count++;
		}
		return count;
	}
	static async parallelAsync(promises: (() => Promise<void>)[], processes = 4): Promise<void> {
		let completed = 0;
		const runningPromises: Promise<void>[] = [];
		for (let i = 0; i < promises.length; i++) {
			const promise = promises[i]();
			if (i - completed > processes) {
				await Promise.race(runningPromises);
				completed++;
			}
			runningPromises.push(promise);
		}
		await Promise.all(runningPromises);
	}
}

export default Utils;
