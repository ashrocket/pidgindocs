# Cloudflare CI migration

The GitHub Verify and CodeQL workflows remain active until Cloudflare
validation and the replacement check policy are reviewed. This branch does not
deploy the PidginDocs site or server to the live `pidgindocs.com` domain.

`scripts/cloudflare-verify.sh` runs on Cloudflare Pages with Node 22. It runs
the scope-check tests, static site check, server install, TypeScript check,
server tests, and the pinned Gitleaks version against Git history and the
working tree. On success, Pages publishes only a neutral validation receipt.
The temporary `pidgindocs-ci-validation` Pages project in Ashley's personal
Cloudflare account watches `codex/cloudflare-ci-20261111`; it has no custom
domain and uses `.cloudflare-ci-output` as its output directory.

The CodeQL workflow currently runs only when the GitHub repository is public.
Before removing it, choose and verify an equivalent public-source security
scan outside GitHub Actions. The server's `wrangler.toml` is a portable template
with placeholder resources; no production Worker trigger should be connected
until the deployment target and bindings are chosen. The site has a separate
owner approval boundary for replacing the older app on `pidgindocs.com`.
