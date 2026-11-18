import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __clearInstanceSettingsCache,
  readInstanceSettings,
  setInstanceSetting,
} from "../core/instance-settings";

const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
const db = bindings.DB;

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await db.prepare("DELETE FROM instance_settings").run();
  __clearInstanceSettingsCache();
});

describe("instance settings", () => {
  it("returns nothing on a new install", async () => {
    expect(await readInstanceSettings(db)).toEqual({});
  });

  it("keeps the first value in keep mode", async () => {
    expect(await setInstanceSetting(db, "share_secret", "first", "keep")).toBe("first");
    expect(await setInstanceSetting(db, "share_secret", "second", "keep")).toBe("first");
  });

  it("overwrites in replace mode", async () => {
    await setInstanceSetting(db, "origin", "https://a.example.test", "keep");
    expect(await setInstanceSetting(db, "origin", "https://b.example.test", "replace")).toBe("https://b.example.test");
  });

  it("caches reads for 60 seconds per database", async () => {
    const t0 = 1_000_000;
    await setInstanceSetting(db, "origin", "https://a.example.test", "keep");
    expect((await readInstanceSettings(db, t0)).origin).toBe("https://a.example.test");
    await db.prepare("UPDATE instance_settings SET value = 'https://b.example.test' WHERE name = 'origin'").run();
    expect((await readInstanceSettings(db, t0 + 59_999)).origin).toBe("https://a.example.test");
    expect((await readInstanceSettings(db, t0 + 60_000)).origin).toBe("https://b.example.test");
  });

  it("clears the cache when it writes", async () => {
    await readInstanceSettings(db, 5);
    await setInstanceSetting(db, "origin", "https://c.example.test", "replace");
    expect((await readInstanceSettings(db, 5)).origin).toBe("https://c.example.test");
  });
});
