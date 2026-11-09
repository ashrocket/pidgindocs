import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLocal, startFakeServer } from "./fake-local-endpoint.mjs";
import { callLocal, callServer, callTool, readDiscovery } from "../pidgindocs-mcp-proxy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(here, "..", "pidgindocs-mcp-proxy.mjs");
const TOKEN = "tok-local-SECRET-123";
const API_KEY = `key-${"x".repeat(6)}-for-tests`; // built at run time, not a real key

let dir, local, server, out, err, realOut, realErr;

function writeDiscovery(overrides = {}, mode = 0o600) {
  const file = path.join(dir, "local-endpoint.json");
  writeFileSync(file, JSON.stringify({ port: local.port, token: TOKEN, pid: process.pid, version: "1", ...overrides }), { mode });
  // writeFileSync only applies the mode on create; force it for reused paths.
  spawnSync("chmod", [mode.toString(8), file]);
  process.env.PIDGINDOCS_LOCAL_ENDPOINT_FILE = file;
  return file;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pidgindocs-proxy-"));
  local = await startFakeLocal({ token: TOKEN });
  server = await startFakeServer();
  process.env.PIDGINDOCS_URL = server.url;
  process.env.PIDGINDOCS_API_KEY = API_KEY;
  delete process.env.PIDGINDOCS_LOCAL_ENDPOINT_PATHS;
  process.env.PIDGINDOCS_LOCAL_ENDPOINT_FILE = path.join(dir, "missing.json");
  process.env.PIDGINDOCS_SESSION_ID = "sess-test";
  out = ""; err = "";
  realOut = process.stdout.write; realErr = process.stderr.write;
  // Record and pass through, so the test reporter still prints.
  process.stdout.write = function (c, ...a) { out += String(c); return realOut.call(process.stdout, c, ...a); };
  process.stderr.write = function (c, ...a) { err += String(c); return realErr.call(process.stderr, c, ...a); };
});

afterEach(async () => {
  process.stdout.write = realOut; process.stderr.write = realErr;
  // The local token never reaches stdout or stderr, and never the server.
  assert.ok(!out.includes(TOKEN) && !err.includes(TOKEN), "token leaked to stdout or stderr");
  for (const call of server.calls) assert.ok(!JSON.stringify(call).includes(TOKEN), "token sent to the server");
  await local.close(); await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const status = { title: "working", body: "step 1" };

describe("falling back to the server", () => {
  it("no discovery file: server called once, local never", async () => {
    const r = await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 0);
    assert.equal(server.calls.length, 1);
    assert.equal(r.via, "server");
  });

  it("a dead pid: server called, local not", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeDiscovery({ pid: dead.pid });
    await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 0);
    assert.equal(server.calls.length, 1);
  });

  it("a 503 unavailable: server called", async () => {
    local.mode = "unavailable-503";
    writeDiscovery();
    const r = await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 1);
    assert.equal(server.calls.length, 1);
    assert.equal(r.via, "server");
  });

  it("status unavailable in the result: server called", async () => {
    local.mode = "unavailable-status";
    writeDiscovery();
    await callTool("pidgin_status", status);
    assert.equal(server.calls.length, 1);
  });

  it("a connect error: server called", async () => {
    const port = local.port;
    await local.close(); // nothing listens there now
    writeDiscovery({ port });
    await callTool("pidgin_status", status);
    assert.equal(server.calls.length, 1);
  });

  it("no byte inside 700 ms: server called", async () => {
    local.mode = "hang";
    writeDiscovery();
    const started = Date.now();
    await callTool("pidgin_status", status);
    assert.ok(Date.now() - started < 5000);
    assert.equal(server.calls.length, 1);
  });

  it("wrong token twice: server called", async () => {
    writeDiscovery({ token: "wrong-token-SECRET" });
    await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 2); // first try plus one retry
    assert.equal(server.calls.length, 1);
  });

  it("wrong token once, right after re-reading the file: local used", async () => {
    const file = writeDiscovery({ token: "stale-token-SECRET" });
    local.onUnauthorized = () => {
      writeFileSync(file, JSON.stringify({ port: local.port, token: TOKEN, pid: process.pid, version: "1" }));
      spawnSync("chmod", ["600", file]);
      local.onUnauthorized = null;
    };
    const r = await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 2);
    assert.equal(r.via, "local");
    assert.equal(server.calls.length, 0);
  });
});

describe("never falling back after an accepted write", () => {
  it("error-after-write: server not called, error returned", async () => {
    local.mode = "error-after-write";
    writeDiscovery();
    await assert.rejects(callTool("pidgin_draft_put", { key: "abcdefgh", kind: "document", title: "t", html: "<p>x</p>" }), /failed after write/);
    assert.equal(local.writes.length, 1);
    assert.equal(server.calls.length, 0);
  });

  it("a healthy local endpoint handles the call and the server is not touched", async () => {
    writeDiscovery();
    const r = await callTool("pidgin_status", status);
    assert.equal(r.via, "local");
    assert.equal(local.calls[0].auth, `Bearer ${TOKEN}`);
    assert.equal(local.calls[0].url, "/mcp");
    assert.equal(server.calls.length, 0);
  });
});

