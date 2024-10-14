import os from "node:os";
import fs from "node:fs";
import type { Config } from "./config.ts";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";
import { crypto } from "jsr:@std/crypto";
import { encodeHex } from "jsr:@std/encoding/hex";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

class Utils {
  config: Config;
  constructor(config: Config) {
    this.config = config;
  }

  getRandomNumber = (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min;
  isValidSHA256Hash = (hash: string): boolean => /^[a-f0-9]{64}$/.test(hash);
  hashStream = async (stream: Readable): Promise<string> =>  encodeHex(await crypto.subtle.digest("SHA-256", stream));
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
    os.freemem() > (fileSize + this.config.memory_threshold);
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
    let closestDistance: number = Infinity; // Diff between signal strength and avg
    let closestCertainty: number = Infinity;

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

  async streamLength(stream: Readable): Promise<number> {
    const chunks: Uint8Array[] = [];

    await pipeline(stream, async function (source) {
      for await (const chunk of source) {
        chunks.push(chunk);
      }
    });

    const completeBuffer = Buffer.concat(chunks);
    return completeBuffer.buffer.slice(
      completeBuffer.byteOffset,
      completeBuffer.byteOffset + completeBuffer.byteLength,
    ).byteLength;
  }

  async streamToBuffer(stream: Readable): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];

    await pipeline(stream, async function (source) {
      for await (const chunk of source) {
        chunks.push(chunk);
      }
    });

    const completeBuffer = Buffer.concat(chunks);
    return completeBuffer.buffer.slice(
      completeBuffer.byteOffset,
      completeBuffer.byteOffset + completeBuffer.byteLength,
    );
  }

  bufferToStream(buffer: Buffer): Readable {
    const readable = new Readable({
      read() {
        this.push(buffer);
        this.push(null);
      },
    });
    return readable;
  }

  async saveBufferToFile(buffer: Buffer, filePath: string): Promise<void> {
    return await new Promise((resolve, reject) => {
      try {
        fs.writeFile(filePath, buffer, (err) => {
          if (err !== null) {
            reject(err);
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  remainingStorage = (): number => {
    return this.config.max_cache - this.calculateUsedStorage();
  };

  calculateUsedStorage = (): number => {
    const filesPath = path.join(DIRNAME, "../files");
    let usedStorage = 0;
    if (fs.existsSync(filesPath)) {
      const files = fs.readdirSync(filesPath);
      for (const file of files) {
        const stats = fs.statSync(path.join(filesPath, file));
        usedStorage += stats.size;
      }
    }
    return usedStorage;
  };

  purgeCache = (requiredSpace: number, remainingSpace: number): void => {
    console.warn(
      "WARNING: Your node has reached max storage, some files are getting purged. To prevent this, increase your limit at config.json or add more storage to your machine.",
    );
    const files = fs.readdirSync(path.join(process.cwd(), "../files"));
    for (const file of files) {
      if (this.config.perma_files.includes(file)) continue;

      const size = fs.statSync(path.join(process.cwd(), "../files", file)).size;
      fs.unlinkSync(path.join(process.cwd(), "../files", file));
      remainingSpace += size;

      if (
        requiredSpace <= remainingSpace &&
        this.calculateUsedStorage() * (1 - this.config.burn_rate) <=
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
}

export default Utils;
