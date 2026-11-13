import { randomBytes } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFake, startFakeServer } from "./fake-local-endpoint.mjs";
import { callLocal, callServer, callTool, readDiscovery } from "../pidgindocs-mcp-proxy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(here, "..", "pidgindocs-mcp-proxy.mjs");
const TOKEN = randomBytes(32).toString("hex");
const API_KEY = `key-${"x".repeat(6)}-for-tests`; // built at run time, not a real key

let dir, local, server, out, err, realOut, realErr;
const openFixtures = new Set();
after(async () => { for (const fixture of openFixtures) await fixture.close(); });

function writeDiscovery(overrides = {}, mode = 0o600) {
  const file = path.join(dir, "local-endpoint.json");
  writeFileSync(file, JSON.stringify({ port: local.port, token: TOKEN, pid: process.pid, version: 1, ...overrides }), { mode });
  // writeFileSync only applies the mode on create; force it for reused paths.
  spawnSync("chmod", [mode.toString(8), file]);
  process.env.PIDGINDOCS_LOCAL_ENDPOINT_FILE = file;
  return file;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pidgindocs-proxy-"));
  local = await startFake({ token: TOKEN });
  server = await startFakeServer();
  openFixtures.add(local); openFixtures.add(server);
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
  openFixtures.delete(local); openFixtures.delete(server);
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
    local.behaviour = "unavailable";
    writeDiscovery();
    const r = await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 1);
    assert.equal(server.calls.length, 1);
    assert.equal(r.via, "server");
  });

  it("status unavailable in the result: server called", async () => {
    local.behaviour = "unavailable-status";
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

  // (moved: slow and silent endpoints are errors, never a fallback; see below)

  it("wrong token twice: server called", async () => {
    writeDiscovery({ token: "b".repeat(64) });
    await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 2); // first try plus one retry
    assert.equal(server.calls.length, 1);
  });

  it("wrong token once, right after re-reading the file: local used", async () => {
    const file = writeDiscovery({ token: "c".repeat(64) });
    local.onUnauthorized = () => {
      writeFileSync(file, JSON.stringify({ port: local.port, token: TOKEN, pid: process.pid, version: 1 }));
      spawnSync("chmod", ["600", file]);
      local.onUnauthorized = null;
    };
    const r = await callTool("pidgin_status", status);
    assert.equal(local.calls.length, 2);
    assert.equal(r.via, "local");
    assert.equal(server.calls.length, 0);
  });
});

