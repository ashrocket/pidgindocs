import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../core/types";
import { getSetupStatus } from "../core/setup/status";
import { destinationConfigured, getDestinationConfigValue } from "../core/destinations/store";

vi.mock("../core/destinations/store", () => ({
  destinationConfigured: vi.fn(),
  getDestinationConfigValue: vi.fn(async () => null),
}));

const env = {
  DB: {
    prepare: () => ({ first: async () => ({ count: 0 }) }),
  },
} as unknown as Env;

// Mark the given destination names as configured; everything else is not.
function configured(...names: string[]) {
  vi.mocked(destinationConfigured).mockImplementation(async (_env, name) =>
    names.includes(name)
      ? { configured: true, updated_at: "2026-06-05 00:00:00" }
      : { configured: false }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDestinationConfigValue).mockResolvedValue(null);
});

describe("getSetupStatus onboarding gate (post Slack/Confluence removal)", () => {
  it("starts at the microsoft365 step with nothing configured and is not ready", async () => {
    configured();
    const status = await getSetupStatus(env);
    expect(status.currentStep).toBe("microsoft365");
    expect(status.ready).toBe(false);
  });

  it("advances to commute once microsoft365 is configured", async () => {
    configured("microsoft365");
    const status = await getSetupStatus(env);
    expect(status.currentStep).toBe("commute");
    expect(status.ready).toBe(false);
  });

  it("is ready when microsoft365 and commute are configured (no Confluence gate)", async () => {
    configured("microsoft365", "commute");
    const status = await getSetupStatus(env);
    expect(status.currentStep).toBe("done");
    expect(status.ready).toBe(true);
  });

  it("treats legacy onedrive config as satisfying the microsoft365 step", async () => {
    configured("onedrive", "commute");
    const status = await getSetupStatus(env);
    expect(status.microsoft365.configured).toBe(true);
    expect(status.ready).toBe(true);
  });
});
