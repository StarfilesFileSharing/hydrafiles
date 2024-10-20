import Hydrafiles from "./hydrafiles.ts";
import fs from "node:fs";

const config = JSON.parse(fs.existsSync("config.json") ? new TextDecoder().decode(Deno.readFileSync("config.json")) : "{}");

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