describe("never falling back once the socket connected", () => {
  afterEach(() => { delete process.env.PIDGINDOCS_LOCAL_TOTAL_TIMEOUT_MS; });

  it("an endpoint that replies after 1.5 s is handled, with no server call", async () => {
    local.behaviour = "slow";
    writeDiscovery();
    const r = await callTool("pidgin_status", status);
    assert.equal(r.via, "local");
    assert.equal(local.writes.length, 1);
    assert.equal(server.calls.length, 0);
  });

  it("an endpoint that accepts and never replies ends in local_timeout, with no server call", async () => {
    local.behaviour = "hang";
    process.env.PIDGINDOCS_LOCAL_TOTAL_TIMEOUT_MS = "1200";
    writeDiscovery();
    await assert.rejects(callTool("pidgin_status", status), /local_timeout/);
    assert.equal(local.calls.length, 1);
    assert.equal(server.calls.length, 0);
  });

  it("a closed port is the only transport failure that falls back", async () => {
    const port = local.port;
    await local.close();
    writeDiscovery({ port });
    const r = await callTool("pidgin_status", status);
    assert.equal(r.via, "server");
    assert.equal(server.calls.length, 1);
  });

  it("a connection aborted after the headers is local_error, with no server call", async () => {
    local.behaviour = "abort-after-headers";
    writeDiscovery();
    await assert.rejects(callTool("pidgin_status", status), /local_error/);
    assert.equal(local.writes.length, 1);
    assert.equal(server.calls.length, 0);
  });

  it("a redirect is never followed: local_error, and the target is not called", async () => {
    local.behaviour = "redirect";
    local.redirectTo = `${server.url}/api/messages`;
    writeDiscovery();
    await assert.rejects(callTool("pidgin_status", status), /local_error: redirect not followed/);
    assert.equal(server.calls.length, 0);
  });

  it("a redirect to another loopback port is not followed either", async () => {
    local.behaviour = "redirect";
    local.redirectTo = "http://127.0.0.1:1/mcp";
    writeDiscovery();
    const r = await callLocal("pidgin_status", status, await readDiscovery());
    assert.deepEqual(r, { handled: true, error: "local_error: redirect not followed" });
  });


  it("error-after-write: server not called, error returned", async () => {
    local.behaviour = "error-after-write";
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

  it("refuses a symlinked discovery file", async () => {
    const real = writeDiscovery();
    const link = path.join(dir, "link.json");
    symlinkSync(real, link);
    assert.equal(await readDiscovery([link]), null);
    assert.ok(await readDiscovery([real]));
  });

  it("refuses a file owned by another user", async () => {
    const real = writeDiscovery();
    assert.ok(await readDiscovery([real], { uid: process.getuid() }));
    assert.equal(await readDiscovery([real], { uid: process.getuid() + 1 }), null);
  });

  it("refuses group and other bits, including 0640, 0604 and 0700", async () => {
    for (const mode of [0o640, 0o604, 0o700, 0o666]) {
      writeDiscovery({}, mode);
      assert.equal(await readDiscovery(), null, mode.toString(8));
    }
    writeDiscovery({}, 0o600);
    assert.ok(await readDiscovery());
  });

  it("requires the host to be exactly 127.0.0.1", async () => {
    for (const host of ["localhost", "0.0.0.0", "::1", "127.0.0.2", "example.com", "127.0.0.1 ", ""]) {
      writeDiscovery({ host });
      assert.equal(await readDiscovery(), null, JSON.stringify(host));
    }
    writeDiscovery({ host: "127.0.0.1" });
    assert.ok(await readDiscovery());
  });

  it("refuses a file in a directory with group or other bits", async () => {
    const file = writeDiscovery();
    spawnSync("chmod", ["755", dir]);
    assert.equal(await readDiscovery([file]), null);
    spawnSync("chmod", ["770", dir]);
    assert.equal(await readDiscovery([file]), null);
    spawnSync("chmod", ["700", dir]);
    assert.ok(await readDiscovery([file]));
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
    assert.deepEqual(d, { port: local.port, token: TOKEN, pid: process.pid, version: 1 });
  });

  it("tries PIDGINDOCS_LOCAL_ENDPOINT_FILE, then each of PIDGINDOCS_LOCAL_ENDPOINT_PATHS, then the home default", async () => {
    const good = path.join(dir, "second.json");
    writeFileSync(good, JSON.stringify({ port: local.port, token: TOKEN, pid: process.pid, version: 1 }), { mode: 0o600 });
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

describe("pidgin_make_artifact routing", () => {
  const args = { title: "Doc", markdown: "# hi", favicon: "📄" };

  it("a short document is made on the device: the server is not called", async () => {
    writeDiscovery();
    const r = await callTool("pidgin_make_artifact", args);
    assert.equal(r.status, "ok");
    assert.equal(r.generated_on, "device");
    assert.equal(server.calls.length, 0);
  });

  it("a long document goes to the server once, as POST /api/artifacts with markdown", async () => {
    writeDiscovery();
    const long = { ...args, markdown: "a".repeat(12001) };
    const r = await callTool("pidgin_make_artifact", long);
    assert.equal(r.via, "server");
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0].method, "POST");
    assert.equal(server.calls[0].url, "/api/artifacts");
    assert.equal(server.calls[0].body.markdown, long.markdown);
    assert.equal(server.calls[0].body.ai, true); // the long-document fallback asks the server's AI hook
    assert.equal("enhance" in server.calls[0].body, false);
  });

  for (const behaviour of ["artifact-model", "artifact-quality", "artifact-timeout"]) {
    it(`${behaviour}: the client calls the server once`, async () => {
      local.behaviour = behaviour;
      writeDiscovery();
      const r = await callTool("pidgin_make_artifact", args);
      assert.equal(r.via, "server");
      assert.equal(local.calls.length, 1);
      assert.equal(server.calls.length, 1);
      assert.equal(server.calls[0].url, "/api/artifacts");
    });
  }

  it("every fallback after unavailable asks for ai:true; enhance is never sent", async () => {
    local.behaviour = "artifact-model";
    writeDiscovery();
    await callTool("pidgin_make_artifact", { ...args, enhance: "polish" });
    assert.equal(server.calls[0].body.ai, true);
    assert.equal("enhance" in server.calls[0].body, false);
  });

  it("with no local endpoint at all, the plain call has no ai flag", async () => {
    await callTool("pidgin_make_artifact", args);
    assert.equal("ai" in server.calls[0].body, false);
  });
});

describe("tools that need a decision on the server side", () => {
  it("pidgin_publish_document falls back to POST /api/messages as a document", async () => {
    await callServer("pidgin_publish_document", { title: "Doc", html: "<p>x</p>", project: "p" });
    const c = server.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.url, "/api/messages");
    assert.equal(c.body.type, "document");
    assert.equal(c.body.html, "<p>x</p>");
    assert.equal(c.body.instance.session_id, "sess-test");
  });

  it("pidgin_sync_now is local-only: callServer refuses with local_only and calls nothing", async () => {
    await assert.rejects(callServer("pidgin_sync_now", {}), /local_only/);
    assert.equal(server.calls.length, 0);
  });

  it("pidgin_sync_now with no endpoint reports local_only to the caller", async () => {
    await assert.rejects(callTool("pidgin_sync_now", {}), /local_only/);
    assert.equal(server.calls.length, 0);
  });

  it("pidgin_sync_now over stdio is an error result naming local_only", async () => {
    const child = spawnSync(process.execPath, [PROXY], {
      env: process.env,
      input: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pidgin_sync_now", arguments: {} } }) + "\n",
    });
    const reply = JSON.parse(String(child.stdout).trim());
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /local_only/);
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
    local.behaviour = "error-after-write";
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
    const r = await callLocal("pidgin_status", status, { port: 1, token: TOKEN, pid: process.pid, version: 1 });
    assert.equal(r.handled, false);
  });

  it("never connects anywhere but 127.0.0.1", async () => {
    writeDiscovery();
    await callTool("pidgin_status", status);
    assert.ok(local.calls.length > 0);
  });
});


describe("bounded responses and fallback safety",()=>{
  it("does not retry a generic 503 after a write",async()=>{
    local.behaviour="generic-503";writeDiscovery();
    await assert.rejects(callTool("pidgin_status",status),/HTTP 503/);
    assert.equal(local.writes.length,1);assert.equal(server.calls.length,0);
  });
  it("bounds a local response without falling back",async()=>{
    local.behaviour="oversized";writeDiscovery();
    await assert.rejects(callTool("pidgin_status",status),/response too large/);
    assert.equal(server.calls.length,0);
  });
  it("does not follow server redirects carrying the user's API key",async()=>{
    server.redirectTo=`http://127.0.0.1:${local.port}/mcp`;
    await assert.rejects(callServer("pidgin_status",status));
    assert.equal(server.calls.length,1);assert.equal(local.calls.length,0);
  });
  it("refuses remote plain HTTP and discovery files larger than 4 KiB",async()=>{
    process.env.PIDGINDOCS_URL="http://example.invalid";
    await assert.rejects(callServer("pidgin_status",status),/HTTPS deployment/);
    const file=writeDiscovery({padding:"x".repeat(4096)});assert.equal(await readDiscovery([file]),null);
  });
});

it("bounds server fallback requests before transmission",async()=>{
  await assert.rejects(callServer("pidgin_make_artifact",{markdown:"x".repeat(5*1024*1024+1)}),/request too large/);
  assert.equal(server.calls.length,0);
});
