import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  test: { include: ["legacy/**/*.test.ts"] },
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.legacy.toml" },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
  })],
}));
