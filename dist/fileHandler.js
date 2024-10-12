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
var _a;
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
const WebTorrentPromise = import('webtorrent');
// TODO: Log common user-agents and use the same for requests to slightly anonymise clients
const DIRNAME = path.resolve();
const seeding = [];
let webtorrent = null;
export const webtorrentClient = () => __awaiter(void 0, void 0, void 0, function* () {
    if (webtorrent === null) {
        const WebTorrent = (yield WebTorrentPromise).default;
        webtorrent = new WebTorrent();
    }
    return webtorrent;
});
class FileHandler {
    static init(opts, client) {
        return __awaiter(this, void 0, void 0, function* () {
            let hash;
            if (opts.hash !== undefined)
                hash = opts.hash;
            else if (opts.infohash !== undefined) {
                if (!client.utils.isValidInfoHash(opts.infohash))
                    throw new Error(`Invalid infohash provided: ${opts.infohash}`);
                const file = yield client.FileModel.findOne({ where: { infohash: opts.infohash } });
                if (typeof (file === null || file === void 0 ? void 0 : file.dataValues.hash) === 'string')
                    hash = file === null || file === void 0 ? void 0 : file.dataValues.hash;
                else {
                    // TODO: Check against other nodes
                    hash = '';
                }
            }
            else
                throw new Error('No hash or infohash provided');
            if (hash !== undefined && !client.utils.isValidSHA256Hash(hash))
                throw new Error('Invalid hash provided');
            const fileHandler = new _a();
            fileHandler.hash = hash;
            fileHandler.infohash = '';
            fileHandler.id = '';
            fileHandler.name = '';
            fileHandler.found = true;
            fileHandler.size = 0;
            fileHandler.client = client;
            const existingFile = yield client.FileModel.findByPk(hash);
            fileHandler.file = existingFile !== null && existingFile !== void 0 ? existingFile : yield client.FileModel.create({ hash });
            Object.assign(fileHandler, fileHandler.file.dataValues);
            if (Number(fileHandler.size) === 0)
                fileHandler.size = 0;
            return fileHandler;
        });
    }
    getMetadata() {
        return __awaiter(this, void 0, void 0, function* () {
            var _b;
            if (this.size > 0 && this.name !== undefined && this.name !== null && this.name.length > 0)
                return this;
            const hash = this.hash;
            console.log(`  ${hash}  Getting file metadata`);
            const id = this.id;
            if (id !== undefined && id !== null && id.length > 0) {
                const response = yield fetch(`${this.client.config.metadata_endpoint}${id}`);
                if (response.ok) {
                    const metadata = (yield response.json()).result;
                    this.name = metadata.name;
                    this.size = metadata.size;
                    if (((_b = this.infohash) === null || _b === void 0 ? void 0 : _b.length) === 0)
                        this.infohash = metadata.infohash;
                    yield this.save();
                    return this;
                }
            }
            const filePath = path.join(DIRNAME, 'files', hash);
            if (fs.existsSync(filePath)) {
                this.size = fs.statSync(filePath).size;
                yield this.save();
                return this;
            }
            if (this.client.config.s3_endpoint.length !== 0) {
                try {
                    const data = yield this.client.s3.headObject({ Bucket: 'uploads', Key: `${hash}.stuf` });
                    if (typeof data.ContentLength !== 'undefined') {
                        this.size = data.ContentLength;
                        yield this.save();
                        return this;
                    }
                }
                catch (error) {
                    console.error(error);
                }
            }
            return false;
        });
    }
    cacheFile(file) {
        return __awaiter(this, void 0, void 0, function* () {
            const hash = this.hash;
            const filePath = path.join(DIRNAME, 'files', hash);
            if (fs.existsSync(filePath))
                return;
            let size = this.size;
            if (size === 0) {
                size = file.byteLength;
                this.size = size;
                yield this.save();
            }
            const remainingSpace = this.client.utils.remainingStorage();
            if (this.client.config.max_cache !== -1 && size > remainingSpace)
                this.client.utils.purgeCache(size, remainingSpace);
            yield this.client.utils.saveBufferToFile(file, filePath);
        });
    }
    fetchFromCache() {
        return __awaiter(this, void 0, void 0, function* () {
            const hash = this.hash;
            console.log(`  ${hash}  Checking Cache`);
            const filePath = path.join(DIRNAME, 'files', hash);
            yield this.seed();
            return fs.existsSync(filePath) ? { file: fs.readFileSync(filePath), signal: this.client.utils.interfere(100) } : false;
        });
    }
    fetchFromS3() {
        return __awaiter(this, void 0, void 0, function* () {
            var _b, e_1, _c, _d;
            const hash = this.hash;
            console.log(`  ${hash}  Checking S3`);
            if (this.client.config.s3_endpoint.length === 0)
                return false;
            try {
                let buffer;
                const data = yield this.client.s3.getObject({ Bucket: 'uploads', Key: `${hash}.stuf` });
                if (data.Body instanceof Readable) {
                    const chunks = [];
                    try {
                        for (var _e = true, _f = __asyncValues(data.Body), _g; _g = yield _f.next(), _b = _g.done, !_b; _e = true) {
                            _d = _g.value;
                            _e = false;
                            const chunk = _d;
                            chunks.push(chunk);
                        }
                    }
                    catch (e_1_1) { e_1 = { error: e_1_1 }; }
                    finally {
                        try {
                            if (!_e && !_b && (_c = _f.return)) yield _c.call(_f);
                        }
                        finally { if (e_1) throw e_1.error; }
                    }
                    buffer = Buffer.concat(chunks);
                }
                else if (data.Body instanceof Buffer)
                    buffer = data.Body;
                else
                    return false;
                if (this.client.config.cache_s3)
                    yield this.cacheFile(buffer);
                return { file: buffer, signal: this.client.utils.interfere(100) };
            }
            catch (e) {
                const err = e;
                if (err.message !== 'The specified key does not exist.')
                    console.error(err);
                return false;
            }
        });
    }
    // TODO: fetchFromTorrent
    // TODO: Connect to other hydrafiles nodes as webseed
    // TODO: Check other nodes file lists to find other claimed infohashes for the file, leech off all of them and copy the metadata from the healthiest torrent
    getFile() {
        return __awaiter(this, arguments, void 0, function* (opts = {}) {
            const hash = this.hash;
            console.log(`  ${hash}  Getting file`);
            if (!this.client.utils.isValidSHA256Hash(hash)) {
                console.log(`  ${hash}  Invalid hash`);
                return false;
            }
            if (!this.found && new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000)) {
                console.log(`  ${hash}  404 cached`);
                return false;
            }
            if (opts.logDownloads === undefined || opts.logDownloads)
                yield this.increment('downloadCount');
            yield this.save();
            if (this.size !== 0 && !this.client.utils.hasSufficientMemory(this.size)) {
                yield new Promise(() => {
                    const intervalId = setInterval(() => {
                        if (this.client.config.log_level === 'verbose')
                            console.log(`  ${hash}  Reached memory limit, waiting`, this.size);
                        if (this.size === 0 || this.client.utils.hasSufficientMemory(this.size))
                            clearInterval(intervalId);
                    }, this.client.config.memory_threshold_reached_wait);
                });
            }
            let file = yield this.fetchFromCache();
            if (file !== false)
                console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`);
            else {
                if (this.client.config.s3_endpoint.length > 0)
                    file = yield this.fetchFromS3();
                if (file !== false)
                    console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`);
                else {
                    file = yield this.client.nodes.getFile(hash, this.size);
                    if (file === false) {
                        this.found = false;
                        yield this.save();
                    }
                }
            }
            if (file !== false)
                yield this.seed();
            return file;
        });
    }
    save() {
        return __awaiter(this, void 0, void 0, function* () {
            const values = Object.keys(this).reduce((row, key) => {
                if (key !== 'file' && key !== 'save')
                    row[key] = this[key];
                return row;
            }, {});
            Object.assign(this.file, values);
            yield this.file.save();
        });
    }
    seed() {
        return __awaiter(this, void 0, void 0, function* () {
            var _b;
            if (seeding.includes(this.hash))
                return;
            seeding.push(this.hash);
            const filePath = path.join(DIRNAME, 'files', this.hash);
            if (!fs.existsSync(filePath))
                return;
            (yield webtorrentClient()).seed(filePath, {
                // @ts-expect-error
                createdBy: 'Hydrafiles/0.1',
                name: ((_b = this.name) !== null && _b !== void 0 ? _b : this.hash).replace(/(\.\w+)$/, ' [HYDRAFILES]$1'),
                destroyStoreOnDestroy: true,
                addUID: true,
                comment: 'Anonymously seeded with Hydrafiles'
            }, (torrent) => __awaiter(this, void 0, void 0, function* () {
                console.log(`  ${this.hash}  Seeding with infohash ${torrent.infoHash}`);
                this.infohash = torrent.infoHash;
                yield this.save();
            }));
        });
    }
    increment(column) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.file.increment(column);
        });
    }
}
_a = FileHandler;
FileHandler.findFiles = (where_1, client_1, ...args_1) => __awaiter(void 0, [where_1, client_1, ...args_1], void 0, function* (where, client, cache = true) {
    const files = cache ? yield client.FileModel.findAll(where) : yield client.FileModel.noCache().findAll(where);
    return files.map((values) => values.dataValues);
});
export default FileHandler;
// TODO: webtorrent.add() all known files
