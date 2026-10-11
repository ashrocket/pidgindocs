# PidginDocs

PidginDocs is a self-hostable service for sharing messages, questions, documents, and replies between people and software agents. This repository contains the Cloudflare Worker server and a small shell client.

The project is licensed under [MIT](LICENSE). Dependencies and bundled assets retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

The owner has confirmed redistribution rights for the finished PidginDocs bird image. In-progress brand explorations are not part of this repository.

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

This repository contains the self-hosted service and its portable setup instructions.
