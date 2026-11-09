#!/usr/bin/env node
// pidgindocs-mcp-proxy: one client for agents. Try the local endpoint, then
// fall back to the server, per call. Dependency-free, Node 22.
//
//   node pidgindocs-mcp-proxy.mjs                         stdio MCP server
//   node pidgindocs-mcp-proxy.mjs --local <tool> <json>   local only; exit 75 = fall back
//   node pidgindocs-mcp-proxy.mjs --call  <tool> <json>   local, then server
//
// The local token goes only to http://127.0.0.1 and is never printed or logged.
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_FALL_BACK = 75;
const CONNECT_TIMEOUT_MS = 700;
const TOTAL_TIMEOUT_MS = 60_000;
const LOOPBACK = "127.0.0.1";

const totalTimeoutMs = () => Number(process.env.PIDGINDOCS_LOCAL_TOTAL_TIMEOUT_MS) || TOTAL_TIMEOUT_MS;

function defaultPaths() {
  const paths = [];
  if (process.env.PIDGINDOCS_LOCAL_ENDPOINT_FILE) paths.push(process.env.PIDGINDOCS_LOCAL_ENDPOINT_FILE);
  for (const p of (process.env.PIDGINDOCS_LOCAL_ENDPOINT_PATHS ?? "").split(":")) if (p) paths.push(p);
  paths.push(path.join(homedir(), ".pidgindocs", "local-endpoint.json"));
  return paths;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === "EPERM"; }
}

// Opened without following symlinks and checked on the open handle, so the
// file cannot be swapped between the check and the read.
async function readOne(file, uid) {
  let fh;
  try {
    fh = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await fh.stat();
    if (!info.isFile()) return null;
    if (uid !== undefined && info.uid !== uid) return null; // owned by this user only
    if ((info.mode & 0o777) !== 0o600) return null; // no group or other bits
    const d = JSON.parse(await fh.readFile("utf8"));
    if (d.host !== undefined && d.host !== LOOPBACK) return null; // loopback only, exactly
    if (!Number.isInteger(d.port) || d.port < 1024 || d.port > 65535) return null;
    if (typeof d.token !== "string" || !d.token) return null;
    if (!pidAlive(d.pid)) return null;
    return { port: d.port, token: d.token, pid: d.pid, version: d.version };
  } catch {
    return null; // missing, a symlink (ELOOP), unreadable or malformed
  } finally {
    await fh?.close().catch(() => {});
  }
}

// First valid file wins. Missing, unreadable, not mode 0600, a port outside
// 1024-65535 or a dead pid means that path offers no local endpoint.
export async function readDiscovery(paths = defaultPaths(), { uid = process.getuid?.() } = {}) {
  for (const file of paths) {
    const d = await readOne(file, uid);
    if (d) return d;
  }
  return null;
}

// One POST to 127.0.0.1. `reached` is false only when the socket never
// connected (refused, or no TCP connect within 700 ms): nothing was sent, so
// the caller may use the server. Once the socket connects the request goes
// out, and from then on every outcome is final: a slow, failed, aborted or
// redirected response is an error to the caller and is never resent.
function postOnce(tool, args, d) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      resolve(value);
    };
    const req = http.request({
      host: LOOPBACK, port: d.port, path: "/mcp", method: "POST", agent: false,
      headers: {
        "Content-Type": "application/json", Accept: "application/json",
        "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${d.token}`,
      },
    });
    const connectTimer = setTimeout(() => {
      if (!connected) { req.destroy(); finish({ reached: false }); }
    }, CONNECT_TIMEOUT_MS);
    const totalTimer = setTimeout(() => {
      req.destroy();
      finish(connected ? { reached: true, error: "local_timeout" } : { reached: false });
    }, totalTimeoutMs());
    req.on("socket", (socket) => {
      const onConnect = () => { connected = true; clearTimeout(connectTimer); };
      if (socket.connecting) socket.once("connect", onConnect); else onConnect();
    });
    req.on("error", () => finish(connected ? { reached: true, error: "local_error" } : { reached: false }));
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", () => finish({ reached: true, error: "local_error" }));
      res.on("aborted", () => finish({ reached: true, error: "local_error" }));
      res.on("close", () => {
        if (!res.complete) finish({ reached: true, error: "local_error" });
      });
      res.on("end", () => finish({ reached: true, status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.end(payload);
  });
}

function unavailableBody(text) {
  try {
    const j = JSON.parse(text);
    return j?.status === "unavailable" || j?.result?.structuredContent?.status === "unavailable";
  } catch { return false; }
}

