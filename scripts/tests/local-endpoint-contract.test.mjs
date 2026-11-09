import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFake, TOOLS } from "./fake-local-endpoint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOC = readFileSync(path.join(here, "..", "..", "docs", "local-endpoint.md"), "utf8");
const TOKEN = "t".repeat(64);

let fake;
afterEach(async () => { await fake?.close(); fake = null; });

// A raw request, so the test controls the Host header.
function raw({ port, method = "POST", url = "/mcp", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers, agent: false }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const rpc = (name, args = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const good = (port, extra = {}) => ({
  port,
  headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra },
});

describe("request checks", () => {
  it("accepts the right request", async () => {
    fake = await startFake({ token: TOKEN });
    const r = await raw({ ...good(fake.port), body: rpc("pidgin_status", { title: "t" }) });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.structuredContent.ok, true);
  });

  it("accepts Host localhost:<port>", async () => {
    fake = await startFake({ token: TOKEN });
    const g = good(fake.port, { Host: `localhost:${fake.port}` });
    assert.equal((await raw({ ...g, body: rpc("pidgin_status") })).status, 200);
  });

  it("no token and a wrong token are 401", async () => {
    fake = await startFake({ token: TOKEN });
    const noAuth = good(fake.port); delete noAuth.headers.Authorization;
    assert.equal((await raw({ ...noAuth, body: rpc("pidgin_status") })).status, 401);
    const wrong = good(fake.port, { Authorization: `Bearer ${"x".repeat(64)}` });
    assert.equal((await raw({ ...wrong, body: rpc("pidgin_status") })).status, 401);
    const shorter = good(fake.port, { Authorization: "Bearer x" });
    assert.equal((await raw({ ...shorter, body: rpc("pidgin_status") })).status, 401);
  });

  it("a foreign Host is 403, including a lookalike", async () => {
    fake = await startFake({ token: TOKEN });
    for (const host of ["evil.example", `127.0.0.1.evil.example:${fake.port}`, "127.0.0.1", `evil.example:${fake.port}`]) {
      const r = await raw({ ...good(fake.port, { Host: host }), body: rpc("pidgin_status") });
      assert.equal(r.status, 403, host);
    }
  });

  it("any Origin header is 403, even with the right token", async () => {
    fake = await startFake({ token: TOKEN });
    for (const origin of ["https://evil.example", "null", "http://127.0.0.1"]) {
      const r = await raw({ ...good(fake.port, { Origin: origin }), body: rpc("pidgin_status") });
      assert.equal(r.status, 403, origin);
    }
  });

  it("a non-JSON content type is 400", async () => {
    fake = await startFake({ token: TOKEN });
    const r = await raw({ ...good(fake.port, { "Content-Type": "text/plain" }), body: rpc("pidgin_status") });
    assert.equal(r.status, 400);
  });

  it("a body over 5 MB is 413", async () => {
    fake = await startFake({ token: TOKEN });
    const big = rpc("pidgin_status", { title: "x".repeat(5 * 1024 * 1024 + 10) });
    const r = await raw({ ...good(fake.port), body: big }).catch((e) => ({ status: e.code }));
    assert.ok(r.status === 413 || r.status === "ECONNRESET" || r.status === "EPIPE", String(r.status));
  });

  it("checks run in order: Host before Origin before token", async () => {
    fake = await startFake({ token: TOKEN });
    const r = await raw({ port: fake.port, headers: { Host: "evil.example", Origin: "x", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
    const noToken = await raw({ port: fake.port, headers: { Host: `127.0.0.1:${fake.port}`, "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(noToken.status, 401);
  });

  it("the listener is bound to 127.0.0.1 only", async () => {
    fake = await startFake({ token: TOKEN });
    assert.equal(fake.address, "127.0.0.1");
  });
});

describe("behaviours", () => {
  it("unavailable answers 503 with the exact body", async () => {
    fake = await startFake({ token: TOKEN, behaviour: "unavailable" });
    const r = await raw({ ...good(fake.port), body: rpc("pidgin_status") });
    assert.equal(r.status, 503);
    assert.equal(r.text, '{"status":"unavailable"}');
  });

  it("unavailable still demands the token", async () => {
    fake = await startFake({ token: TOKEN, behaviour: "unavailable" });
    const noAuth = good(fake.port); delete noAuth.headers.Authorization;
    assert.equal((await raw({ ...noAuth, body: rpc("pidgin_status") })).status, 401);
  });

  it("error-after-write records the write, then answers an error", async () => {
    fake = await startFake({ token: TOKEN, behaviour: "error-after-write" });
    const r = await raw({ ...good(fake.port), body: rpc("pidgin_draft_put", { key: "abcdefgh" }) });
    assert.equal(r.status, 500);
    assert.ok(r.json.error.message);
    assert.equal(fake.writes.length, 1);
  });

  it("slow answers after the delay", async () => {
    fake = await startFake({ token: TOKEN, behaviour: "slow", delayMs: 200 });
    const started = Date.now();
    const r = await raw({ ...good(fake.port), body: rpc("pidgin_status") });
    assert.equal(r.status, 200);
    assert.ok(Date.now() - started >= 190);
  });
});

describe("routes", () => {
  it("GET /health works without a body", async () => {
    fake = await startFake({ token: TOKEN });
    const g = good(fake.port); delete g.headers["Content-Type"];
    const r = await raw({ ...g, method: "GET", url: "/health" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: "ok", version: 1 });
  });

  it("GET /health needs the token and the Host check", async () => {
    fake = await startFake({ token: TOKEN });
    assert.equal((await raw({ port: fake.port, method: "GET", url: "/health", headers: { Host: `127.0.0.1:${fake.port}` } })).status, 401);
    assert.equal((await raw({ port: fake.port, method: "GET", url: "/health", headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}` } })).status, 403);
  });

  it("an unknown tool is JSON-RPC -32601", async () => {
    fake = await startFake({ token: TOKEN });
    const r = await raw({ ...good(fake.port), body: rpc("pidgin_not_a_tool") });
    assert.equal(r.status, 200);
    assert.equal(r.json.error.code, -32601);
  });

  it("an unknown route is 404", async () => {
    fake = await startFake({ token: TOKEN });
    assert.equal((await raw({ ...good(fake.port), url: "/nope", body: "{}" })).status, 404);
  });
});

describe("discovery file", () => {
  it("is written with mode 0600 and removed on close", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pidgindocs-contract-"));
    const file = path.join(dir, "local-endpoint.json");
    try {
      fake = await startFake({ token: TOKEN, discoveryPath: file });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { port: fake.port, token: TOKEN, pid: process.pid, version: 1 });
      await fake.close();
      assert.equal(existsSync(file), false);
      fake = null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes no file when no path is given", async () => {
    fake = await startFake({ token: TOKEN });
    assert.equal(fake.discoveryPath, null);
  });
});

describe("the doc and the double agree", () => {
  const section = DOC.split("\n## Tools")[1]?.split("\n## ")[0] ?? "";
  const documented = [...section.matchAll(/^- `(pidgin_[a-z_]+)`/gm)].map((m) => m[1]);

  it("the doc lists tools", () => {
    assert.ok(documented.length >= 6, documented.join(","));
  });

  it("the doc and the double name the same tools", () => {
    assert.deepEqual([...documented].sort(), [...TOOLS].sort());
  });

  it("the double handles every documented tool", async () => {
    fake = await startFake({ token: TOKEN });
    for (const name of documented) {
      const r = await raw({ ...good(fake.port), body: rpc(name, { markdown: "x" }) });
      assert.equal(r.status, 200, name);
      assert.equal(r.json.error, undefined, name);
    }
  });

  it("the doc states the loopback, 5 MB and unavailable rules the double enforces", () => {
    assert.match(DOC, /127\.0\.0\.1/);
    assert.match(DOC, /5 MB/);
    assert.match(DOC, /\{"status":"unavailable"\}/);
    assert.match(DOC, /-32601/);
  });
});
