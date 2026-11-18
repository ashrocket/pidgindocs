#!/usr/bin/env bash
# Smoke check for a running PidginCore Worker (npm run dev).
# Usage: PIDGIN_URL=http://127.0.0.1:8787 PIDGIN_API_KEY=... scripts/smoke-core.sh
set -euo pipefail
: "${PIDGIN_URL:?set PIDGIN_URL}" "${PIDGIN_API_KEY:?set PIDGIN_API_KEY}"
auth=(-H "Authorization: Bearer $PIDGIN_API_KEY")
tag="smoke-$(date +%s)"

code=$(curl -s -o /dev/null -w '%{http_code}' "$PIDGIN_URL/health")
echo "GET /health -> $code"; [ "$code" = 200 ]

code=$(curl -s -o /dev/null -w '%{http_code}' "$PIDGIN_URL/setup")
echo "GET /setup (signed out) -> $code"; [ "$code" = 200 ]

curl -sf "${auth[@]}" -H 'Content-Type: application/json' -X POST "$PIDGIN_URL/api/messages" \
  -d "{\"type\":\"message\",\"title\":\"$tag\",\"body\":\"core smoke check\",\"instance\":{\"model\":\"smoke\",\"session_id\":\"$tag\",\"project\":\"smoke\",\"source\":\"smoke-core.sh\"}}" \
  | grep -q '"ok":true' && echo "POST /api/messages -> ok"

curl -sf "${auth[@]}" "$PIDGIN_URL/api/messages" | grep -q "$tag" && echo "GET /api/messages -> contains $tag"

mcp() { curl -sf "${auth[@]}" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -X POST "$PIDGIN_URL/mcp" -d "$1"; }
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | grep -q '"result"' && echo "MCP initialize -> ok"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -q '"tools"' && echo "MCP tools/list -> ok"
echo "smoke ok"
