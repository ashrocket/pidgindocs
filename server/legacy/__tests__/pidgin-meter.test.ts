import { afterEach, describe, expect, it } from "vitest";
import { formatUnits, meter, setMeterHooks, UNITS_HEADER, withUnits } from "../meter";
import type { Env } from "../types";

const env = {} as Env;

afterEach(() => setMeterHooks({}));

describe("meter seam", () => {
  it("defaults: reserve is ok and settle does nothing", async () => {
    expect(await meter().reserve(env, "u", { message: 3 }, "rk")).toEqual({ ok: true });
    await expect(meter().settle(env, "rk", {})).resolves.toBeUndefined();
  });

  it("a registered hook replaces only its own default", async () => {
    const seen: string[] = [];
    setMeterHooks({ reserve: async (_e, _u, _units, rk) => { seen.push(rk); return { ok: false, remaining: { message: 0 } }; } });
    expect(await meter().reserve(env, "u", { message: 1 }, "k1")).toEqual({ ok: false, remaining: { message: 0 } });
    expect(seen).toEqual(["k1"]);
    await expect(meter().settle(env, "k1", {})).resolves.toBeUndefined();
  });

  it("setMeterHooks({}) restores the inert defaults", async () => {
    setMeterHooks({ reserve: async () => ({ ok: false }) });
    setMeterHooks({});
    expect(await meter().reserve(env, "u", { message: 1 }, "k")).toEqual({ ok: true });
  });

  it("formats counts in a fixed order and skips zeros", () => {
    expect(formatUnits({ document: 1, message: 3 })).toBe("message=3;document=1");
    expect(formatUnits({ message: 0, status: 2 })).toBe("status=2");
    expect(formatUnits({})).toBe("none");
  });

  it("withUnits sets the header and leaves status and body alone", async () => {
    const res = withUnits(new Response('{"a":1}', { status: 201, headers: { "X-Other": "yes" } }), { message: 2 });
    expect(res.headers.get(UNITS_HEADER)).toBe("message=2");
    expect(res.headers.get("X-Other")).toBe("yes");
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"a":1}');
    expect(withUnits(new Response("x"), {}).headers.get(UNITS_HEADER)).toBe("none");
  });
});
