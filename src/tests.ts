import { assert } from "jsr:@std/assert/assert";
import { handleRequest } from "./server.ts";
import type Hydrafiles from "./hydrafiles.ts";
import getConfig from "./config.ts";
import Utils from "./utils.ts";
import { FileManager } from "./file.ts";
import Nodes from "./nodes.ts";

class MockHydrafiles {
  config = getConfig();
  utils = new Utils(this.config);
  fileManager = new FileManager(this as unknown as Hydrafiles);
  nodes = new Nodes(this as unknown as Hydrafiles);
}

const mockClient = new MockHydrafiles() as unknown as Hydrafiles;

Deno.test("handleRequest - Root path returns index.html", async () => {
  const req = new Request("http://localhost/");
  const response = await handleRequest(req, mockClient);

  assert(response.status === 200);
  assert((await response.text()).startsWith("<!DOCTYPE html"));
  assert(response.headers.get("Content-Type") === "text/html");
});

Deno.test("handleRequest - /status returns JSON with status", async () => {
  const req = new Request("http://localhost/status");
  const response = await handleRequest(req, mockClient);

  const json = await response.json();
  assert(response.status === 200);
  assert(json.status === true);
});

Deno.test("handleRequest - /nodes returns JSON of valid nodes", async () => {
  const req = new Request("http://localhost/nodes");
  const response = await handleRequest(req, mockClient);

  const nodes = await response.json();
  assert(response.status === 200);
  assert(nodes.length !== 0);
  assert(nodes[0].host === "localhost");
});

Deno.test("handleRequest - /announce with valid node adds the node", async () => {
  const req = new Request("http://localhost/announce?host=localhost");
  const response = await handleRequest(req, mockClient);

  const text = await response.text();
  assert(response.status === 200);
  assert(text === "Announced\n" || text === "Already known\n");
});

Deno.test("handleRequest - /download/ returns file content", async () => {
  const req = new Request("http://localhost/download/04aa07009174edc6f03224f003a435bcdc9033d2c52348f3a35fbb342ea82f6f");
  const response = await handleRequest(req, mockClient);

  const body = await response.text();
  assert(response.status === 200, String(response.status));
  assert(body === "mocked file content");
  assert(response.headers.get("Content-Type") === "application/octet-stream");
});
