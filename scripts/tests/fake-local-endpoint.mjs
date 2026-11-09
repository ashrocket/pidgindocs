// Test double for the local agent endpoint contract (docs/local-endpoint.md):
// a loopback MCP server on 127.0.0.1. Host apps implement the real thing; the
// contract tests and the client tests both use this one double.
import crypto from "node:crypto";
import http from "node:http";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

// The tools the contract names. A test checks this list against the doc.
export const TOOLS = [
  "pidgin_draft_put",
  "pidgin_draft_finish",
  "pidgin_status",
  "pidgin_publish_document",
  "pidgin_make_artifact",
  "pidgin_sync_now",
];

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const sameToken = (a, b) => crypto.timingSafeEqual(sha(a), sha(b)); // constant time

// behaviour (the contract's four, plus faults for the client's tests):
//   ok | unavailable | error-after-write | slow (answers after delayMs)
//   unavailable-status (200 with status:"unavailable") | hang | abort-after-headers
//   redirect (302 to redirectTo)
// discoveryPath: write a 0600 discovery file there, removed by close().
export async function startFake({ token = "tok-local", behaviour = "ok", discoveryPath = null, delayMs = 1500 } = {}) {
  const state = {
    requests: [], writes: [], acceptTokens: [token], behaviour, delayMs, redirectTo: "",
    port: 0, address: "127.0.0.1", discoveryPath, onUnauthorized: null,
  };
  state.calls = state.requests; // the client tests' name for the same list

  const server = http.createServer((req, res) => {
    const send = (status, body, headers = {}) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(text);
    };
    const record = (body) => state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? "", body });

    // 1. Host: exactly 127.0.0.1:<port> or localhost:<port> (DNS rebinding).
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${state.port}` && host !== `localhost:${state.port}`) { record(""); return send(403, { error: "forbidden host" }); }
    // 2. Any Origin header.
    if (req.headers.origin !== undefined) { record(""); return send(403, { error: "forbidden origin" }); }
    // 3. Bearer token, constant time.
    const auth = req.headers.authorization ?? "";
    if (!state.acceptTokens.some((t) => sameToken(auth, `Bearer ${t}`))) {
      record("");
      if (state.onUnauthorized) state.onUnauthorized(); // e.g. the host rotates its token file
      return send(401, { error: "unauthorized" });
    }
    if (req.method === "GET" && req.url === "/health") { record(""); return send(200, { status: "ok", version: 1 }); }
    if (req.method !== "POST" || req.url !== "/mcp") { record(""); return send(404, { error: "not found" }); }
    // 4. Content-Type: application/json only.
    if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) { record(""); return send(400, { error: "content type must be application/json" }); }

    // 5. Body cap.
    let size = 0;
    const chunks = [];
    let refused = false;
    req.on("data", (c) => {
      if (refused) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        refused = true;
        record("");
        send(413, { error: "body too large" }, { Connection: "close" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (refused) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      record(raw);
      // 6. Not ready or signed out.
      if (state.behaviour === "unavailable") return send(503, '{"status":"unavailable"}');
      let rpc;
      try { rpc = JSON.parse(raw); } catch { return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
      const tool = rpc.params?.name;
      const rpcError = (code, message, status = 200) => send(status, { jsonrpc: "2.0", id: rpc.id, error: { code, message } });
      const rpcResult = (structuredContent) => send(200, { jsonrpc: "2.0", id: rpc.id, result: { structuredContent } });
      if (rpc.method !== "tools/call" || !TOOLS.includes(tool)) return rpcError(-32601, "method not found");

      if (state.behaviour === "unavailable-status") return rpcResult({ status: "unavailable" });
      state.writes.push({ tool, args: rpc.params?.arguments });
      switch (state.behaviour) {
        case "hang": return; // accept the connection and the call, never answer
        case "error-after-write": return rpcError(-32000, "failed after write", 500);
        case "abort-after-headers":
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "500" });
          res.write("{");
          setTimeout(() => res.socket.destroy(), 20);
          return;
        case "redirect":
          res.writeHead(302, { Location: state.redirectTo }).end();
          return;
        case "slow":
          setTimeout(() => rpcResult({ ok: true, via: "local", tool }), state.delayMs);
          return;
        default:
          return rpcResult({ ok: true, via: "local", tool });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = server.address().port;

  if (discoveryPath) {
    mkdirSync(path.dirname(discoveryPath), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify({ port: state.port, token, pid: process.pid, version: 1 }), { mode: 0o600 });
    chmodSync(discoveryPath, 0o600);
  }
  state.close = () => new Promise((resolve) => {
    if (discoveryPath) rmSync(discoveryPath, { force: true });
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return state;
}

// A stand-in for the server API: records requests, answers 200.
export async function startFakeServer() {
  const state = { calls: [], port: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      state.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? "", body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, via: "server", data: { id: "srv-1" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = server.address().port;
  state.url = `http://127.0.0.1:${state.port}`;
  state.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return state;
}
