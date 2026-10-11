import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.toml" },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
  })],
}));
