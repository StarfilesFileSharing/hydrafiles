import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

console.log(
	await esbuild.build({
		plugins: [...denoPlugins()],
		entryPoints: ["./src/hydrafiles.ts"],
		outfile: "./build/hydrafiles-web.esm.js",
		bundle: true,
		format: "esm",
		platform: "browser",
		sourcemap: true,
		minify: true,
		treeShaking: true,
	}),
	await esbuild.build({
		plugins: [...denoPlugins()],
		entryPoints: ["./web/dashboard.ts"],
		outfile: "./build/dashboard.js",
		bundle: true,
		format: "esm",
		platform: "browser",
		sourcemap: true,
		minify: true,
		treeShaking: true,
		external: ["https://esm.sh/webtorrent@2.5.1"],
	}),
);

esbuild.stop();
