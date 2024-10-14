import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Hydrafiles from "./hydrafiles.ts";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  fs.existsSync(path.join(DIRNAME, "../config.json"))
    ? fs.readFileSync(path.join(DIRNAME, "../config.json")).toString()
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
//     const file = await hydrafiles.FileHandler.init(files[0], hydrafiles)
//     const fileContent = await file.getFile()
//     console.log(fileContent)
//   }
// })().catch(console.error)
