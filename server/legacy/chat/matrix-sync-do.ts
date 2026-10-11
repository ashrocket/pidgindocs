import type { Env } from "../types";
import { loadResolvedMatrixConfig, patchMatrixConfig } from "./matrix";
import {
  decideNextAlarmDelay,
  latestOpenMatrixActivity,
  runSyncStep,
} from "./matrix-sync";

// Minimum gap between alarms in hot mode. The /sync long-poll itself blocks
// up to 20s when quiet, so this only throttles back-to-back busy iterations.
const HOT_REALARM_GAP_MS = 250;
const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

// Inbound path for the Matrix channel: matrix.org allows no appservice
// registration, so a single instance of this DO (name: "matrix-sync") runs an
// alarm-driven /v3/sync long-poll loop and feeds events into
// ingestUserMessage. All the protocol logic lives in matrix-sync.ts — this
// class is only the alarm/storage shell around it.
//
// Cadence: hot (immediate re-alarm) while any Matrix-bound conversation saw
// activity in the last 30 min; 60s polls while one is open but quiet; no
// alarm at all when idle — the fan-out path pings /ping on every outbound
// Matrix delivery, and the config route pings after a save.
export class MatrixSyncDO {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ping" && request.method === "POST") {
      const current = await this.state.storage.getAlarm();
      const soon = Date.now() + HOT_REALARM_GAP_MS;
      if (current === null || current > soon) {
        await this.state.storage.setAlarm(soon);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({
        ok: true,
        data: {
          since: (await this.state.storage.get<string>("since")) ?? null,
          backoff_ms: (await this.state.storage.get<number>("backoffMs")) ?? null,
          next_alarm: await this.state.storage.getAlarm(),
        },
      });
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    const config = await loadResolvedMatrixConfig(this.env);
    if (!config) return; // unconfigured/deleted — go idle until pinged again

    const since = (await this.state.storage.get<string>("since")) ?? null;
    const result = await runSyncStep(this.env, config, since);

    if (result.ok) {
      await this.state.storage.put("since", result.nextBatch);
      await this.state.storage.delete("backoffMs");
      if (config.last_error) {
        await patchMatrixConfig(this.env, { last_error: null });
      }
      const activity = await latestOpenMatrixActivity(this.env);
      const delay = decideNextAlarmDelay(activity, Date.now());
      if (delay !== null) {
        await this.state.storage.setAlarm(Date.now() + Math.max(delay, HOT_REALARM_GAP_MS));
      }
      return;
    }

    if (result.fatal) {
      // Dead token: surface in /api/setup and stop — never retry-spin. A
      // config re-save pings us back awake.
      console.error(`[chat:matrix] sync stopped: ${result.error}`);
      await patchMatrixConfig(this.env, { last_error: result.error });
      return;
    }

    if (result.resetCursor) {
      await this.state.storage.delete("since");
    }
    const previous = (await this.state.storage.get<number>("backoffMs")) ?? null;
    const backoff = previous === null ? INITIAL_BACKOFF_MS : Math.min(previous * 2, MAX_BACKOFF_MS);
    await this.state.storage.put("backoffMs", backoff);
    await this.state.storage.setAlarm(Date.now() + backoff);
    console.error(`[chat:matrix] sync error, retrying in ${backoff}ms: ${result.error}`);
  }
}
