# Local agent endpoint

A contract for a loopback agent endpoint run by a desktop host app. Any host app can implement it. This repository does not contain a host app: it ships the contract, a test double (`scripts/tests/fake-local-endpoint.mjs`) and a client that uses the endpoint when it is there (`scripts/pidgindocs-mcp-proxy.mjs`).

The point is that an agent can save a draft, post a status or hand over a document to something on the same machine first, and fall back to the server only when nothing local is ready.

## Listener

- Bind `127.0.0.1` only, on an ephemeral port. Never bind `0.0.0.0`, `::` or a LAN address.
- `POST /mcp`: one JSON-RPC 2.0 request per call, a JSON reply, no server-sent events.
- `GET /health`: no request body. Answers `{"status":"ok","version":1}`.

## Authentication and request checks

Check in this order and stop at the first refusal.

1. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. Anything else, including `127.0.0.1.evil.example`, is 403. This stops DNS rebinding.
2. Any `Origin` header is 403. Agents and shell clients do not send one; a browser page does.
3. `Authorization: Bearer <token>`. The token is 32 random bytes in hex, new at each launch, compared in constant time. Missing or wrong is 401.
4. `POST` needs `Content-Type: application/json`. Anything else is 400.
5. The body is at most 5 MB. Larger is 413.
6. A host that is not ready, or whose user is signed out, answers 503 with exactly `{"status":"unavailable"}`.

## Discovery file

`local-endpoint.json`, a regular file (not a symlink) owned by the user. The file is created with mode 0600 from the start: the host opens it with that mode and never chmods it afterwards, so there is no moment when the token is readable by anyone else. It lives in a directory of mode 0700, which the host creates the same way:

```json
{ "port": 49152, "token": "<64 hex characters>", "pid": 4242, "version": 1 }
```

An optional `host` field must be exactly `127.0.0.1`. The host app removes the file on quit. A client ignores the file when it is missing, unreadable, not mode 0600, in a directory with any group or other bit set, not owned by the current user, a symlink, names a port outside 1024-65535, or names a `pid` that is not running. The default location is `~/.pidgindocs/local-endpoint.json`; a host that keeps it elsewhere is named through `PIDGINDOCS_LOCAL_ENDPOINT_FILE` or `PIDGINDOCS_LOCAL_ENDPOINT_PATHS` (colon separated).

## Tools

Named and shaped like the server's tools, called with JSON-RPC `tools/call`:

- `pidgin_draft_put`
- `pidgin_draft_finish`
- `pidgin_status`
- `pidgin_publish_document`
- `pidgin_make_artifact`
- `pidgin_sync_now`

### Tool table

Where each tool can run. `both` means the client uses the local endpoint first and has a server route to fall back to; `local-only` means the tool exists only on the local endpoint and the client refuses with `local_only` rather than calling the server.

| Tool | Where | Server fallback |
| --- | --- | --- |
| `pidgin_draft_put` | both | `PUT /api/drafts/:key` |
| `pidgin_draft_finish` | both | `POST /api/drafts/:key/commit` |
| `pidgin_status` | both | `POST /api/messages` as a status |
| `pidgin_publish_document` | both | `POST /api/messages` as a document |
| `pidgin_make_artifact` | both | `POST /api/artifacts` with `markdown` |
| `pidgin_sync_now` | local-only | none: refuses with `local_only` |

An unhandled tool is a JSON-RPC error with code `-32601`. A tool the host cannot serve right now answers `{"status":"unavailable"}` in its result, and the client uses the server for that call.

### pidgin_make_artifact

`pidgin_make_artifact { markdown, title }` makes a page from a document.

1. A host that can make the page on the device answers `{ "status": "ok", "html": "...", "generated_on": "device" }` and queues the page as an `artifact` item for the next batch.
2. Length routing, a proposal for the owner to confirm or change: a document over 12,000 characters is not composed on the device. The host answers `{ "status": "unavailable", "reason": "long" }`. "Characters" means Unicode code points: an emoji outside the Basic Multilingual Plane counts once, however many UTF-16 units or UTF-8 bytes it takes, and a flag emoji (two regional indicators) counts twice. The figure is one named constant, `DEVICE_ARTIFACT_MAX_CHARS`, in the test double; this line and the constant must agree.
3. Any other failure (model missing, poor result, timeout) answers `{ "status": "unavailable", "reason": "model" }`, `"quality"` or `"timeout"`. The host never returns an error for these.
4. On any `unavailable`, the client sends the call to the server as `POST /api/artifacts` with `markdown` and `"ai": true`. This repository has no server-side AI page generation, so the server provides it through a hook: `artifactAI()` in `server/legacy/artifact-ai.ts`, default none, registered by a deployment that has one with `setArtifactAI`, in the same style as the usage hooks in `meter.ts`. With a hook the server publishes the page it composed and answers `ai: "generated"`. With no hook it publishes the markdown as a plain artifact and answers `ai: "none"`. If the hook returns nothing or throws, it publishes the plain artifact and answers `ai: "failed"`. The server runs every input check (size, label, version, team) before the hook and meters the call with the usage hooks, reporting `X-Pidgin-Units` such as `artifact=1;artifact_ai=1`. A request without `"ai": true` never calls the hook and has no `ai` field. Who pays for server AI is the deployment's decision, not the client's.

## Behaviour a host should have

- Finalize a draft after 90 seconds idle, on `pidgin_draft_finish`, or at quit.
- Fold `pidgin_status` calls that share a session id into one item.
- Sync queued items with `POST /api/batch`, at most 25 per call. Local ids look like `loc_<uuid>` and map to server ids.
  - A call can succeed in part. The reply carries per-item results; the host drops an item from its queue the moment its own result is ok, and keeps only the items that failed.
  - A poison item (one the server keeps rejecting) is retried at most 3 times and then parked with an error the person can see. It no longer blocks the items behind it.
  - The `Idempotency-Key` belongs to the items in the request: derive it from the ids of exactly those items (for example a hash of the sorted ids), never from the whole queue. Because finished items have left the queue, a queue that changes between attempts never re-sends an item that is already done, and a retry of the same items reuses the same key and is not run twice.
  - On a 429 keep the whole queue and try later.
- Never log the token or request bodies.

## Client rules

The client falls back to the server when it never reached the endpoint (no discovery file, connection refused, no TCP connect within 700 ms), on a 401 that survives one re-read of the file, on a 503 `unavailable`, and on a result with `status: "unavailable"`. Once the socket connected, it never falls back: a slow, failed, aborted or redirected response is an error to the caller, because a retry could duplicate a write. It never follows a redirect.
