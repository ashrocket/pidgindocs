// Test double for a local agent endpoint: a loopback MCP server on 127.0.0.1.
// Host apps implement the real thing; tests use this to drive the client.
import http from "node:http";

// mode: ok | unavailable-503 | unavailable-status | error-after-write | hang
export async function startFakeLocal({ token = "tok-local", mode = "ok" } = {}) {
  const state = { calls: [], writes: [], acceptTokens: [token], mode, port: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      state.calls.push({ url: req.url, auth, body: raw });
      if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(404).end(); return; }
      if (!state.acceptTokens.some((t) => auth === `Bearer ${t}`)) {
        if (state.onUnauthorized) state.onUnauthorized(); // e.g. the host rotates its token file
        res.writeHead(401).end();
        return;
      }
      if (state.mode === "hang") return; // accept the connection, never answer
      const rpc = JSON.parse(raw);
      const tool = rpc.params?.name;
      const reply = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      };
      if (state.mode === "unavailable-503") return reply(503, { status: "unavailable" });
      if (state.mode === "unavailable-status") {
        return reply(200, { jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { status: "unavailable" } } });
      }
      state.writes.push({ tool, args: rpc.params?.arguments });
      if (state.mode === "error-after-write") {
        return reply(500, { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "failed after write" } });
      }
      reply(200, { jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { ok: true, via: "local", tool } } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = server.address().port;
  state.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
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
  state.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  return state;
}
