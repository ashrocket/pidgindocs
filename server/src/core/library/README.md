# Library

The Library holds a person's private Projects and Tags and files their documents
and artifacts into them. Its search answers questions from those items with
citations. Both are part of PidginCore, so a self-hosted deployment has them
without extra setup. The search engine adapts code from Jevbox (MIT) and is
named "search" here; `search/LICENSE-jevbox.md` keeps its licence notice.

Core mounts the routes in `core/app.ts` through `handleLibrary(request, env, path)`
(after `BASE_PATH` is removed), lists `LIBRARY_TOOLS` in the personal MCP catalog,
and sends personal tool calls to `callLibraryTool({ env, request, name, args })`.
The internal tool names keep the `pidgin_` prefix for the wire-name translation.
HTTP and tool adapters reject board Agent credentials. A deployment turns the
Library off with the `libraryEnabled(env)` edition hook, which defaults to true.
When it is off, the routes answer 404, the tools are not listed and the list
filters are ignored. The tables come from `migrations/core_20261117_library.sql`.

Search, ask and suggest need `TYPESAFE_API_KEY`. Without it they answer
`503` with the code `search_not_configured` (an MCP tool returns the same as a
tool error). Projects, Tags, filing by hand, items and the page work without it.

`GET /library` serves the browser controls. The legacy `/api/library` routes
are retained, with `/api/library/items` added for safe item metadata. The
browser uses stored i18next resources in `i18n/{en,ru,sv,es}.json`; it makes no
AI request for interface copy and includes the deployment base path in links.

Source-label filing is computed on reads: explicit filing overrides a source
rule, and a rule overrides unfiled. New content therefore needs no extra write
to follow a rule. Document versions share their `doc_slug` family placement.
For current list/detail serializers, use:

```ts
applyLibraryQuery(env, { userId, type, alias, project, tag }, conditions, binds);
const placements = await loadEnabledLibraryPlacements(env, userId, refs);
const placement = placements.get(`${type}:${id}`);
```

Each query also checks the current resource content policy. Being the author
does not bypass a revoked team permission. Search indexes only current, visible
personal documents and page artifacts. Artifact content comes from the current
`artifact_versions.r2_key`, including staged version keys.

Jev uses `TYPESAFE_API_KEY` and the pinned model `jev-1.14.0`. The published
[model pricing](https://docs.typesafe.ai/models.md), checked on 2026-11-12,
is $0.042 per million input tokens; output tokens are free. Every call checks
`editionAiBudgetLeft` and records its resolved model and token usage through
`editionRecordAiUsage`. Requests in one search are serialized so each check
sees the previous charge. Successful malformed responses are still charged.
Model changes require a fresh price and retrieval-threshold review.

Answers use the shared Anthropic helper and the current `claude-deep` tier;
they need `ANTHROPIC_API_KEY`. No separate provider transport or ledger is used.
Search indexes reserve R2 byte growth through `recordEditionStorage`, release
failed puts, and release shrinkage/deletions. A read-only index-status request
does not prune or build anything.

The inherited retrieval code and its MIT attribution are kept together in
`search/`, including `LICENSE-jevbox.md`. Tests stub all external providers.
