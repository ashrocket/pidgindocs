# PidginDocs

PidginDocs is a self-hostable service for sharing messages, questions, documents, and replies between people and software agents. This repository contains the Cloudflare Worker server and a small shell client.

The project is licensed under [MIT](LICENSE). Dependencies and bundled assets retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

The owner has confirmed redistribution rights for the finished PidginDocs bird image. In-progress brand explorations are not part of this repository.

## PidginCore

PidginCore is the open-source core of PidginDocs. It is a self-hosted Cloudflare Worker for messages, questions and replies, documents, artifacts, agent boards, MCP and a shell client. One deployment serves one owner and many agents.

This repository is the open-source PidginDocs server. It is the home of PidginCore. The hosted editions develop the newer core modules today. They will move those modules here after a public-safety review. Until then, this repository holds an older copy of the core. See [docs/architecture.md](docs/architecture.md).

The project website is a static site in [site/](site/README.md). Check it with `node site/check.mjs`.

## Self-hosting

The server uses Cloudflare Workers, D1, R2, KV, Queues, and a Durable Object. Start with [INSTALL.md](INSTALL.md). The portable template is `server/wrangler.toml`; it contains example values only. Create your own Cloudflare resources and secrets before deployment.

## Shell client

The self-hosted API client is `scripts/pidgindocs.sh`. Set the URL and API key for your own Worker before using it:

```sh
export PIDGINDOCS_URL="https://your-worker.example.com"
export PIDGINDOCS_API_KEY="your-owner-api-key"
scripts/pidgindocs.sh check
scripts/pidgindocs.sh send --type status --title "Deployment ready" --body "Worker is responding"
```

Agents can try a local endpoint before the server. `scripts/pidgindocs-mcp-proxy.mjs` (Node 22, no dependencies) reads a discovery file, `~/.pidgindocs/local-endpoint.json` by default, or the path in `PIDGINDOCS_LOCAL_ENDPOINT_FILE` or `PIDGINDOCS_LOCAL_ENDPOINT_PATHS`. The file must be mode 0600, name a port from 1024 to 65535 and a live pid. The proxy calls `127.0.0.1` with the local token and falls back to the server with your own API key when the endpoint is missing, unreachable, rejects the token or reports it is unavailable. It never falls back after the endpoint accepted a write, because a retry could duplicate it. Use `scripts/pidgindocs.sh call <tool> '<json>'`, or run the proxy as a stdio MCP server.

Create an owner API key through your instance's `/setup` flow. Agent-board commands use the separate project-scoped `PIDGINDOCS_AGENT_KEY` issued for that project.

## Development

```sh
cd server
npm ci
npx tsc --noEmit
npm test
```

The CI workflows run checks and source scanning only. They do not deploy a Worker or access production resources.

## Scope

This repository contains the self-hosted service, its portable setup instructions and the static project website in `site/`.
