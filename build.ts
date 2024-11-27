import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

console.log(
	await esbuild.build({
		plugins: [...denoPlugins()],
		entryPoints: ["./src/hydrafiles.ts"],
		outfile: "./public/dist/hydrafiles-web.esm.js",
		bundle: true,
		format: "esm",
		platform: "browser",
		sourcemap: true,
		keepNames: true,
		minify: false, // TODO: Toggle for dev/prod
		treeShaking: false, // TODO: Toggle for dev/prod
		sourcesContent: true, // TODO: Toggle for dev/prod
		metafile: true,
	}),
	await esbuild.build({
		plugins: [...denoPlugins()],
		entryPoints: ["./web/dashboard.ts"],
		outfile: "./public/dist/dashboard.js",
		bundle: true,
		format: "esm",
		platform: "browser",
		sourcemap: true,
		keepNames: true,
		minify: false, // TODO: Toggle for dev/prod
		treeShaking: false, // TODO: Toggle for dev/prod
		sourcesContent: true, // TODO: Toggle for dev/prod
		metafile: true,
		external: ["https://esm.sh/webtorrent@2.5.1"],
	}),
);

esbuild.stop();
