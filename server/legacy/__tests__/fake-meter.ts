// Test double for the usage hooks. It follows the reserve/settle rules the
// core documents: idempotent per key, settled keys stay as tombstones.
import { setMeterHooks, type Units } from "../meter";

interface Row { reserved: Units; settled: boolean; ok: boolean }

export function installFakeMeter(start: number, opts: {
  onReserve?: (rk: string) => Promise<void>;
  refuseNext?: number;
  settleThrowsOnce?: boolean;
} = {}) {
  const state = {
    remaining: start,
    ledger: new Map<string, Row>(),
    reserveCalls: [] as string[],
    settleCalls: [] as Array<{ rk: string; actual: Units }>,
    refuseNext: opts.refuseNext ?? 0,
    settleThrowsOnce: opts.settleThrowsOnce ?? false,
  };
  const total = (u: Units) => Object.values(u).reduce((a, b) => a + (b ?? 0), 0);
  const reserve = async (_env: unknown, _user: string, units: Units, rk: string) => {
    state.reserveCalls.push(rk);
    const prior = state.ledger.get(rk);
    if (prior) return prior.settled || !prior.ok ? { ok: false as const } : { ok: true as const };
    if (state.refuseNext > 0) {
      state.refuseNext--;
      return { ok: false as const, remaining: { message: state.remaining } };
    }
    if (total(units) > state.remaining) return { ok: false as const, remaining: { message: state.remaining } };
    state.remaining -= total(units);
    state.ledger.set(rk, { reserved: units, settled: false, ok: true });
    if (opts.onReserve) await opts.onReserve(rk);
    return { ok: true as const };
  };
  const settle = async (_env: unknown, rk: string, actual: Units) => {
    state.settleCalls.push({ rk, actual });
    if (state.settleThrowsOnce) { state.settleThrowsOnce = false; throw new Error("settle crashed"); }
    const row = state.ledger.get(rk);
    if (!row) { state.ledger.set(rk, { reserved: {}, settled: true, ok: false }); return; }
    if (row.settled) return;
    state.remaining += total(row.reserved) - total(actual);
    row.settled = true;
  };
  setMeterHooks({ reserve: reserve as any, settle: settle as any });
  return state;
}
