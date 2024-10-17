import FileHandler from "./fileHandler.ts";
import type Hydrafiles from "./hydrafiles.ts";
import { existsSync } from "https://deno.land/std/fs/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";
import type { File } from "./database.ts"

export interface Node {
  host: string;
  http: boolean;
  dns: boolean;
  cf: boolean;
  hits: number;
  rejects: number;
  bytes: number;
  duration: number;
  status?: boolean;
}

export const NODES_PATH = join(Deno.cwd(), "../nodes.json");

export default class Nodes {
  private nodes: Node[];
  private _client: Hydrafiles;
  constructor(client: Hydrafiles) {
    this.nodes = this.loadNodes();
    this._client = client;
  }

  async add(node: Node): Promise<void> {
    if (
      node.host !== this._client.config.publicHostname &&
      typeof this.nodes.find((existingNode) =>
          existingNode.host === node.host
        ) === "undefined" &&
      (await this.downloadFromNode(
        node,
        new FileHandler({
          hash:
            "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f",
        }, this._client),
      ) !== false)
    ) {
      this.nodes.push(node);
      Deno.writeFileSync(
        NODES_PATH,
        new TextEncoder().encode(JSON.stringify(this.nodes)),
      );
    }
  }

  loadNodes(): Node[] {
    return JSON.parse(
      existsSync(NODES_PATH)
        ? new TextDecoder().decode(Deno.readFileSync(NODES_PATH))
        : "[]",
    );
  }

  public getNodes = (opts = { includeSelf: true }): Node[] => {
    if (opts.includeSelf === undefined) opts.includeSelf = true;
    const nodes = this.nodes.filter((node) =>
      opts.includeSelf || node.host !== this._client.config.publicHostname
    ).sort(() => Math.random() - 0.5);

    if (this._client.config.preferNode === "FASTEST") {
      return nodes.sort((
        a: { bytes: number; duration: number },
        b: { bytes: number; duration: number },
      ) => a.bytes / a.duration - b.bytes / b.duration);
    } else if (this._client.config.preferNode === "LEAST_USED") {
      return nodes.sort((
        a: { hits: number; rejects: number },
        b: { hits: number; rejects: number },
      ) => a.hits - a.rejects - (b.hits - b.rejects));
    } else if (this._client.config.preferNode === "HIGHEST_HITRATE") {
      return nodes.sort((
        a: { hits: number; rejects: number },
        b: { hits: number; rejects: number },
      ) => (a.hits - a.rejects) - (b.hits - b.rejects));
    } else return nodes;
  };

  async downloadFromNode(
    node: Node,
    file: FileHandler,
  ): Promise<{ file: Uint8Array; signal: number } | false> {
    try {
      const startTime = Date.now();

      const hash = file.hash;
      console.log(`  ${hash}  Downloading from ${node.host}`);
      let response;
      try {
        response = await this._client.utils.promiseWithTimeout(
          fetch(`${node.host}/download/${hash}`),
          this._client.config.timeout,
        );
      } catch (e) {
        if (this._client.config.logLevel === "verbose") console.error(e);
        return false;
      }
      const fileContent = new Uint8Array(await response.arrayBuffer());
      console.log(`  ${hash}  Validating hash`);
      const verifiedHash = await this._client.utils.hashUint8Array(fileContent);
      if (hash !== verifiedHash) return false;

      if (
        file.name === undefined || file.name === null || file.name.length === 0
      ) {
        file.name = String(
          response.headers.get("Content-Disposition")?.split("=")[1].replace(
            /"/g,
            "",
          ).replace(" [HYDRAFILES]", ""),
        );
        await file.save();
      }

      node.status = true;
      node.duration += Date.now() - startTime;
      node.bytes += fileContent.byteLength;
      node.hits++;
      this.updateNode(node);

      await file.cacheFile(fileContent);
      return {
        file: fileContent,
        signal: this._client.utils.interfere(
          Number(response.headers.get("Signal-Strength")),
        ),
      };
    } catch (e) {
      console.error(e);
      node.rejects++;

      this.updateNode(node);
      return false;
    }
  }

  updateNode(node: Node): void {
    const index = this.nodes.findIndex((n) => n.host === node.host);
    if (index !== -1) {
      this.nodes[index] = node;
      Deno.writeFileSync(
        NODES_PATH,
        new TextEncoder().encode(JSON.stringify(this.nodes)),
      );
    }
  }

  async getValidNodes(opts = { includeSelf: true }): Promise<Node[]> {
    const nodes = this.getNodes(opts);
    const results: Node[] = [];
    const executing: Array<Promise<void>> = [];

    for (const node of nodes) {
      if (node.host === this._client.config.publicHostname) {
        results.push(node);
        continue;
      }
      const promise = this.validateNode(node).then((result) => {
        results.push(result);
        executing.splice(executing.indexOf(promise), 1);
      });
      executing.push(promise);
    }
    await Promise.all(executing);
    return results;
  }

  async validateNode(node: Node): Promise<Node> {
    const file = await this.downloadFromNode(
      node,
      new FileHandler({
        hash:
          "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f",
      }, this._client),
    );
    if (file !== false) {
      node.status = true;
      this.updateNode(node);
      return node;
    } else {
      node.status = false;
      this.updateNode(node);
      return node;
    }
  }

