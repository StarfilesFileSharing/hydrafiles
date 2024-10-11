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
import { S3 } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { Sequelize, DataTypes } from 'sequelize';
import CONFIG from './config.js';
import { hasSufficientMemory, interfere, isValidInfoHash, isValidSHA256Hash, saveBufferToFile, remainingStorage, purgeCache } from './utils.js';
import SequelizeSimpleCache from 'sequelize-simple-cache';
const WebTorrentPromise = import('webtorrent');
const DIRNAME = path.resolve();
const s3 = new S3({
    region: 'us-east-1',
    credentials: {
        accessKeyId: CONFIG.s3_access_key_id,
        secretAccessKey: CONFIG.s3_secret_access_key
    },
    endpoint: CONFIG.s3_endpoint
});
// TODO: Log common user-agents and use the same for requests to slightly anonymise clients
const seeding = [];
let webtorrent = null;
export const webtorrentClient = () => __awaiter(void 0, void 0, void 0, function* () {
    if (webtorrent === null) {
        const WebTorrent = (yield WebTorrentPromise).default;
        webtorrent = new WebTorrent();
    }
    return webtorrent;
});
export default class FileHandler {
    static init(opts) {
        return __awaiter(this, void 0, void 0, function* () {
            let hash;
            if (opts.hash !== undefined)
                hash = opts.hash;
            else if (opts.infohash !== undefined) {
                if (!isValidInfoHash(opts.infohash))
                    throw new Error(`Invalid infohash provided: ${opts.infohash}`);
                const file = yield FileModel.findOne({ where: { infohash: opts.infohash } });
                if (typeof (file === null || file === void 0 ? void 0 : file.dataValues.hash) === 'string')
                    hash = file === null || file === void 0 ? void 0 : file.dataValues.hash;
                else {
                    // TODO: Check against other nodes
                    hash = '';
                }
            }
            else
                throw new Error('No hash or infohash provided');
            if (hash !== undefined && !isValidSHA256Hash(hash))
                throw new Error('Invalid hash provided');
            const fileHandler = new FileHandler();
            fileHandler.hash = hash;
            fileHandler.infohash = '';
            fileHandler.id = '';
            fileHandler.name = '';
            fileHandler.found = true;
            fileHandler.size = 0;
            const existingFile = yield FileModel.findByPk(hash);
            fileHandler.file = existingFile !== null && existingFile !== void 0 ? existingFile : yield FileModel.create({ hash });
            Object.assign(fileHandler, fileHandler.file.dataValues);
            if (Number(fileHandler.size) === 0)
                fileHandler.size = 0;
            return fileHandler;
        });
    }
    getMetadata() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            if (this.size > 0 && this.name !== undefined && this.name !== null && this.name.length > 0)
                return this;
            const hash = this.hash;
            console.log(`  ${hash}  Getting file metadata`);
            const id = this.id;
            if (id !== undefined && id !== null && id.length > 0) {
                const response = yield fetch(`${CONFIG.metadata_endpoint}${id}`);
                if (response.ok) {
                    const metadata = (yield response.json()).result;
                    this.name = metadata.name;
                    this.size = metadata.size;
                    if (((_a = this.infohash) === null || _a === void 0 ? void 0 : _a.length) === 0)
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
            if (CONFIG.s3_endpoint.length !== 0) {
                try {
                    const data = yield s3.headObject({ Bucket: 'uploads', Key: `${hash}.stuf` });
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
            const remainingSpace = remainingStorage();
            if (CONFIG.max_storage !== -1 && size > remainingSpace)
                purgeCache(size, remainingSpace);
            yield saveBufferToFile(file, filePath);
        });
    }
    fetchFromCache() {
        return __awaiter(this, void 0, void 0, function* () {
            const hash = this.hash;
            console.log(`  ${hash}  Checking Cache`);
            const filePath = path.join(DIRNAME, 'files', hash);
            yield this.seed();
            return fs.existsSync(filePath) ? { file: fs.readFileSync(filePath), signal: interfere(100) } : false;
        });
    }
    fetchFromS3() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, e_1, _b, _c;
            const hash = this.hash;
            console.log(`  ${hash}  Checking S3`);
            if (CONFIG.s3_endpoint.length === 0)
                return false;
            try {
                let buffer;
                const data = yield s3.getObject({ Bucket: 'uploads', Key: `${hash}.stuf` });
                if (data.Body instanceof Readable) {
                    const chunks = [];
                    try {
                        for (var _d = true, _e = __asyncValues(data.Body), _f; _f = yield _e.next(), _a = _f.done, !_a; _d = true) {
                            _c = _f.value;
                            _d = false;
                            const chunk = _c;
                            chunks.push(chunk);
                        }
                    }
                    catch (e_1_1) { e_1 = { error: e_1_1 }; }
                    finally {
                        try {
                            if (!_d && !_a && (_b = _e.return)) yield _b.call(_e);
                        }
                        finally { if (e_1) throw e_1.error; }
                    }
                    buffer = Buffer.concat(chunks);
                }
                else if (data.Body instanceof Buffer)
                    buffer = data.Body;
                else
                    return false;
                if (CONFIG.cache_s3)
                    yield this.cacheFile(buffer);
                return { file: buffer, signal: interfere(100) };
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
    getFile(nodesManager_1) {
        return __awaiter(this, arguments, void 0, function* (nodesManager, opts = {}) {
            const hash = this.hash;
            console.log(`  ${hash}  Getting file`);
            if (!isValidSHA256Hash(hash))
                return false;
            if (!this.found && new Date(this.updatedAt) > new Date(new Date().getTime() - 5 * 60 * 1000))
                return false;
            if (opts.logDownloads === undefined || opts.logDownloads)
                yield this.increment('downloadCount');
            yield this.save();
            if (this.size !== 0 && !hasSufficientMemory(this.size)) {
                yield new Promise(() => {
                    const intervalId = setInterval(() => {
                        if (CONFIG.log_level === 'verbose')
                            console.log(`  ${hash}  Reached memory limit, waiting`, this.size);
                        if (this.size === 0 || hasSufficientMemory(this.size))
                            clearInterval(intervalId);
                    }, CONFIG.memory_threshold_reached_wait);
                });
            }
            let file = yield this.fetchFromCache();
            if (file !== false)
                console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from cache`);
            else {
                if (CONFIG.s3_endpoint.length > 0)
                    file = yield this.fetchFromS3();
                if (file !== false)
                    console.log(`  ${hash}  Serving ${this.size !== undefined ? Math.round(this.size / 1024 / 1024) : 0}MB from S3`);
                else {
                    file = yield nodesManager.getFile(hash, this.size);
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
            var _a;
            if (seeding.includes(this.hash))
                return;
            seeding.push(this.hash);
            const filePath = path.join(DIRNAME, 'files', this.hash);
            if (!fs.existsSync(filePath))
                return;
            (yield webtorrentClient()).seed(filePath, {
                // @ts-expect-error
                createdBy: 'Hydrafiles/0.1',
                name: ((_a = this.name) !== null && _a !== void 0 ? _a : this.hash).replace(/(\.\w+)$/, ' [HYDRAFILES]$1'),
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
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(DIRNAME, 'filemanager.db'),
    logging: (...msg) => {
        const payload = msg[1];
        if (payload.type === 'SELECT') {
            if (payload.where !== undefined && CONFIG.log_level === 'verbose')
                console.log(`  ${payload.where.split("'")[1]}  SELECTing file from database`);
        }
        else if (payload.type === 'INSERT') {
            console.log(`  ${payload.instance.dataValues.hash}  INSERTing file to database`);
        }
        else if (payload.type === 'UPDATE') {
            if (payload.fields !== undefined)
                console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Changing columns: ${payload.fields.join(', ')}`);
            else if (payload.increment)
                console.log(`  ${payload.instance.dataValues.hash}  UPDATEing file in database - Incrementing Value`);
            else {
                console.error('Unknown database action');
                console.log(payload);
            }
        }
    }
});
const UncachedFileModel = sequelize.define('File', {
    hash: {
        type: DataTypes.STRING,
        primaryKey: true
    },
    infohash: {
        type: DataTypes.STRING
    },
    downloadCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    id: {
        type: DataTypes.STRING
    },
    name: {
        type: DataTypes.STRING
    },
    found: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    size: {
        type: DataTypes.INTEGER
    },
    createdAt: {
        type: DataTypes.DATE
    },
    updatedAt: {
        type: DataTypes.DATE
    }
}, {
    tableName: 'file',
    timestamps: true,
    modelName: 'FileHandler'
});
const cache = new SequelizeSimpleCache({ File: { ttl: 30 * 60 } });
export const FileModel = cache.init(UncachedFileModel);
export const startDatabase = () => __awaiter(void 0, void 0, void 0, function* () {
    yield sequelize.sync({ alter: true });
    console.log('Connected to the local DB');
});
// TODO: webtorrent.add() all known files
