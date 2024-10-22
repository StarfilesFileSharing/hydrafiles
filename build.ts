import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

// const result = await esbuild.build({ plugins: [...denoPlugins()], entryPoints: ["./src/start.ts"], outfile: "./dist/hydrafiles-node.esm.js", bundle: true, format: "esm", platform: "node" });
// const result2 = await esbuild.build({ plugins: [...denoPlugins()], entryPoints: ["./src/start.ts"], outfile: "./dist/hydrafiles-node.cjs.js", bundle: true, format: "cjs", platform: "node" });
const result3 = await esbuild.build({ plugins: [...denoPlugins()], entryPoints: ["./src/hydrafiles.ts"], outfile: "./build/hydrafiles-web.esm.js", bundle: true, format: "esm", platform: "browser", sourcemap: true });
// const result4 = await esbuild.build({ plugins: [...denoPlugins()], entryPoints: ["./src/start.ts"], outfile: "./dist/hydrafiles-web.cjs.js", bundle: true, format: "cjs", platform: "browser" });

console.log(result3);

esbuild.stop();
