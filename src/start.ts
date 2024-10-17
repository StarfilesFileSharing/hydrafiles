import Hydrafiles from "./hydrafiles.ts";
import { existsSync } from "https://deno.land/std/fs/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";

const config = JSON.parse(
  existsSync(join(Deno.cwd(), "../config.json"))
    ? new TextDecoder().decode(
      Deno.readFileSync(join(Deno.cwd(), "../config.json")),
    )
    : "{}",
);

const hydrafiles = new Hydrafiles(config);
console.log("Hydrafiles Started", hydrafiles);

// (async () => {
//   // Example Search
//   const files = await hydrafiles.search({ where: { name: 'i-am-spartacus-its-me.gif' } }, false)
//   if (files.length === 0) console.error('File not found')
//   else {
//     // Example Download
//     const file = new FileHandler(files[0], hydrafiles)
//     const fileContent = await file.getFile()
//     console.log(fileContent)
//   }
// })().catch(console.error)
