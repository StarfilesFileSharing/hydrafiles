import type { Config } from "./config.ts";
import { NODES_PATH } from "./nodes.ts";
import { BLOCKSDIR } from "./block.ts";
import { join } from "https://deno.land/std/path/mod.ts";
import { existsSync } from "https://deno.land/std/fs/mod.ts";

function init(config: Config): void {
  if (!existsSync(join(Deno.cwd(), "../files"))) {
    Deno.mkdir(join(Deno.cwd(), "../files"), { recursive: true });
  }
  if (!existsSync(NODES_PATH)) {
    Deno.writeFileSync(
      NODES_PATH,
      new TextEncoder().encode(JSON.stringify(config.bootstrapNodes)),
    );
  }
  Deno.mkdir(BLOCKSDIR).catch((err) => {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  });
}

export default init;