// { handled: false } means fall back. handled with an error means the local
// endpoint took the call; do not retry it elsewhere, a retry could duplicate.
export async function callLocal(tool, args, d) {
  let discovery = d;
  let attempt = await postOnce(tool, args, discovery);
  if (attempt.reached && !attempt.error && attempt.status === 401) {
    const fresh = await readDiscovery();
    if (fresh) {
      discovery = fresh;
      attempt = await postOnce(tool, args, discovery);
    }
  }
  if (!attempt.reached) return { handled: false };
  if (attempt.error) return { handled: true, error: attempt.error };
  if (attempt.status === 401) return { handled: false };
  if (attempt.status >= 300 && attempt.status < 400) return { handled: true, error: "local_error: redirect not followed" };
  if (attempt.status === 503 || unavailableBody(attempt.text)) return { handled: false };
  let body;
  try { body = JSON.parse(attempt.text); } catch { body = null; }
  if (attempt.status >= 200 && attempt.status < 300 && body && !body.error) {
    const result = body.result?.structuredContent ?? body.result ?? body;
    return { handled: true, result };
  }
  return { handled: true, error: body?.error?.message ?? `local_error: HTTP ${attempt.status}` };
}

function serverBase() {
  return (process.env.PIDGINDOCS_URL || "https://pidgindocs.example.workers.dev").replace(/\/+$/, "");
}

async function serverRequest(method, route, body) {
  const key = process.env.PIDGINDOCS_API_KEY;
  if (!key) throw new Error("PIDGINDOCS_API_KEY is not set");
  const res = await fetch(`${serverBase()}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`server returned HTTP ${res.status}: ${json?.error ?? text.slice(0, 200)}`);
  return json;
}

function sessionInstance(args) {
  return {
    model: process.env.PIDGINDOCS_MODEL || process.env.CLAUDE_MODEL || "codex",
    session_id: process.env.PIDGINDOCS_SESSION_ID || process.env.CLAUDE_SESSION_ID || "cli",
    project: args.project || "pidgin",
    source: process.env.PIDGINDOCS_SOURCE || (process.env.CLAUDE_SESSION_ID ? "claude-code" : "codex"),
  };
}

// The agent's own API key goes to the server; the local token never does.
export async function callServer(tool, args = {}) {
  switch (tool) {
    case "pidgin_draft_put": {
      const { key, ...body } = args;
      return serverRequest("PUT", `/api/drafts/${encodeURIComponent(key)}`, body);
    }
    case "pidgin_draft_finish":
      return serverRequest("POST", `/api/drafts/${encodeURIComponent(args.key)}/commit`);
    case "pidgin_status":
      return serverRequest("POST", "/api/messages", {
        type: "status",
        title: args.title,
        body: args.body,
        final: args.final,
        priority: args.priority,
        team_id: args.team_id,
        project_id: args.project_id,
        instance: sessionInstance(args),
      });
    case "pidgin_make_artifact":
      return serverRequest("POST", "/api/artifacts", {
        markdown: args.markdown,
        title: args.title,
        description: args.description,
        favicon: args.favicon,
        label: args.label,
        // Only when the caller asked; who pays for server AI is the server's call.
        ...(args.enhance ? { enhance: args.enhance } : {}),
        team_id: args.team_id,
        project_id: args.project_id,
        instance: sessionInstance(args),
      });
    default:
      throw new Error(`no server fallback for tool ${tool}`);
  }
}

export async function localOnly(tool, args) {
  const d = await readDiscovery();
  if (!d) return { handled: false };
  return callLocal(tool, args, d);
}

export async function callTool(tool, args = {}) {
  const local = await localOnly(tool, args);
  if (local.handled) {
    if (local.error) throw new Error(local.error);
    return local.result;
  }
  return callServer(tool, args);
}

const TOOLS = [
  { name: "pidgin_draft_put", description: "Overwrite a draft.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "pidgin_draft_finish", description: "Commit a draft as one version.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "pidgin_status", description: "Post or update the living status item.", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, final: { type: "boolean" } }, required: ["title"] } },
  { name: "pidgin_make_artifact", description: "Publish an artifact from markdown.", inputSchema: { type: "object", properties: { title: { type: "string" }, markdown: { type: "string" }, favicon: { type: "string" } }, required: ["markdown"] } },
];

async function handleRpc(msg) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pidgindocs-mcp-proxy", version: "1" } });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      try {
        const result = await callTool(msg.params?.name, msg.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (err) {
        return reply({ content: [{ type: "text", text: err.message }], isError: true });
      }
    }
    default:
      if (msg.id === undefined) return null; // a notification
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
  }
}

async function stdioServer() {
  let buffer = "";
  const pending = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      pending.push(handleRpc(msg).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + "\n"); }));
    }
  }
  await Promise.all(pending);
}

async function main(argv) {
  const [mode, tool, json] = argv;
  if (mode === "--local" || mode === "--call") {
    let args = {};
    try { args = json ? JSON.parse(json) : {}; } catch { process.stderr.write("arguments must be JSON\n"); return 2; }
    try {
      if (mode === "--local") {
        const r = await localOnly(tool, args);
        if (!r.handled) return EXIT_FALL_BACK;
        if (r.error) { process.stderr.write(`${r.error}\n`); return 1; }
        process.stdout.write(JSON.stringify(r.result) + "\n");
        return 0;
      }
      process.stdout.write(JSON.stringify(await callTool(tool, args)) + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
  }
  await stdioServer();
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
