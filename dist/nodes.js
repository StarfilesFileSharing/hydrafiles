var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import fs from 'fs';
import Utils from './utils.js';
import FileHandler from './fileHandler.js';
import path from 'path';
import { fileURLToPath } from 'url';
const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
export const NODES_PATH = path.join(DIRNAME, 'nodes.json');
export const nodeFrom = (host) => {
    const node = {
        host,
        http: true,
        dns: false,
        cf: false,
        hits: 0,
        rejects: 0,
        bytes: 0,
        duration: 0
    };
    return node;
};
export default class Nodes {
    constructor(config, s3, FileModel) {
        this.nodes = this.loadNodes();
        this.config = config;
        this.s3 = s3;
        this.utils = new Utils(config);
        this.FileModel = FileModel;
    }
    add(node) {
        return __awaiter(this, void 0, void 0, function* () {
            if (node.host !== this.config.public_hostname && typeof this.nodes.find((existingNode) => existingNode.host === node.host) === 'undefined' && ((yield this.downloadFromNode(node, yield FileHandler.init({ hash: '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f' }, this.config, this.s3, this.FileModel))) !== false)) {
                this.nodes.push(node);
                fs.writeFileSync(NODES_PATH, JSON.stringify(this.nodes));
            }
        });
    }
    loadNodes() {
        return JSON.parse(fs.existsSync(NODES_PATH) ? fs.readFileSync(NODES_PATH).toString() : '[]');
    }
    getNodes(opts = { includeSelf: true }) {
        if (opts.includeSelf === undefined)
            opts.includeSelf = true;
        const nodes = this.nodes.filter(node => opts.includeSelf || node.host !== this.config.public_hostname).sort(() => Math.random() - 0.5);
        if (this.config.prefer_node === 'FASTEST')
            return nodes.sort((a, b) => a.bytes / a.duration - b.bytes / b.duration);
        else if (this.config.prefer_node === 'LEAST_USED')
            return nodes.sort((a, b) => a.hits - a.rejects - (b.hits - b.rejects));
        else if (this.config.prefer_node === 'HIGHEST_HITRATE')
            return nodes.sort((a, b) => (a.hits - a.rejects) - (b.hits - b.rejects));
        else
            return nodes;
    }
    downloadFromNode(node, file) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const startTime = Date.now();
                const hash = file.hash;
                console.log(`  ${hash}  Downloading from ${node.host}`);
                let response;
                try {
                    response = yield this.utils.promiseWithTimeout(fetch(`${node.host}/download/${hash}`), this.config.timeout);
                }
                catch (e) {
                    if (this.config.log_level === 'verbose')
                        console.error(e);
                    return false;
                }
                const buffer = Buffer.from(yield response.arrayBuffer());
                console.log(`  ${hash}  Validating hash`);
                const verifiedHash = yield this.utils.hashStream(this.utils.bufferToStream(buffer));
                if (hash !== verifiedHash)
                    return false;
                if (file.name === undefined || file.name === null || file.name.length === 0) {
                    file.name = String((_a = response.headers.get('Content-Disposition')) === null || _a === void 0 ? void 0 : _a.split('=')[1].replace(/"/g, '').replace(' [HYDRAFILES]', ''));
                    yield file.save();
                }
                node.status = true;
                node.duration += Date.now() - startTime;
                node.bytes += buffer.byteLength;
                node.hits++;
                this.updateNode(node);
                yield file.cacheFile(buffer);
                return { file: buffer, signal: this.utils.interfere(Number(response.headers.get('Signal-Strength'))) };
            }
            catch (e) {
                console.error(e);
                node.rejects++;
                this.updateNode(node);
                return false;
            }
        });
    }
    updateNode(node) {
        const index = this.nodes.findIndex(n => n.host === node.host);
        if (index !== -1) {
            this.nodes[index] = node;
            fs.writeFileSync(NODES_PATH, JSON.stringify(this.nodes));
        }
    }
    getValidNodes() {
        return __awaiter(this, arguments, void 0, function* (opts = { includeSelf: true }) {
            const nodes = this.getNodes(opts);
            const results = [];
            const executing = [];
            for (const node of nodes) {
                if (node.host === this.config.public_hostname) {
                    results.push(node);
                    continue;
                }
                const promise = this.validateNode(node).then(result => {
                    results.push(result);
                    executing.splice(executing.indexOf(promise), 1);
                });
                executing.push(promise);
                if (executing.length >= this.config.max_concurrent_nodes)
                    yield Promise.race(executing);
            }
            yield Promise.all(executing);
            return results;
        });
    }
    validateNode(node) {
        return __awaiter(this, void 0, void 0, function* () {
            const file = yield this.downloadFromNode(node, yield FileHandler.init({ hash: '04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f' }, this.config, this.s3, this.FileModel));
            if (file !== false) {
                node.status = true;
                this.updateNode(node);
                return node;
            }
            else {
                node.status = false;
                this.updateNode(node);
                return node;
            }
        });
    }
    getFile(hash_1) {
        return __awaiter(this, arguments, void 0, function* (hash, size = 0) {
            console.log(`  ${hash}  Getting file from nodes`);
            const nodes = this.getNodes({ includeSelf: false });
            let activePromises = [];
            if (!this.utils.hasSufficientMemory(size)) {
                console.log('Reached memory limit, waiting');
                yield new Promise(() => {
                    const intervalId = setInterval(() => {
                        if (this.utils.hasSufficientMemory(size))
                            clearInterval(intervalId);
                    }, this.config.memory_threshold_reached_wait);
                });
            }
            for (const node of nodes) {
                if (node.http && node.host.length > 0) {
                    const promise = (() => __awaiter(this, void 0, void 0, function* () {
                        const file = yield FileHandler.init({ hash }, this.config, this.s3, this.FileModel);
                        let fileContent = false;
                        try {
                            fileContent = yield this.downloadFromNode(node, file);
                        }
                        catch (e) {
                            console.error(e);
                        }
                        return fileContent !== false ? fileContent : false;
                    }))();
                    activePromises.push(promise);
                    if (activePromises.length >= this.config.max_concurrent_nodes) {
                        const file = yield Promise.race(activePromises);
                        if (file !== false)
                            return file;
                        activePromises = activePromises.filter(p => !this.utils.promiseWrapper(p).isFulfilled);
                    }
                }
            }
            if (activePromises.length > 0) {
                const files = yield Promise.all(activePromises);
                for (let i = 0; i < files.length; i++) {
                    if (files[i] !== false)
                        return files[i];
                }
            }
            return false;
        });
    }
    announce() {
        return __awaiter(this, void 0, void 0, function* () {
            for (const node of this.getNodes({ includeSelf: false })) {
                if (node.http) {
                    if (node.host === this.config.public_hostname)
                        continue;
                    console.log('Announcing to', node.host);
                    yield fetch(`${node.host}/announce?host=${this.config.public_hostname}`);
                }
            }
        });
    }
    compareFileList(node) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g;
            try {
                console.log(`Comparing file list with ${node.host}`);
                const response = yield fetch(`${node.host}/files`);
                const files = yield response.json();
                for (let i = 0; i < files.length; i++) {
                    try {
                        const file = yield FileHandler.init({ hash: files[i].hash, infohash: (_a = files[i].infohash) !== null && _a !== void 0 ? _a : undefined }, this.config, this.s3, this.FileModel);
                        if (((_b = file.infohash) === null || _b === void 0 ? void 0 : _b.length) === 0 && ((_c = files[i].infohash) === null || _c === void 0 ? void 0 : _c.length) !== 0)
                            file.infohash = files[i].infohash;
                        if (((_d = file.id) === null || _d === void 0 ? void 0 : _d.length) === 0 && ((_e = files[i].id) === null || _e === void 0 ? void 0 : _e.length) !== 0)
                            file.id = files[i].id;
                        if (((_f = file.name) === null || _f === void 0 ? void 0 : _f.length) === 0 && ((_g = files[i].name) === null || _g === void 0 ? void 0 : _g.length) !== 0)
                            file.name = files[i].name;
                        if (file.size === 0 && files[i].size !== 0)
                            file.size = files[i].size;
                        yield file.save();
                    }
                    catch (e) {
                        console.error(e);
                    }
                }
            }
            catch (e) {
                const err = e;
                console.error(`Failed to compare file list with ${node.host} - ${err.message}`);
                return;
            }
            console.log(`Done comparing file list with ${node.host}`);
        });
    }
    compareNodeList() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log('Comparing node list');
            const nodes = this.getNodes({ includeSelf: false });
            for (const node of nodes) {
                (() => __awaiter(this, void 0, void 0, function* () {
                    if (node.host.startsWith('http://') || node.host.startsWith('https://')) {
                        console.log(`Fetching nodes from ${node.host}/nodes`);
                        try {
                            const response = yield this.utils.promiseWithTimeout(fetch(`${node.host}/nodes`), this.config.timeout);
                            const remoteNodes = yield response.json();
                            for (const remoteNode of remoteNodes) {
                                this.add(remoteNode).catch((e) => {
                                    if (this.config.log_level === 'verbose')
                                        console.error(e);
                                });
                            }
                        }
                        catch (e) {
                            if (this.config.log_level === 'verbose')
                                throw e;
                        }
                    }
                }))().catch(console.error);
            }
            console.log('Done comparing node list');
        });
    }
}
