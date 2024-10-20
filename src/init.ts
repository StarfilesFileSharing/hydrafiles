import type { Config } from "./config.ts";
import { NODES_PATH } from "./nodes.ts";
import { BLOCKSDIR } from "./block.ts";
import { existsSync } from "https://deno.land/std@0.224.0/fs/mod.ts";
import fs from "node:fs";

function init(config: Config): void {
	if (!existsSync("files/")) Deno.mkdir("files", { recursive: true });
	if (!existsSync(NODES_PATH)) Deno.writeFileSync(NODES_PATH, new TextEncoder().encode(JSON.stringify(config.bootstrapNodes)));
	if (!fs.existsSync(BLOCKSDIR)) Deno.mkdir(BLOCKSDIR);
}

export default init;
