import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs the PidginCore conformance tests against wrangler.conformance.toml,
// whose entry installs no edition hooks.
const CONFORMANCE_TESTS = [
  "app-shell", "artifact-house-style", "artifact-publication-d1", "artifacts", "auth-utils", "base-path",
  "batch", "builtin-styles", "chat-gchat", "chat-ingest", "commute-routes", "core-boundary", "core-utils", "cron",
  "crypto", "design-system", "design-systems", "design-systems-http", "diagram-zoom", "discuss", "drafts",
  "enhance-anthropic", "identities",
  "jwks-refetch", "jwt-verify", "library-contract", "library-search", "library-security", "message-blocks", "microsoft365", "middleware", "no-model-ids", "oauth",
  "oauth-login", "operator-reader", "pinned-assets", "playlist", "preview", "publish-markdown", "rc",
  "registry", "reply", "reply-isolation", "reply-liveness", "setup-auth", "setup-page", "setup-status",
  "status-folding", "stored-html-sandbox", "theme-palette", "typeset", "webpush", "workspace-overview",
].map((name) => `src/__tests__/${name}.test.ts`);

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.conformance.toml" },
    miniflare: {
      d1Databases: ["MANAGED_TEST_DB"],
      bindings: { TEST_MIGRATIONS: await readD1Migrations("./src/core/migrations") },
    },
  })],
  test: { include: CONFORMANCE_TESTS },
}));
