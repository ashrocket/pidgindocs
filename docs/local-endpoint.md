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

`local-endpoint.json`, mode 0600, owned by the user, a regular file (not a symlink):

```json
{ "port": 49152, "token": "<64 hex characters>", "pid": 4242, "version": 1 }
```

An optional `host` field must be exactly `127.0.0.1`. The host app removes the file on quit. A client ignores the file when it is missing, unreadable, not mode 0600, not owned by the current user, a symlink, names a port outside 1024-65535, or names a `pid` that is not running. The default location is `~/.pidgindocs/local-endpoint.json`; a host that keeps it elsewhere is named through `PIDGINDOCS_LOCAL_ENDPOINT_FILE` or `PIDGINDOCS_LOCAL_ENDPOINT_PATHS` (colon separated).

## Tools

Named and shaped like the server's tools, called with JSON-RPC `tools/call`:

- `pidgin_draft_put`
- `pidgin_draft_finish`
- `pidgin_status`
- `pidgin_publish_document`
- `pidgin_make_artifact`
- `pidgin_sync_now`

An unhandled tool is a JSON-RPC error with code `-32601`. A tool the host cannot serve right now answers `{"status":"unavailable"}` in its result, and the client uses the server for that call.

## Behaviour a host should have

- Finalize a draft after 90 seconds idle, on `pidgin_draft_finish`, or at quit.
- Fold `pidgin_status` calls that share a session id into one item.
- Sync queued items with `POST /api/batch`: at most 25 per call, an `Idempotency-Key` derived from the item ids, keeping an item until its result is ok. On a 429 keep the queue. Local ids look like `loc_<uuid>` and map to server ids.
- Never log the token or request bodies.

## Client rules

The client falls back to the server when it never reached the endpoint (no discovery file, connection refused, no TCP connect within 700 ms), on a 401 that survives one re-read of the file, on a 503 `unavailable`, and on a result with `status: "unavailable"`. Once the socket connected, it never falls back: a slow, failed, aborted or redirected response is an error to the caller, because a retry could duplicate a write. It never follows a redirect.