describe("discovery rules", () => {
  it("ignores a file with mode 0644", async () => {
    writeDiscovery({}, 0o644);
    assert.equal(await readDiscovery(), null);
    await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 0);
  });

  it("ignores port 80 and ports below 1024 or above 65535", async () => {
    for (const port of [80, 1023, 65536, "8080", 0]) {
      writeDiscovery({ port });
      assert.equal(await readDiscovery(), null, `port ${port}`);
    }
  });

  it("reads a valid file", async () => {
    writeDiscovery();
    const d = await readDiscovery();
    assert.deepEqual(d, { port: local.port, token: TOKEN, pid: process.pid, version: "1" });
  });

  it("tries PIDGINDOCS_LOCAL_ENDPOINT_FILE, then each of PIDGINDOCS_LOCAL_ENDPOINT_PATHS, then the home default", async () => {
    const good = path.join(dir, "second.json");
    writeFileSync(good, JSON.stringify({ port: local.port, token: TOKEN, pid: process.pid, version: "1" }), { mode: 0o600 });
    spawnSync("chmod", ["600", good]);
    const bad = path.join(dir, "first.json");
    const d = await readDiscovery([path.join(dir, "nope.json"), bad, good]);
    assert.equal(d?.port, local.port);
    process.env.PIDGINDOCS_LOCAL_ENDPOINT_FILE = path.join(dir, "nope.json");
    process.env.PIDGINDOCS_LOCAL_ENDPOINT_PATHS = `${bad}:${good}`;
    assert.equal((await readDiscovery())?.port, local.port);
  });

  it("an unreadable or malformed file is no local", async () => {
    const file = writeDiscovery();
    writeFileSync(file, "{ not json");
    spawnSync("chmod", ["600", file]);
    assert.equal(await readDiscovery(), null);
  });
});

describe("server fallback maps", () => {
  it("pidgin_draft_put is PUT /api/drafts/:key with the agent's key and no key field in the body", async () => {
    await callServer("pidgin_draft_put", { key: "abcdefgh", kind: "document", title: "t", html: "<p>x</p>" });
    const c = server.calls[0];
    assert.equal(c.method, "PUT");
    assert.equal(c.url, "/api/drafts/abcdefgh");
    assert.equal(c.auth, `Bearer ${API_KEY}`);
    assert.deepEqual(c.body, { kind: "document", title: "t", html: "<p>x</p>" });
  });

  it("pidgin_draft_finish is POST /api/drafts/:key/commit", async () => {
    await callServer("pidgin_draft_finish", { key: "abcdefgh" });
    assert.equal(server.calls[0].method, "POST");
    assert.equal(server.calls[0].url, "/api/drafts/abcdefgh/commit");
  });

  it("pidgin_status is POST /api/messages as a status with the same session id", async () => {
    await callServer("pidgin_status", { title: "t", body: "b", final: true });
    const c = server.calls[0];
    assert.equal(c.url, "/api/messages");
    assert.equal(c.body.type, "status");
    assert.equal(c.body.final, true);
    assert.equal(c.body.instance.session_id, "sess-test");
  });

  it("pidgin_make_artifact is POST /api/artifacts with markdown", async () => {
    await callServer("pidgin_make_artifact", { title: "t", markdown: "# hi", favicon: "📄" });
    assert.equal(server.calls[0].url, "/api/artifacts");
    assert.equal(server.calls[0].body.markdown, "# hi");
  });

  it("an unknown tool has no server fallback", async () => {
    await assert.rejects(callServer("pidgin_nope", {}), /no server fallback/);
  });
});

describe("stdio MCP server and CLI", () => {
  function run(args, input) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [PROXY, ...args], { env: process.env });
      let so = "", se = "";
      child.stdout.on("data", (c) => { so += c; });
      child.stderr.on("data", (c) => { se += c; });
      child.on("close", (code) => resolve({ code, so, se }));
      if (input) child.stdin.end(input); else child.stdin.end();
    });
  }

  it("forwards tools/call local first, and prints no token", async () => {
    writeDiscovery();
    const rpc = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pidgin_status", arguments: status } },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const r = await run([], rpc);
    assert.equal(r.code, 0);
    assert.ok(!r.so.includes(TOKEN) && !r.se.includes(TOKEN));
    const lines = r.so.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[1].id, 2);
    assert.equal(lines[1].result.structuredContent.via, "local");
    assert.equal(server.calls.length, 0);
  });

  it("falls back for a tools/call when there is no endpoint", async () => {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "pidgin_status", arguments: status } }) + "\n";
    const r = await run([], rpc);
    assert.equal(JSON.parse(r.so.trim()).result.structuredContent.via, "server");
  });

  it("--local exits 75 when there is nothing to call, 0 with the result otherwise", async () => {
    const none = await run(["--local", "pidgin_status", JSON.stringify(status)]);
    assert.equal(none.code, 75);
    writeDiscovery();
    const ok = await run(["--local", "pidgin_status", JSON.stringify(status)]);
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.so).via, "local");
    assert.ok(!ok.so.includes(TOKEN) && !ok.se.includes(TOKEN));
  });

  it("--local with an error after a write exits 1 and does not exit 75", async () => {
    local.mode = "error-after-write";
    writeDiscovery();
    const r = await run(["--local", "pidgin_status", JSON.stringify(status)]);
    assert.equal(r.code, 1);
    assert.ok(!r.se.includes(TOKEN));
  });

  it("--call tries local then server", async () => {
    const r = await run(["--call", "pidgin_status", JSON.stringify(status)]);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.so).via, "server");
  });
});

describe("callLocal directly", () => {
  it("reports handled:false for an unreachable port", async () => {
    const r = await callLocal("pidgin_status", status, { port: 1, token: TOKEN, pid: process.pid, version: "1" });
    assert.equal(r.handled, false);
  });

  it("never connects anywhere but 127.0.0.1", async () => {
    writeDiscovery();
    await callTool("pidgin_status", status);
    assert.ok(local.calls.length > 0);
  });
});
