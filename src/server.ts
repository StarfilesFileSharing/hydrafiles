import formidable from "npm:formidable";

import type Hydrafiles from "./hydrafiles.ts";
import { BLOCKSDIR } from "./block.ts";
import { join } from "https://deno.land/std/path/mod.ts";
import { existsSync } from "https://deno.land/std/fs/mod.ts";
import File, { fileManager } from "./file.ts";

export const hashLocks = new Map<string, Promise<Response>>();

const handleRequest = async (
  req: Request,
  client: Hydrafiles,
): Promise<Response> => {
  const url = new URL(req.url);
  const headers = new Headers();

  try {
    if (url.pathname === "/" || url.pathname === undefined) {
      headers.set("Content-Type", "text/html");
      headers.set("Cache-Control", "public, max-age=604800");
      return new Response(await Deno.readFile("public/index.html"), { headers });
    } else if (url.pathname === "/favicon.ico") {
      headers.set("Content-Type", "image/x-icon");
      headers.set("Cache-Control", "public, max-age=604800");
      return new Response(await Deno.readFile("public/favicon.ico"), { headers });
    } else if (url.pathname === "/status") {
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ status: true }));
    } else if (url.pathname === "/nodes") {
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "public, max-age=300");
      return new Response(JSON.stringify(await client.nodes.getValidNodes()));
    } else if (url.pathname.startsWith("/announce")) {
      const params = Object.fromEntries(
        new URLSearchParams(url.pathname.split("?")[1]),
      );
      const host = params.host;

      const knownNodes = client.nodes.getNodes();
      if (knownNodes.find((node) => node.host === host) !== null) {
        return new Response("Already known\n");
      }

      if (
        await client.nodes.downloadFromNode(
          client.nodes.nodeFrom(host),
          new File({
            hash:
              "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f",
          }, client),
        ) !== false
      ) {
        await client.nodes.add(client.nodes.nodeFrom(host));
        return new Response("Announced\n");
      } else return new Response("Invalid request\n");
    } else if (url.pathname?.startsWith("/download/")) {
      const hash = url.pathname.split("/")[2];
      const fileId = url.pathname.split("/")[3] ?? "";
      const infohash = Array.from(
        decodeURIComponent(url.searchParams.get("info_hash") ?? ""),
      ).map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join(
        "",
      );

      if (hashLocks.has(hash)) {
        if (client.config.logLevel === "verbose") {
          console.log(`  ${hash}  Waiting for existing request with same hash`);
        }
        await hashLocks.get(hash);
      }
      const processingPromise = (async () => {
        const file = new File({ hash, infohash }, client);

        if (fileId.length !== 0) {
          const id = file.id;
          if (id === undefined || id === null || id.length === 0) {
            file.id = fileId;
            file.save();
          }
        }

        await file.getMetadata();
        let fileContent: { file: Uint8Array; signal: number } | false;
        try {
          fileContent = await file.getFile();
        } catch (e) {
          const err = e as { message: string };
          if (err.message === "Promise timed out") fileContent = false;
          else throw e;
        }

        if (fileContent === false) {
          file.found = false;
          await file.save();
          return new Response("404 File Not Found\n", { status: 404 });
        }

        headers.set("Content-Type", "application/octet-stream");
        headers.set("Cache-Control", "public, max-age=31536000");
        headers.set("Content-Length", fileContent.file.byteLength.toString());
        headers.set("Signal-Strength", String(fileContent.signal));
        console.log(
          `  ${hash}  Signal Strength:`,
          fileContent.signal,
          client.utils.estimateHops(fileContent.signal),
        );

        headers.set("Content-Length", String(file.size));
        headers.set(
          "Content-Disposition",
          `attachment; filename="${
            encodeURIComponent(file.name ?? "File").replace(/%20/g, " ")
              .replace(/(\.\w+)$/, " [HYDRAFILES]$1")
          }`,
        );

        return new Response(fileContent.file, { headers });
      })();

      hashLocks.set(hash, processingPromise);

      let response: Response
      try {
        response = await processingPromise;
      } finally {
        hashLocks.delete(hash);
      }
      return response
    } else if (url.pathname?.startsWith("/infohash/")) {
      const infohash = url.pathname.split("/")[2];

      if (hashLocks.has(infohash)) {
        console.log(
          `  ${infohash}  Waiting for existing request with same infohash`,
        );
        await hashLocks.get(infohash);
      }
      const processingPromise = (async () => {
        const file = new File({ infohash }, client);

        await file.getMetadata();
        let fileContent: { file: Uint8Array; signal: number } | false;
        try {
          fileContent = await file.getFile();
        } catch (e) {
          const err = e as { message: string };
          if (err.message === "Promise timed out") fileContent = false;
          else throw e;
        }

        if (fileContent === false) {
          file.found = false;
          await file.save();
          return new Response("404 File Not Found\n", { status: 404 });
        }

        headers.set("Content-Type", "application/octet-stream");
        headers.set("Cache-Control", "public, max-age=31536000");

        headers.set("Signal-Strength", String(fileContent.signal));
        console.log(
          `  ${file.hash}  Signal Strength:`,
          fileContent.signal,
          client.utils.estimateHops(fileContent.signal),
        );

        headers.set("Content-Length", String(file.size));
        headers.set(
          "Content-Disposition",
          `attachment; filename="${
            encodeURIComponent(file.name ?? "File").replace(/%20/g, " ")
              .replace(/(\.\w+)$/, " [HYDRAFILES]$1")
          }"`,
        );

        return new Response(fileContent.file, { headers });
      })();

      hashLocks.set(infohash, processingPromise);

      try {
        await processingPromise;
      } finally {
        hashLocks.delete(infohash);
      }
    } else if (url.pathname === "/upload") {
      const uploadSecret = req.headers.get("x-hydra-upload-secret");
      if (uploadSecret !== client.config.uploadSecret) {
        return new Response("401 Unauthorized\n", { status: 401 });
      }

      const form = formidable({});
      form.parse(
        req,
        (err: unknown, fields: formidable.Fields, files: formidable.Files) => {
          if (err !== undefined && err !== null) {
            return new Response("500 Internal Server Error\n", { status: 500 });
          }

          if (
            typeof fields.hash === "undefined" ||
            typeof files.file === "undefined"
          ) {
            return new Response("400 Bad Request\n", { status: 400 });
          }

          const hash = fields.hash[0];
          const uploadedFile = files.file[0];

          const file = new File({ hash }, client);
          let name = file.name;
          if (
            (name === undefined || name === null || name.length === 0) &&
            uploadedFile.originalFilename !== null
          ) {
            name = uploadedFile.originalFilename;
            file.name = name;
            file.cacheFile(Deno.readFileSync(uploadedFile.filepath));
            file.save();
          }

          console.log("Uploading", hash);

          if (existsSync(join(new URL('.', import.meta.url).pathname, "../files", hash))) {
            return new Response("200 OK\n");
          }

          if (!client.config.permaFiles.includes(hash)) {
            client.config.permaFiles.push(hash);
          }
          Deno.writeFileSync(
            join(new URL('.', import.meta.url).pathname, "config.json"),
            new TextEncoder().encode(JSON.stringify(client.config, null, 2)),
          );
          return new Response("200 OK\n");
        },
      );
    } else if (url.pathname === "/files") {
      const rows = fileManager.select()
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "public, max-age=10800");
      return new Response(JSON.stringify(rows), { headers });
    } else if (url.pathname.startsWith("/block/")) {
      const blockHeight = url.pathname.split("/")[2];
      headers.set("Content-Type", "application/json");
      // "Cache-Control": "public, max-age=" + (Number(blockHeight) > client.blockchain.lastBlock().height ? 0 : 604800),
      const block = await Deno.readFile(join(BLOCKSDIR, blockHeight));
      return new Response(block, { headers });
    } else if (url.pathname === "/block_height") {
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "public, max-age=30");
      // return new Response(String(client.blockchain.lastBlock().height));
    } else {
      return new Response("404 Page Not Found\n", { status: 404 });
    }
  } catch (e) {
    console.error(e);
    return new Response("Internal Server Error", { status: 500 });
  }
  return new Response("Something went wrong", { status: 500 });
};

