// PidginCore: inert usage-hook seam. Does nothing unless something registers hooks.
import type { Env } from "./types";

export type UnitKind =
  | "message" | "status" | "document" | "artifact" | "comment"
  | "delete" | "fold" | "draft_put" | "draft_commit";
export type Units = Partial<Record<UnitKind, number>>;

export const UNITS_HEADER = "X-Pidgin-Units"; // "message=3;document=1"; "none" for a replay

const UNIT_ORDER: UnitKind[] = [
  "message", "status", "document", "artifact", "comment",
  "delete", "fold", "draft_put", "draft_commit",
];

export interface MeterHooks {
  reserve(
    env: Env,
    userId: string,
    units: Units,
    rk: string
  ): Promise<{ ok: true } | { ok: false; remaining?: Record<string, number> }>;
  // Idempotent per rk: refund reserved minus actual once.
  settle(env: Env, rk: string, actual: Units): Promise<void>;
}

const defaults: MeterHooks = {
  async reserve() { return { ok: true }; },
  async settle() {},
};

let hooks: MeterHooks = defaults;

// Replaces the registered hooks (missing ones fall back to the defaults), so
// setMeterHooks({}) restores the inert behavior.
export function setMeterHooks(h: Partial<MeterHooks>): void {
  hooks = { ...defaults, ...h };
}

export function meter(): MeterHooks {
  return hooks;
}

export function formatUnits(units: Units): string {
  const parts = UNIT_ORDER
    .filter((k) => (units[k] ?? 0) > 0)
    .map((k) => `${k}=${units[k]}`);
  return parts.length ? parts.join(";") : "none";
}

// Sets the header only; the body and status are untouched.
export function withUnits(res: Response, units: Units): Response {
  const out = new Response(res.body, res);
  out.headers.set(UNITS_HEADER, formatUnits(units));
  return out;
}