  async getFile(
    hash: string,
    size = 0,
  ): Promise<{ file: Uint8Array; signal: number } | false> {
    console.log(`  ${hash}  Getting file from nodes`);
    const nodes = this.getNodes({ includeSelf: false });
    const activePromises: Array<
      Promise<{ file: Uint8Array; signal: number } | false>
    > = [];

    if (!this._client.utils.hasSufficientMemory(size)) {
      console.log("Reached memory limit, waiting");
      await new Promise(() => {
        const intervalId = setInterval(() => {
          if (this._client.utils.hasSufficientMemory(size)) {
            clearInterval(intervalId);
          }
        }, this._client.config.memoryThresholdReachedWait);
      });
    }

    for (const node of nodes) {
      if (node.http && node.host.length > 0) {
        const promise =
          (async (): Promise<{ file: Uint8Array; signal: number } | false> => {
            const file = new FileHandler({ hash }, this._client);
            let fileContent: { file: Uint8Array; signal: number } | false =
              false;
            try {
              fileContent = await this.downloadFromNode(node, file);
            } catch (e) {
              console.error(e);
            }
            return fileContent !== false ? fileContent : false;
          })();
        activePromises.push(promise);
      }
    }

    const files = await Promise.all(activePromises);
    for (let i = 0; i < files.length; i++) {
      if (files[i] !== false) return files[i];
    }

    return false;
  }

  async announce(): Promise<void> {
    for (const node of this.getNodes({ includeSelf: false })) {
      if (node.http) {
        if (node.host === this._client.config.publicHostname) continue;
        console.log("Announcing to", node.host);
        await fetch(
          `${node.host}/announce?host=${this._client.config.publicHostname}`,
        );
      }
    }
  }

  async compareFileList(node: Node): Promise<void> { // TODO: Compare list between all nodes and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
    try {
      console.log(`Comparing file list with ${node.host}`);
      const response = await fetch(`${node.host}/files`);
      const files = await response.json() as File[];
      for (let i = 0; i < files.length; i++) {
        try {
          const file = new FileHandler({
            hash: files[i].hash,
            infohash: files[i].infohash ?? undefined,
          }, this._client);
          if (file.infohash?.length === 0 && files[i].infohash?.length !== 0) {
            file.infohash = files[i].infohash;
          }
          if (file.id?.length === 0 && files[i].id?.length !== 0) {
            file.id = files[i].id;
          }
          if (file.name?.length === 0 && files[i].name?.length !== 0) {
            file.name = files[i].name;
          }
          if (file.size === 0 && files[i].size !== 0) file.size = files[i].size;
          file.save();
        } catch (e) {
          console.error(e);
        }
      }
    } catch (e) {
      const err = e as { message: string };
      console.error(
        `Failed to compare file list with ${node.host} - ${err.message}`,
      );
      return;
    }
    console.log(`Done comparing file list with ${node.host}`);
  }

  compareNodeList(): void { // TODO: Compare list between all nodes and give score based on how similar they are. 100% = all exactly the same, 0% = no items in list were shared. The lower the score, the lower the propagation times, the lower the decentralisation
    console.log("Comparing node list");
    const nodes = this.getNodes({ includeSelf: false });
    for (const node of nodes) {
      (async () => {
        if (
          node.host.startsWith("http://") || node.host.startsWith("https://")
        ) {
          console.log(`Fetching nodes from ${node.host}/nodes`);
          try {
            const response = await this._client.utils.promiseWithTimeout(
              fetch(`${node.host}/nodes`),
              this._client.config.timeout,
            );
            const remoteNodes = await response.json() as Node[];
            for (const remoteNode of remoteNodes) {
              this.add(remoteNode).catch((e) => {
                if (this._client.config.logLevel === "verbose") {
                  console.error(e);
                }
              });
            }
          } catch (e) {
            if (this._client.config.logLevel === "verbose") throw e;
          }
        }
      })().catch(console.error);
    }
  }

  nodeFrom(host: string): Node {
    const node: Node = {
      host,
      http: true,
      dns: false,
      cf: false,
      hits: 0,
      rejects: 0,
      bytes: 0,
      duration: 0,
    };
    return node;
  }

  async getBlockHeights(): Promise<{ [key: number]: string[] }> {
    const blockHeights = await Promise.all(
      this.getNodes().map(async (node) => {
        try {
          const response = await this._client.utils.promiseWithTimeout(
            fetch(`${node.host}/block_height`),
            this._client.config.timeout,
          );
          const blockHeight = await response.text();
          return isNaN(Number(blockHeight)) ? 0 : Number(blockHeight);
        } catch (error) {
          console.error(
            `Error fetching block height from ${node.host}:`,
            error,
          );
          return 0;
        }
      }),
    );
    const result = this.getNodes().reduce(
      (acc: { [key: number]: string[] }, node, index) => {
        if (typeof acc[blockHeights[index]] === "undefined") {
          acc[blockHeights[index]] = [];
        }
        acc[blockHeights[index]].push(node.host);
        return acc;
      },
      {},
    );
    return result;
  }
}
