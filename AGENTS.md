# PidginDocs self-hosted source

This repository contains only the self-hosted PidginDocs edition. Never copy
credentials, customer data, production resource IDs, or deployment
configuration from other projects into this tree.

The project license is MIT. Dependencies and bundled assets retain their own
licenses; see `THIRD_PARTY_NOTICES.md`.

Use `server/wrangler.toml` as a portable template with placeholder resources.
Inspect the target account, bindings, and migration state before any remote
Wrangler command. Workers AI is optional and can incur usage charges; do not
add `[ai]` or run remote inference without a deliberate environment choice.

For code changes, run `npm ci`, `npx tsc --noEmit`, and `npm test` from `server/`.
Check `npm audit` and scan the full Git history plus working tree with
Gitleaks before a publication decision. GitHub's Verify workflow is the
current CI gate. CodeQL is configured to run after the repository is public.

Keep this repository focused on the self-hosted service and do not add customer
data. Verify a clean installation before announcing a source release.
