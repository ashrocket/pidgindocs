# Self-host PidginDocs

This guide is a starting point for a single-owner Cloudflare Worker installation. Review the limits and external service requirements before using it with real data.

## Prerequisites

- Node.js 22 or later and npm
- A Cloudflare account with Workers, D1, R2, KV, Queues, and Durable Objects available
- A Cloudflare API token scoped to the resources you create
- A long random `API_KEY` and an `OWNER_EMAIL`
- Optional: a mail provider, APNs credentials for your own Apple app, and provider API keys for optional enhancement features

## Create resources

1. Copy `server/wrangler.toml` to a private local config if you need to change its bindings.
2. Create a D1 database, R2 bucket, KV namespace, queue and dead-letter queue, and update the corresponding IDs/names in your config.
3. Set `WORKER_URL` to the HTTPS Worker URL Cloudflare assigns, or to your own domain after configuring it.
4. Keep API and provider credentials in `.dev.vars` for local work or Cloudflare Worker secrets for deployment. Never commit those values.

## Run locally

```sh
cd server
npm ci
npm run db:migrate
npm run dev
```

Create `server/.dev.vars` using `.dev.vars.example`, then replace every placeholder. Open the local Worker URL, request a login link, and complete the owner setup flow.

## Deploy

Review your Cloudflare bindings and permissions, then deploy explicitly with the portable template:

```sh
cd server
npx wrangler d1 migrations apply DB --remote --config wrangler.toml
npx wrangler deploy --config wrangler.toml
```

Configure `API_KEY`, `OWNER_EMAIL`, and `WORKER_URL` as Worker variables or secrets as appropriate. Back up your own D1 and R2 data before applying future migrations. A successful deploy is not a substitute for checking your own domain, authentication, email, storage, and backup behavior.

## Optional Apple clients

Apple clients are not included in this repository. They need a separately reviewed app identity, signing team, API origin, universal-link domains, and third-party asset/license inventory before release.