const onListen = (client: Hydrafiles): void => {
  console.log(`Server running at ${client.config.publicHostname}/`);

  const handleListen = async (): Promise<void> => {
    console.log("Testing network connection");
    const file = await client.nodes.getFile(
      "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f",
    );
    if (file === false) {
      console.error("Download test failed, cannot connect to network");
    } else {
      console.log("Connected to network");

      if (
        client.utils.isIp(client.config.publicHostname) &&
        client.utils.isPrivateIP(client.config.publicHostname)
      ) {
        console.error(
          "Public hostname is a private IP address, cannot announce to other nodes",
        );
      } else {
        console.log(
          `Testing downloads ${client.config.publicHostname}/download/04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f`,
        );

        console.log("Testing connectivity");
        const response = await client.nodes.downloadFromNode(
          client.nodes.nodeFrom(`${client.config.publicHostname}`),
          new File({
            hash:
              "04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f",
          }, client),
        );
        if (response === false) {
          console.error(
            "  04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f  ERROR: Failed to download file from self",
          );
        } else {
          console.log(
            "  04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f  Test Succeeded",
          );
          console.log("Announcing to nodes");
          client.nodes.announce();
        }
        await client.nodes.add({
          host: client.config.publicHostname,
          http: true,
          dns: false,
          cf: false,
          hits: 0,
          rejects: 0,
          bytes: 0,
          duration: 0,
        });
      }
    }
  };
  handleListen().catch(console.error);
};

const startServer = (client: Hydrafiles): void => {
  console.log("Starting server");

  Deno.serve({
    port: client.config.port,
    hostname: client.config.hostname,
    onListen({ hostname, port }): void {
      onListen(client);
      console.log(`Server started at ${hostname}:${port}`);
    },
    handler: async (req: Request): Promise<Response> =>
      await handleRequest(req, client),
  });
};
export default startServer;
