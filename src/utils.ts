import fs from "node:fs";

import { crypto } from "jsr:@std/crypto";
import { encodeHex } from "jsr:@std/encoding/hex";
import type { Config } from "./config.ts";
import type { Receipt } from "./block.ts";
import { existsSync } from "https://deno.land/std/fs/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";

type Base64 = string & { __brand: "Base64" };

class Utils {
  _config: Config;
  constructor(config: Config) {
    this._config = config;
  }

  getRandomNumber = (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min;
  isValidSHA256Hash = (hash: string): boolean => /^[a-f0-9]{64}$/.test(hash);
  hashUint8Array = async (uint8Array: Uint8Array): Promise<string> =>
    encodeHex(await crypto.subtle.digest("SHA-256", uint8Array));
  isValidInfoHash = (hash: string): boolean => /^[a-f0-9]{40}$/.test(hash);
  isIp = (host: string): boolean =>
    /^https?:\/\/(?:\d+\.){3}\d+(?::\d+)?$/.test(host);
  isPrivateIP = (ip: string): boolean =>
    /^https?:\/\/(?:10\.|(?:172\.(?:1[6-9]|2\d|3[0-1]))\.|192\.168\.|169\.254\.|127\.|224\.0\.0\.|255\.255\.255\.255)/
      .test(ip);
  interfere = (signalStrength: number): number =>
    signalStrength >= 95
      ? this.getRandomNumber(90, 100)
      : Math.ceil(signalStrength * (1 - (this.getRandomNumber(0, 10) / 100)));
  hasSufficientMemory = (fileSize: number): boolean =>
    Deno.memoryUsage().heapUsed / Deno.memoryUsage().heapTotal >
      (fileSize + this._config.memoryThreshold);
  promiseWithTimeout = async <T>(
    promise: Promise<T>,
    timeoutDuration: number,
  ): Promise<T> =>
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Promise timed out")),
          timeoutDuration,
        )
      ),
    ]);

  promiseWrapper = <T>(
    promise: Promise<T>,
  ): { promise: Promise<T>; isFulfilled: boolean } => {
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

  estimateHops = (
    signalStrength: number,
  ): { hop: number | null; certainty: number } => {
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

  remainingStorage = (): number => {
    return this._config.maxCache - this.calculateUsedStorage();
  };

  calculateUsedStorage = (): number => {
    const filesPath = join(Deno.cwd(), "../files");
    let usedStorage = 0;
    if (existsSync(filesPath)) {
      const files = fs.readdirSync(filesPath);
      for (const file of files) {
        const stats = Deno.statSync(join(filesPath, file));
        usedStorage += stats.size;
      }
    }
    return usedStorage;
  };

  purgeCache = (requiredSpace: number, remainingSpace: number): void => {
    console.warn(
      "WARNING: Your node has reached max storage, some files are getting purged. To prevent this, increase your limit at config.json or add more storage to your machine.",
    );
    const files = fs.readdirSync(join(Deno.cwd(), "../files"));
    for (const file of files) {
      if (this._config.permaFiles.includes(file)) continue;

      const size = Deno.statSync(join(Deno.cwd(), "../files", file)).size;
      Deno.remove(join(Deno.cwd(), "../files", file)).catch(console.error);
      remainingSpace += size;

      if (
        requiredSpace <= remainingSpace &&
        this.calculateUsedStorage() * (1 - this._config.burnRate) <=
          remainingSpace
      ) break;
    }
  };

  convertTime = (duration: number): string => {
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

  bufferToBase64(buffer: ArrayBuffer): string {
    const byteArray = new Uint8Array(buffer);
    let binary = "";
    byteArray.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  base64ToBuffer(base64: Base64): ArrayBuffer {
    const binaryString = atob(base64);
    const byteArray = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      byteArray[i] = binaryString.charCodeAt(i);
    }
    return byteArray.buffer;
  }

  async hashString(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    const hexHash = Array.from(hashArray)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return hexHash;
  }

  async generateKeyPair(): Promise<CryptoKeyPair> {
    return await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]) as CryptoKeyPair;
  }

  exportPublicKey = async (keyPair: CryptoKey) =>
    (await crypto.subtle.exportKey("jwk", keyPair))["x"] as string;
  buildJWT = (key: string) => {
    return {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": key,
      "key_ops": ["verify"],
      "ext": true,
    };
  };

  async signMessage(privateKey: CryptoKey, message: string): Promise<Base64> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    return this.bufferToBase64(
      await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data),
    ) as Base64;
  }

  async verifySignature(receipt: Receipt): Promise<boolean> {
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
  extractBufferSection(
    buffer: Uint8Array,
    start: number,
    end: number,
  ): Uint8Array {
    if (start < 0 || end >= buffer.length || start > end) {
      throw new RangeError("Invalid start or end range.");
    }
    return buffer.subarray(start, end + 1);
  }
}

export default Utils;
