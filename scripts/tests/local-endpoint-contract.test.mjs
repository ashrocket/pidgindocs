import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_ARTIFACT_MAX_CHARS, startFake, startFakeServer, TOOLS } from "./fake-local-endpoint.mjs";
import { callServer } from "../pidgindocs-mcp-proxy.mjs";

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

  it("a body over 5 MB is 413, a status and not a reset", async () => {
    fake = await startFake({ token: TOKEN });
    const big = rpc("pidgin_status", { title: "x".repeat(5 * 1024 * 1024 + 10) });
    const r = await raw({ ...good(fake.port), body: big });
    assert.equal(r.status, 413);
    assert.equal(fake.writes.length, 0);
  });

  it("a body just under 5 MB is accepted", async () => {
    fake = await startFake({ token: TOKEN });
    const pad = "x".repeat(5 * 1024 * 1024 - 1000);
    const r = await raw({ ...good(fake.port), body: rpc("pidgin_status", { title: pad }) });
    assert.equal(r.status, 200);
  });

  it("checks run in order: Host before Origin before token", async () => {
    fake = await startFake({ token: TOKEN });
    const r = await raw({ port: fake.port, headers: { Host: "evil.example", Origin: "x", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
    const noToken = await raw({ port: fake.port, headers: { Host: `127.0.0.1:${fake.port}`, "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(noToken.status, 401);
  });

  it("the listener is bound to 127.0.0.1 only: the real bound address, and no other interface answers", async (t) => {
    fake = await startFake({ token: TOKEN });
    const bound = fake.server.address();
    assert.equal(bound.address, "127.0.0.1"); // fails for 0.0.0.0, :: or a LAN address
    assert.equal(bound.port, fake.port);
    const external = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!external) { t.skip("no non-loopback IPv4 interface on this machine"); return; }
    const outcome = await new Promise((resolve) => {
      const socket = net.connect({ host: external.address, port: fake.port });
      const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 1500);
      socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
      socket.on("error", (e) => { clearTimeout(timer); resolve(e.code); });
    });
    assert.equal(outcome, "ECONNREFUSED", `${external.address} must refuse`);
  });

  it("the bind check would catch a wildcard listener", async () => {
    const wildcard = http.createServer();
    await new Promise((r) => wildcard.listen(0, "0.0.0.0", r));
    try {
      assert.notEqual(wildcard.address().address, "127.0.0.1");
    } finally {
      await new Promise((r) => wildcard.close(r));
    }
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
  it("is written with mode 0600 in a 0700 directory, and removed on close", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pidgindocs-contract-"));
    const file = path.join(dir, "nested", "local-endpoint.json");
    try {
      fake = await startFake({ token: TOKEN, discoveryPath: file });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { port: fake.port, token: TOKEN, pid: process.pid, version: 1 });
      await fake.close();
      assert.equal(existsSync(file), false);
      fake = null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is created 0600 even under a permissive umask, with no chmod afterwards", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pidgindocs-contract-"));
    const file = path.join(dir, "d", "local-endpoint.json");
    const old = process.umask(0);
    try {
      fake = await startFake({ token: TOKEN, discoveryPath: file });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    } finally {
      process.umask(old);
      rmSync(dir, { recursive: true, force: true });
    }
    const source = readFileSync(path.join(here, "fake-local-endpoint.mjs"), "utf8");
    assert.ok(!/chmod/i.test(source.replace(/\/\/.*$/gm, "")), "the double must not chmod the discovery file");
    assert.match(source, /flag: "wx"/);
  });

  it("writes no file when no path is given", async () => {
    fake = await startFake({ token: TOKEN });
    assert.equal(fake.discoveryPath, null);
  });
});

describe("tool table", () => {
  const section = DOC.split("\n### Tool table")[1]?.split("\n## ")[0]?.split("\n### ")[0] ?? "";
  const rows = [...section.matchAll(/^\| `(pidgin_[a-z_]+)` \| (local-only|both) \|/gm)].map((m) => ({ tool: m[1], where: m[2] }));

  it("lists every tool exactly once, marked local-only or both", () => {
    assert.deepEqual(rows.map((r) => r.tool).sort(), [...TOOLS].sort());
  });

  it("pidgin_sync_now is local-only and pidgin_publish_document is both", () => {
    assert.equal(rows.find((r) => r.tool === "pidgin_sync_now")?.where, "local-only");
    assert.equal(rows.find((r) => r.tool === "pidgin_publish_document")?.where, "both");
  });

  it("callServer agrees with the table: local-only tools refuse with local_only, the rest reach the server", async () => {
    const server = await startFakeServer();
    const saved = { url: process.env.PIDGINDOCS_URL, key: process.env.PIDGINDOCS_API_KEY };
    process.env.PIDGINDOCS_URL = server.url;
    process.env.PIDGINDOCS_API_KEY = "key-for-the-table-test";
    try {
      for (const { tool, where } of rows) {
        const before = server.calls.length;
        const args = { key: "abcdefgh", title: "t", markdown: "# m", html: "<p>h</p>", favicon: "📄" };
        if (where === "local-only") {
          await assert.rejects(callServer(tool, args), /local_only/, tool);
          assert.equal(server.calls.length, before, `${tool} must not call the server`);
        } else {
          await callServer(tool, args);
          assert.equal(server.calls.length, before + 1, `${tool} must call the server once`);
        }
      }
    } finally {
      process.env.PIDGINDOCS_URL = saved.url; process.env.PIDGINDOCS_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.PIDGINDOCS_URL;
      if (saved.key === undefined) delete process.env.PIDGINDOCS_API_KEY;
      await server.close();
    }
  });
});

describe("rules the doc states for hosts", () => {
  it("states the discovery permissions, the sync rules and the character rule", () => {
    assert.match(DOC, /created with mode 0600 from the start/);
    assert.match(DOC, /directory of mode 0700/);
    assert.match(DOC, /never chmod/i);
    assert.match(DOC, /per-item results/i);
    assert.match(DOC, /at most 3 times/);
    assert.match(DOC, /parked with an error/);
    assert.match(DOC, /Unicode code points/);
    assert.doesNotMatch(DOC, /enhance/i);
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

describe("pidgin_make_artifact length routing", () => {
  const make = (port, markdown, extra = {}) => raw({ ...good(port), body: rpc("pidgin_make_artifact", { title: "t", markdown, ...extra }) });

  it("the cutoff is the named constant, 12,000, marked as a proposal", () => {
    assert.equal(DEVICE_ARTIFACT_MAX_CHARS, 12000);
  });

  it("12,000 characters is made on the device and queued", async () => {
    fake = await startFake({ token: TOKEN });
    const r = await make(fake.port, "a".repeat(12000));
    const out = r.json.result.structuredContent;
    assert.equal(out.status, "ok");
    assert.equal(out.generated_on, "device");
    assert.equal(typeof out.html, "string");
    assert.equal(fake.writes.length, 1);
  });

  it("12,001 characters is unavailable with reason long, and nothing is queued", async () => {
    fake = await startFake({ token: TOKEN });
    const r = await make(fake.port, "a".repeat(12001));
    assert.deepEqual(r.json.result.structuredContent, { status: "unavailable", reason: "long" });
    assert.equal(r.status, 200); // never a transport or JSON-RPC error
    assert.equal(r.json.error, undefined);
    assert.equal(fake.writes.length, 0);
  });

  it("counts Unicode code points: astral characters around the cutoff", async () => {
    fake = await startFake({ token: TOKEN });
    const emoji = "😀"; // one code point, two UTF-16 units, four UTF-8 bytes
    const atLimit = emoji.repeat(12000);
    assert.equal(atLimit.length, 24000);
    assert.equal([...atLimit].length, 12000);
    assert.equal((await make(fake.port, atLimit)).json.result.structuredContent.status, "ok");
    const over = await make(fake.port, emoji.repeat(12001));
    assert.deepEqual(over.json.result.structuredContent, { status: "unavailable", reason: "long" });
    // A flag emoji is two code points, a family emoji is seven: code points, not grapheme clusters.
    const flags = "🇸🇪".repeat(6000);
    assert.equal([...flags].length, 12000);
    assert.equal((await make(fake.port, flags)).json.result.structuredContent.status, "ok");
    assert.equal((await make(fake.port, flags + "a")).json.result.structuredContent.reason, "long");
    // One BMP character short of the limit with astral characters mixed in.
    const mixed = "a".repeat(11998) + emoji;
    assert.equal([...mixed].length, 11999);
    assert.equal((await make(fake.port, mixed)).json.result.structuredContent.status, "ok");
  });

  it("counts characters, not bytes", async () => {
    fake = await startFake({ token: TOKEN });
    const r = await make(fake.port, "é".repeat(12000));
    assert.equal(r.json.result.structuredContent.status, "ok");
  });

  for (const reason of ["model", "quality", "timeout"]) {
    it(`any other failure answers unavailable with reason ${reason}, never an error`, async () => {
      fake = await startFake({ token: TOKEN, behaviour: `artifact-${reason}` });
      const r = await make(fake.port, "short");
      assert.equal(r.status, 200);
      assert.equal(r.json.error, undefined);
      assert.deepEqual(r.json.result.structuredContent, { status: "unavailable", reason });
      assert.equal(fake.writes.length, 0);
    });
  }

  it("the doc states the same threshold as the double, as a proposal", () => {
    const m = /over ([\d,]+) characters/.exec(DOC);
    assert.ok(m, "the doc states a character threshold");
    assert.equal(Number(m[1].replace(/,/g, "")), DEVICE_ARTIFACT_MAX_CHARS);
    const rule = DOC.split("\n").find((l) => /over [\d,]+ characters/.test(l)) ?? "";
    assert.match(DOC.slice(DOC.indexOf(rule) - 400, DOC.indexOf(rule) + 600), /proposal/i);
  });

  it("the doc lists the reasons the double returns", () => {
    for (const reason of ["long", "model", "quality", "timeout"]) assert.match(DOC, new RegExp(`"${reason}"`));
  });
});
