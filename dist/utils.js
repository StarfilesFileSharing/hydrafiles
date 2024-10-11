var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
import os from 'os';
import fs from 'fs';
import { createHash } from 'crypto';
import CONFIG from './config.js';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
const DIRNAME = path.resolve();
export const getRandomNumber = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
export const isValidSHA256Hash = (hash) => /^[a-f0-9]{64}$/.test(hash);
export const isValidInfoHash = (hash) => /^[a-f0-9]{40}$/.test(hash);
export const isIp = (host) => /^https?:\/\/(?:\d+\.){3}\d+(?::\d+)?$/.test(host);
export const isPrivateIP = (ip) => /^https?:\/\/(?:10\.|(?:172\.(?:1[6-9]|2\d|3[0-1]))\.|192\.168\.|169\.254\.|127\.|224\.0\.0\.|255\.255\.255\.255)/.test(ip);
export const interfere = (signalStrength) => signalStrength >= 95 ? getRandomNumber(90, 100) : Math.ceil(signalStrength * (1 - (getRandomNumber(0, 10) / 100)));
export const hasSufficientMemory = (fileSize) => os.freemem() > (fileSize + CONFIG.memory_threshold);
export const promiseWithTimeout = (promise, timeoutDuration) => __awaiter(void 0, void 0, void 0, function* () {
    const controller = new AbortController();
    const signal = controller.signal;
    const wrappedPromise = new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Promise timed out')));
        promise
            .then(resolve)
            .catch(reject);
    });
    return yield Promise.race([
        wrappedPromise,
        new Promise((_resolve, reject) => setTimeout(() => {
            controller.abort();
            reject(new Error('Promise timed out'));
        }, timeoutDuration))
    ]);
});
export const promiseWrapper = (promise) => {
    let isFulfilled = false;
    const wrappedPromise = promise
        .then((value) => {
        isFulfilled = true;
        return value;
    })
        .catch((error) => {
        isFulfilled = true;
        throw error;
    });
    return {
        promise: wrappedPromise,
        isFulfilled
    };
};
export const estimateHops = (signalStrength) => {
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
        { hop: 10, min: 43, avg: 65 }
    ];
    const avgDistance = hopData.reduce((sum, hop) => sum + Math.abs(signalStrength - hop.avg), 0) / hopData.length;
    let closestHop = null;
    let closestDistance = Infinity; // Diff between signal strength and avg
    let closestCertainty = Infinity;
    for (const hop of hopData) {
        if (signalStrength < hop.min)
            continue;
        const distance = Math.abs(signalStrength - hop.avg);
        const range = 100 - hop.min;
        const distanceMinMax = Math.min(Math.abs(signalStrength - hop.min), Math.abs(100 - signalStrength));
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
    return { hop: closestHop, certainty: Math.round(closestCertainty * 10000) / 100 };
};
export const hashStream = (stream) => __awaiter(void 0, void 0, void 0, function* () {
    const hash = createHash('sha256');
    yield pipeline(stream, function (source) {
        return __asyncGenerator(this, arguments, function* () {
            var _a, e_1, _b, _c;
            try {
                for (var _d = true, source_1 = __asyncValues(source), source_1_1; source_1_1 = yield __await(source_1.next()), _a = source_1_1.done, !_a; _d = true) {
                    _c = source_1_1.value;
                    _d = false;
                    const chunk = _c;
                    hash.update(chunk);
                }
            }
            catch (e_1_1) { e_1 = { error: e_1_1 }; }
            finally {
                try {
                    if (!_d && !_a && (_b = source_1.return)) yield __await(_b.call(source_1));
                }
                finally { if (e_1) throw e_1.error; }
            }
        });
    });
    return hash.digest('hex');
});
export function streamLength(stream) {
    return __awaiter(this, void 0, void 0, function* () {
        const chunks = [];
        yield pipeline(stream, function (source) {
            return __asyncGenerator(this, arguments, function* () {
                var _a, e_2, _b, _c;
                try {
                    for (var _d = true, source_2 = __asyncValues(source), source_2_1; source_2_1 = yield __await(source_2.next()), _a = source_2_1.done, !_a; _d = true) {
                        _c = source_2_1.value;
                        _d = false;
                        const chunk = _c;
                        chunks.push(chunk);
                    }
                }
                catch (e_2_1) { e_2 = { error: e_2_1 }; }
                finally {
                    try {
                        if (!_d && !_a && (_b = source_2.return)) yield __await(_b.call(source_2));
                    }
                    finally { if (e_2) throw e_2.error; }
                }
            });
        });
        const completeBuffer = Buffer.concat(chunks);
        return completeBuffer.buffer.slice(completeBuffer.byteOffset, completeBuffer.byteOffset + completeBuffer.byteLength).byteLength;
    });
}
export function streamToBuffer(stream) {
    return __awaiter(this, void 0, void 0, function* () {
        const chunks = [];
        yield pipeline(stream, function (source) {
            return __asyncGenerator(this, arguments, function* () {
                var _a, e_3, _b, _c;
                try {
                    for (var _d = true, source_3 = __asyncValues(source), source_3_1; source_3_1 = yield __await(source_3.next()), _a = source_3_1.done, !_a; _d = true) {
                        _c = source_3_1.value;
                        _d = false;
                        const chunk = _c;
                        chunks.push(chunk);
                    }
                }
                catch (e_3_1) { e_3 = { error: e_3_1 }; }
                finally {
                    try {
                        if (!_d && !_a && (_b = source_3.return)) yield __await(_b.call(source_3));
                    }
                    finally { if (e_3) throw e_3.error; }
                }
            });
        });
        const completeBuffer = Buffer.concat(chunks);
        return completeBuffer.buffer.slice(completeBuffer.byteOffset, completeBuffer.byteOffset + completeBuffer.byteLength);
    });
}
export function bufferToStream(arrayBuffer) {
    const buffer = Buffer.from(arrayBuffer);
    const readable = new Readable({
        read() {
            this.push(buffer);
            this.push(null);
        }
    });
    return readable;
}
export function saveBufferToFile(buffer, filePath) {
    return __awaiter(this, void 0, void 0, function* () {
        return yield new Promise((resolve, reject) => {
            try {
                fs.writeFile(filePath, buffer, (err) => {
                    if (err !== null) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            }
            catch (error) {
                reject(error);
            }
        });
    });
}
export const remainingStorage = () => {
    return CONFIG.max_storage - calculateUsedStorage();
};
export const calculateUsedStorage = () => {
    const filesPath = path.join(DIRNAME, 'files');
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
export const purgeCache = (requiredSpace, remainingSpace) => {
    console.warn('WARNING: Your node has reached max storage, some files are getting purged. To prevent this, increase your limit at config.json or add more storage to your machine.');
    const files = fs.readdirSync(path.join(process.cwd(), 'files'));
    for (const file of files) {
        if (CONFIG.perma_files.includes(file))
            continue;
        const size = fs.statSync(path.join(process.cwd(), 'files', file)).size;
        fs.unlinkSync(path.join(process.cwd(), 'files', file));
        remainingSpace += size;
        if (requiredSpace <= remainingSpace)
            break;
    }
};
export const convertTime = (duration) => {
    const msPerSecond = 1000;
    const msPerMinute = msPerSecond * 60;
    const msPerHour = msPerMinute * 60;
    const msPerDay = msPerHour * 24;
    if (duration < msPerMinute)
        return (duration / msPerSecond).toFixed(2) + ' seconds';
    else if (duration < msPerHour)
        return (duration / msPerMinute).toFixed(2) + ' minutes';
    else if (duration < msPerDay)
        return (duration / msPerHour).toFixed(2) + ' hours';
    else
        return (duration / msPerDay).toFixed(2) + ' days';
};
