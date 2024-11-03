import { existsSync } from "jsr:@std/fs/exists";
import Hydrafiles from "./hydrafiles.ts";

const configPath = Deno.args[0] ?? "config.json";
const config = JSON.parse(existsSync(configPath) ? new TextDecoder().decode(Deno.readFileSync(configPath)) : "{}");
const hydrafiles = new Hydrafiles(config);
hydrafiles.start().then(() => console.log("Hydrafiles Started", hydrafiles));

// (async () => {
//   // Example Search
//   const files = hydrafiles.search({ where: { key: "name", value: "i-am-spartacus-its-me.gif" } });
//   if (files.length === 0) console.error("File not found");
//   else {
//     // Example Download
//     const file = new FileHandler(files[0], hydrafiles);
//     const fileContent = await file.getFile();
//     console.log(fileContent);
//   }
// })().catch(console.error);
