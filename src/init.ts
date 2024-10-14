import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { NODES_PATH } from "./nodes.ts";
import { fileURLToPath } from "node:url";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

function init(config: Config): void {
  if (!fs.existsSync(path.join(DIRNAME, "../files"))) {
    Deno.mkdir(path.join(DIRNAME, "../files"), { recursive: true });
  }
  if (!fs.existsSync(NODES_PATH)) {
    fs.writeFileSync(NODES_PATH, JSON.stringify(config.bootstrap_nodes));
  }
}

export default init;
