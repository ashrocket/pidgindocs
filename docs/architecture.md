# PidginCore architecture

This note explains where PidginCore sits. It also explains how hosted editions relate to it.

## What PidginCore is

PidginCore is the open-source core of PidginDocs. It is a self-hosted Cloudflare Worker. It handles messages, questions and replies, documents, artifacts, agent boards, an MCP endpoint and a shell client. It serves one owner and many agents.

This repository is the open-source PidginDocs server. It is the home of PidginCore.

The hosted editions develop the newer core modules today. They will move those modules into this repository after a public-safety review. Until then, this repository holds an older copy of the core.

## One deployment, one owner

One deployment serves one owner. This is true by design:

- The `OWNER_EMAIL` value names the owner. The server creates the owner account on first use.
- Only the owner can create invitations and invite codes.
- Each deployment has its own D1 database, R2 bucket, KV namespace and queues.
- The owner's data stays in the owner's Cloudflare account. Optional services that the owner turns on can receive some data.

## Core and hosted editions

Hosted editions build on the core:

- Duva Solo gives one person one dedicated deployment.
- Duva Teams is for teams.

Each hosted edition imports the core. It adds hosting, billing and team features. It keeps those additions in a separate private codebase.

Each hosted customer gets a separate deployment. Two customers never share a deployment.

```text
 This repository                       Separate private codebase
+----------------------+              +------------------------------+
| PidginCore           | <--- imports | Hosted editions              |
| (open source, MIT)   |              | (hosting, billing, teams)    |
+----------------------+              +------------------------------+
          ^                                         |
          |                                         v
 self-hosted deployment             one deployment for each customer
 (your Cloudflare account)
```

## Rules between the two

- The core never depends on a hosted edition. It must build, test and run with no hosted edition present.
- A hosted edition depends on the core. The dependency has one direction only.
- Do not put hosting, billing, customer data or hosted-edition configuration in this repository.
- Do not copy credentials, resource IDs or deployment configuration from a hosted edition into this repository.

## Batch endpoint and usage hooks

- `server/legacy/routes/batch.ts` serves `POST /api/batch`: up to 25 items (`message`, `status`, `document`, `artifact`, `comment`, `delete`) in one call, each through the function its single route uses. An `Idempotency-Key` header is required; receipts live in the `batch_receipts` table (`server/migrations/0002_batch_receipts.sql`) and the daily cron sweeps them.
- `server/legacy/meter.ts` is an inert seam. With no hooks registered nothing happens. Something that wants usage limits calls `setMeterHooks` with `reserve` and `settle`. Batch operations, draft retention/commit, and the optional artifact AI hook call this seam. `draft_bytes` measures retained bytes; other units count operations. Reservation keys and settlement are idempotent, including release retries. The core reports counts by kind in the `X-Pidgin-Units` header and never knows a limit, a weight or a price.
- `validateMessagePayload` in `server/legacy/routes/messages.ts` holds the message field checks that `POST /api/messages` and the batch endpoint share.
- `foldStatus` in `server/legacy/messages/store.ts` keeps one living status row per stable session: a later `status` post updates it instead of inserting, until `final: true` closes it (`server/migrations/0003_status_closed.sql`). The generated MCP fallback session never folds.
- `server/legacy/artifact-ai.ts` is an optional hook for composing a long document into a page with AI: `artifactAI()`, default none, registered with `setArtifactAI`. `POST /api/artifacts` with `"ai": true` runs every input check first, reserves `{artifact_ai, artifact}` with the meter hooks (a refusal is 429), calls the hook, and settles with what happened. An attempted AI call retains its AI unit even if generation fails; an unknown publication outcome retains the artifact reservation. It answers `ai: "generated"`, `"failed"` or, with no hook, `"none"` (a plain artifact).
- `server/legacy/drafts.ts` stores immutable R2 revisions with a D1 current pointer, retained-byte ledger and publication receipts (`0005_draft_revisions.sql`). `PUT|DELETE /api/drafts/:key` and `POST /api/drafts/:key/commit` require an active personal caller; cookie writes require the same origin. Uploads are limited to 2 MiB, 50 live keys and 100 MiB of retained draft data per user. Old bytes stay counted until object deletion and idempotent meter release succeed. Concurrent edits never share an R2 object key.
- Artifact publication (`0006_artifact_upload_attempts.sql`) registers each upload before R2 and writes to a unique key. A D1 transaction activates a version only if the previous version and current write access still match. Readers and the library index use the stored version key. A losing writer cleans up only its own confirmed-rejected upload. Artifact deletion atomically checks the expected scope/version, detaches version metadata and records every object for retryable cleanup. Version pruning checks current, shared and message-block pins in the unlink transaction and uses the same cleanup records. Shared-version PATCH also checks that its selected version still exists in the update transaction. Migration `0007_artifact_block_pins.sql` guards artifact block INSERT/UPDATE; a missing version aborts the whole message batch. A lost R2/D1 response retains the upload-attempt or committed-version record and bytes; uncertain attempts do not expire automatically and require operator reconciliation. Draft publication receipts and byte reservations remain held in that case. No additional pricing or provider implementation is installed.
- A five-minute cron commits drafts idle for 10 minutes only while the owner remains active and has write access to the selected team/project. Manual idempotency keys and cron work share one receipt per revision. The daily trigger retires uncommitted current drafts after seven days and retries cleanup in bounded batches.
- A lost upload or publication response remains staged or held for operator reconciliation. It keeps its reservation and cannot be republished automatically, including after seven days. Inspect the owner, revision, matching document/artifact and R2 object before reconciling the receipt; do not delete an unresolved receipt merely to make a retry succeed. Completed receipts and aliases expire after seven days once their blobs are gone.
- Batch receipts also hold ambiguous work without refund or automatic retry. Completed responses replay for seven days. A different payload with the same key returns the original completed response; use a new key only for an intentional new operation.
- [Local agent endpoint](local-endpoint.md) is the contract a desktop host app implements so agents can use something on the same machine before the server. `scripts/pidgindocs-mcp-proxy.mjs` is the client and `scripts/tests/fake-local-endpoint.mjs` the test double.

## Features not in the code yet

Slates, favorites and reply events are planned for the core. They are not in this repository yet. Do not rely on them.

## Related files

- [README.md](../README.md) gives the overview and the development commands.
- [INSTALL.md](../INSTALL.md) explains how to self-host.
- [SECURITY.md](../SECURITY.md) explains how to report a vulnerability.
- [site/README.md](../site/README.md) describes the project website.
