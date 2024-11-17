// import { crypto } from "jsr:@std/crypto";
import { encodeHex } from "jsr:@std/encoding/hex";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { Config } from "./config.ts";
import FS from "./filesystem/filesystem.ts";
import { ErrorNotInitialised, ErrorTimeout } from "./errors.ts";

export type Base64 = string & { readonly brand: unique symbol };
export type NonNegativeNumber = number & { readonly brand: unique symbol };
export type Sha256 = string & { readonly brand: unique symbol };
export type PubKey = { x: string; y: string };

class Utils {
	private _config: Config;
	private _fs: FS;
	constructor(config: Config, fs: FS) {
		this._config = config;
		this._fs = fs;
	}

	static getRandomNumber = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;
	static hashUint8Array = async (uint8Array: Uint8Array): Promise<Sha256> => encodeHex(await crypto.subtle.digest("SHA-256", uint8Array)) as Sha256;
	static isValidInfoHash = (hash: string): boolean => /^[a-f0-9]{40}$/.test(hash);
	static isIp = (host: string): boolean => /^https?:\/\/(?:\d+\.){3}\d+(?::\d+)?$/.test(host);
	static isPrivateIP = (ip: string): boolean => /^https?:\/\/(?:10\.|(?:172\.(?:1[6-9]|2\d|3[0-1]))\.|192\.168\.|169\.254\.|127\.|224\.0\.0\.|255\.255\.255\.255|localhost)/.test(ip);
	static interfere = (signalStrength: number): number => signalStrength >= 95 ? this.getRandomNumber(90, 100) : Math.ceil(signalStrength * (1 - (this.getRandomNumber(0, 10) / 100)));

	remainingStorage = async (): Promise<NonNegativeNumber | ErrorNotInitialised> => {
		const usedStorage = await this.calculateUsedStorage();
		if (usedStorage instanceof Error) return usedStorage;
		return this._config.maxCache = usedStorage as NonNegativeNumber;
	};
	static createNonNegativeNumber = (n: number): NonNegativeNumber => (Number.isInteger(n) && n >= 0 ? n : 0) as NonNegativeNumber;

	hasSufficientMemory = async (fileSize: number): Promise<boolean> => {
		if (typeof window !== "undefined") return true;
		const os = await import("https://deno.land/std@0.170.0/node/os.ts");
		return os.freemem() > (fileSize + this._config.memoryThreshold);
	};

	static promiseWithTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T | ErrorTimeout> => {
		const timeoutPromise = new Promise<ErrorTimeout>((resolve) => setTimeout(() => resolve(new ErrorTimeout()), timeoutMs));

		return Promise.race([promise, timeoutPromise]);
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

	calculateUsedStorage = async (): Promise<number | ErrorNotInitialised> => {
		const filesPath = "files/";
		let usedStorage = 0;

		if (await this._fs.exists(filesPath)) {
			const files = await this._fs.readDir(filesPath);
			if (files instanceof ErrorNotInitialised) return files;
			for (const file of files) {
				const fileSize = await this._fs.getFileSize(join(filesPath, file));
				usedStorage += typeof fileSize === "number" ? fileSize : 0;
			}
		}

		return usedStorage;
	};

	purgeCache = async (requiredSpace: number, remainingSpace: number): Promise<true | ErrorNotInitialised> => {
		console.warn("WARNING: Your node has reached max storage, some files are getting purged. To prevent this, increase your limit at config.json or add more storage to your machine.");

		const filesPath = "files/";
		const files = await this._fs.readDir(filesPath);

		if (files instanceof ErrorNotInitialised) return files;

		for (const file of files) {
			if (this._config.permaFiles.includes(file)) continue;

			const filePath = join(filesPath, file);

			const fileSize = await this._fs.getFileSize(filePath);
			this._fs.remove(filePath).catch(console.error);
			if (typeof fileSize === "number") remainingSpace += fileSize;

			const usedStorage = await this.calculateUsedStorage();
			if (usedStorage instanceof ErrorNotInitialised) return usedStorage;
			if (requiredSpace <= remainingSpace && usedStorage * (1 - this._config.burnRate) <= remainingSpace) break;
		}

		return true;
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

	static async hashString(input: string): Promise<Sha256> {
		const encoder = new TextEncoder();
		const data = encoder.encode(input);
		const hashBuffer = await crypto.subtle.digest("SHA-256", data);
		const hashArray = new Uint8Array(hashBuffer);
		const hexHash = Array.from(hashArray).map((byte) => byte.toString(16).padStart(2, "0")).join("");
		return hexHash as Sha256;
	}

	static buildJWT(pubKey: PubKey): { kty: string; crv: string; x: string; y: string; ext: boolean } {
		return {
			kty: "EC",
			crv: "P-256",
			x: pubKey.x,
			y: pubKey.y,
			ext: true,
		};
	}

	static sha256(hash: string): Sha256 {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid sha256 provided");
		return hash as Sha256;
	}
}

export default Utils;
