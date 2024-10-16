import fs from "node:fs";
import Sequelize, {
  type FindOptions,
  type Model,
  type ModelCtor,
} from "npm:sequelize";
import init from "./init.ts";
import getConfig, { type Config } from "./config.ts";
import Nodes from "./nodes.ts";
import FileHandler, { type FileAttributes } from "./fileHandler.ts";
import startServer, { hashLocks } from "./server.ts";
import Utils from "./utils.ts";
import { S3 } from "npm:@aws-sdk/client-s3";
import startDatabase from "./database.ts";
import type { SequelizeSimpleCacheModel } from "npm:sequelize-simple-cache";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type WebTorrent from "npm:webtorrent";
import Blockchain, { Block } from "./block.ts";

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

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

class Hydrafiles {
  startTime: number;
  config: Config;
  nodes: Nodes;
  s3: S3;
  utils: Utils;
  FileHandler = FileHandler;
  FileModel:
    & ModelCtor<Model<FileAttributes, Partial<FileAttributes>>>
    & SequelizeSimpleCacheModel<Model<FileAttributes, Partial<FileAttributes>>>;
  webtorrent: WebTorrent;
  blockchain: Blockchain;
  constructor(customConfig: Partial<Config> = {}) {
    this.startTime = +new Date();
    this.config = getConfig(customConfig);
    this.utils = new Utils(this.config);
    this.s3 = new S3({
      region: "us-east-1",
      credentials: {
        accessKeyId: this.config.s3_access_key_id,
        secretAccessKey: this.config.s3_secret_access_key,
      },
      endpoint: this.config.s3_endpoint,
    });
    init(this.config);

    this.nodes = new Nodes(this);

    this.FileModel = startDatabase(this.config);
    startServer(this);
    // this.webtorrent = new WebTorrent()
    this.blockchain = new Blockchain(this);

    if (this.config.summary_speed !== -1) {
      this.logState().catch(console.error);
      setInterval(() => {
        this.logState().catch(console.error);
      }, this.config.summary_speed);
    }

    if (this.config.compare_speed !== -1) {
      setInterval(this.backgroundTasks, this.config.compare_speed);
      this.backgroundTasks();
    }

    this.consensus()
    // if (this.config.backfill) this.backfillFiles().catch(console.error)
  }
  async consensus() {
    const peers = this.blockchain.getPeers(await (this.blockchain.lastBlock() ?? new Block('genesis', this)).getHash())
    console.log(peers)
  }

  backgroundTasks = (): void => {
    const nodes = this.nodes;
    if (this.config.compare_nodes) nodes.compareNodeList();
    if (this.config.compare_files) {
      const knownNodes = nodes.getNodes({ includeSelf: false });
      for (let i = 0; i < knownNodes.length; i++) {
        nodes.compareFileList(knownNodes[i]).catch(console.error);
      }
    }
  };

  backfillFiles = async (): Promise<void> => {
    const files = await this.FileModel.findAll({
      order: Sequelize.literal("RANDOM()"),
    });
    for (let i = 0; i < files.length; i++) {
      const hash: string = files[i].dataValues.hash;
      console.log(`  ${hash}  Backfilling file`);
      const file = await this.FileHandler.init({ hash }, this);
      try {
        await file.getFile({ logDownloads: false });
      } catch (e) {
        if (this.config.log_level === "verbose") throw e;
      }
    }
    this.backfillFiles().catch(console.error);
  };

  async logState(): Promise<void> {
    try {
      console.log(
        "\n===============================================\n========",
        new Date().toUTCString(),
        "========\n===============================================\n| Uptime: ",
        this.utils.convertTime(+new Date() - this.startTime),
        "\n| Known (Network) Files:",
        await this.FileModel.noCache().count(),
        `(${
          Math.round(
            (100 * await this.FileModel.noCache().sum("size")) / 1024 / 1024 /
              1024,
          ) / 100
        }GB)`,
        "\n| Stored Files:",
        fs.readdirSync(path.join(DIRNAME, "../files/")).length,
        `(${
          Math.round(
            (100 * this.utils.calculateUsedStorage()) / 1024 / 1024 / 1024,
          ) / 100
        }GB)`,
        "\n| Processing Files:",
        hashLocks.size,
        // '\n| Seeding Torrent Files:',
        // (await webtorrentClient()).torrents.length,
        "\n| Download Count:",
        await this.FileModel.noCache().sum("downloadCount"),
        "\n===============================================\n",
      );
    } catch (e) {
      console.error(e);
    }
  }

  search = async <T>(
    where: FindOptions<T>,
    cache: boolean,
  ): Promise<Promise<FileAttributes[]>> => {
    const files = cache
      ? await this.FileModel.findAll(where)
      : await this.FileModel.noCache().findAll(where);
    return files.map((values) => values.dataValues);
  };
}

export default Hydrafiles;
