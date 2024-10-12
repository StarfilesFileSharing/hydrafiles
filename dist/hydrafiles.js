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
import Sequelize from 'sequelize';
import init from './init.js';
import getConfig from './config.js';
import Nodes from './nodes.js';
import FileHandler, { webtorrentClient } from './fileHandler.js';
import { hashLocks, startServer } from './server.js';
import Utils from './utils.js';
import { S3 } from '@aws-sdk/client-s3';
import startDatabase from './database.js';
// TODO: IDEA: HydraTorrent - New Github repo - "Hydrafiles + WebTorrent Compatibility Layer" - Hydrafiles noes can optionally run HydraTorrent to seed files via webtorrent
// Change index hash from sha256 to infohash, then allow nodes to leech files from webtorrent + normal torrent
// HydraTorrent is a WebTorrent hybrid client that plugs into Hydrafiles
// Then send a PR to WebTorrent for it to connect to the Hydrafiles network as default webseeds
// HydraTorrent is 2-way, allowing for fetching-seeding files via both hydrafiles and torrent
//
// ALSO THIS ALLOWS FOR PLAUSIBLE DENIABLITY FOR NORMAL TORRENTS
// Torrent clients can connect to the Hydrafiles network and claim they dont host any of the files they seed
// bittorrent to http proxy
// starfiles.co would use webtorrent to download files
class Hydrafiles {
    constructor(customConfig) {
        this.backgroundTasks = () => __awaiter(this, void 0, void 0, function* () {
            if (this.nodes === undefined) {
                console.error('Nodes manager is undefined');
                return;
            }
            const nodes = this.nodes;
            if (this.config.compare_nodes)
                nodes.compareNodeList().catch(console.error);
            if (this.config.compare_files) {
                (() => __awaiter(this, void 0, void 0, function* () {
                    const knownNodes = nodes.getNodes({ includeSelf: false });
                    for (let i = 0; i < knownNodes.length; i++) {
                        yield nodes.compareFileList(knownNodes[i]);
                    }
                }))().catch(console.error);
            }
        });
        this.backfillFiles = () => __awaiter(this, void 0, void 0, function* () {
            if (this.FileModel === undefined) {
                console.error('Database not open');
                return;
            }
            const files = yield this.FileModel.findAll({ order: Sequelize.literal('RANDOM()') });
            for (let i = 0; i < files.length; i++) {
                const hash = files[i].dataValues.hash;
                console.log(`  ${hash}  Backfilling file`);
                const file = yield this.FileHandler.init({ hash }, this.config, this.s3, this.FileModel);
                try {
                    if (this.nodes === undefined) {
                        console.error('Nodes manager is undefined');
                        return;
                    }
                    yield file.getFile(this.nodes, { logDownloads: false }).catch((e) => { if (this.config.log_level === 'verbose')
                        console.error(e); });
                }
                catch (e) {
                    if (this.config.log_level === 'verbose')
                        throw e;
                }
            }
            this.backfillFiles().catch(console.error);
        });
        this.startTime = +new Date();
        const config = getConfig(customConfig);
        this.config = config;
        this.utils = new Utils(config);
        this.FileHandler = FileHandler;
        init(this.config);
        const s3 = new S3({
            region: 'us-east-1',
            credentials: {
                accessKeyId: config.s3_access_key_id,
                secretAccessKey: config.s3_secret_access_key
            },
            endpoint: config.s3_endpoint
        });
        this.s3 = s3;
        (() => __awaiter(this, void 0, void 0, function* () {
            yield this.logState();
            setInterval(() => { this.logState().catch(console.error); }, config.summary_speed);
            const FileModel = yield startDatabase(config);
            this.FileModel = FileModel;
            const nodes = new Nodes(config, s3, FileModel);
            this.nodes = nodes;
            startServer(config, nodes, s3, FileModel);
            if (config.compare_speed !== -1) {
                setInterval(() => {
                    this.backgroundTasks().catch(console.error);
                }, config.compare_speed);
                this.backgroundTasks().catch(console.error);
            }
            if (config.backfill)
                this.backfillFiles().catch(console.error);
        }))().catch(console.error);
    }
    logState() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.FileModel === undefined) {
                console.error('Database not open');
                return;
            }
            try {
                console.log('\n===============================================\n========', new Date().toUTCString(), '========\n===============================================\n| Uptime: ', this.utils.convertTime(+new Date() - this.startTime), '\n| Known (Network) Files:', yield this.FileModel.noCache().count(), `(${Math.round((100 * (yield this.FileModel.noCache().sum('size'))) / 1024 / 1024 / 1024) / 100}GB)`, '\n| Stored Files:', fs.readdirSync('files/').length, `(${Math.round((100 * this.utils.calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`, '\n| Processing Files:', hashLocks.size, '\n| Seeding Torrent Files:', (yield webtorrentClient()).torrents.length, '\n| Download Count:', yield this.FileModel.noCache().sum('downloadCount'), '\n===============================================\n');
            }
            catch (e) {
                console.error(e);
            }
        });
    }
}
export default Hydrafiles;
