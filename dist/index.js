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
import CONFIG from './config.js';
import { nodesManager } from './nodes.js';
import FileHandler, { FileModel, startDatabase, webtorrentClient } from './fileHandler.js';
import { hashLocks, startServer } from './server.js';
import { calculateUsedStorage, convertTime } from './utils.js';
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
    constructor() {
        this.backgroundTasks = () => __awaiter(this, void 0, void 0, function* () {
            if (CONFIG.compare_nodes)
                nodesManager.compareNodeList().catch(console.error);
            if (CONFIG.compare_files) {
                (() => __awaiter(this, void 0, void 0, function* () {
                    for (let i = 0; i < nodesManager.getNodes({ includeSelf: false }).length; i++) {
                        yield nodesManager.compareFileList(nodesManager.nodes[i]);
                    }
                }))().catch(console.error);
            }
        });
        this.backfillFiles = () => __awaiter(this, void 0, void 0, function* () {
            const files = yield FileModel.findAll({ order: Sequelize.literal('RANDOM()') });
            for (let i = 0; i < files.length; i++) {
                const hash = files[i].dataValues.hash;
                console.log(`  ${hash}  Backfilling file`);
                const file = yield FileHandler.init({ hash });
                try {
                    yield file.getFile(nodesManager, { logDownloads: false }).catch((e) => { if (CONFIG.log_level === 'verbose')
                        console.error(e); });
                }
                catch (e) {
                    if (CONFIG.log_level === 'verbose')
                        throw e;
                }
            }
            this.backfillFiles().catch(console.error);
        });
        init();
        this.startTime = +new Date();
        (() => __awaiter(this, void 0, void 0, function* () {
            yield this.logState();
            setInterval(() => { this.logState().catch(console.error); }, CONFIG.summary_speed);
            yield startDatabase();
            startServer();
            setInterval(() => {
                this.backgroundTasks().catch(console.error);
            }, CONFIG.compare_speed);
            this.backgroundTasks().catch(console.error);
            if (CONFIG.backfill)
                this.backfillFiles().catch(console.error);
        }))().catch(console.error);
    }
    logState() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                console.log('\n===============================================\n========', new Date().toUTCString(), '========\n===============================================\n| Uptime: ', convertTime(+new Date() - this.startTime), '\n| Known (Network) Files:', yield FileModel.noCache().count(), `(${Math.round((100 * (yield FileModel.noCache().sum('size'))) / 1024 / 1024 / 1024) / 100}GB)`, '\n| Stored Files:', fs.readdirSync('files/').length, `(${Math.round((100 * calculateUsedStorage()) / 1024 / 1024 / 1024) / 100}GB)`, '\n| Processing Files:', hashLocks.size, '\n| Seeding Torrent Files:', (yield webtorrentClient()).torrents.length, '\n| Download Count:', yield FileModel.noCache().sum('downloadCount'), '\n===============================================\n');
            }
            catch (e) {
                console.error(e);
            }
        });
    }
}
export const hydrafiles = new Hydrafiles();
console.log('Hydrafiles Started', hydrafiles);
