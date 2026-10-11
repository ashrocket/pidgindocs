import type { Env, NotifyPayload, Provider } from "../types";
import { github } from "./github";
import { whatsapp } from "./whatsapp";
import { telnyx } from "./telnyx";

const providers: Provider[] = [github, whatsapp, telnyx];

export function formatMessage(payload: NotifyPayload): string {
  const label = payload.source === "work" ? "Work" : "Personal";
  const repo = payload.repo ? ` (${payload.repo})` : "";
  const session = payload.session_name || "unnamed session";
  const context =
    payload.context.length > 500
      ? payload.context.slice(0, 500) + "..."
      : payload.context;

  return [
    `*PidginDocs needs attention* [${label}]${repo}`,
    `Session: ${session}`,
    "",
    context,
    "",
    "Open PidginDocs to respond.",
  ].join("\n");
}

export async function fanOutToProviders(
  env: Env,
  message: string,
  payload: NotifyPayload
): Promise<string[]> {
  const active = providers.filter((p) => p.isConfigured(env));

  if (active.length === 0) {
    return ["no external providers configured"];
  }

  const results = await Promise.allSettled(
    active.map(async (p) => {
      const result = await p.send(message, payload, env);
      return `${p.name}: ${result}`;
    })
  );

  return results.map((r) =>
    r.status === "fulfilled" ? r.value : `error: ${r.reason}`
  );
}

export function getProviderStatus(env: Env) {
  return providers.map((p) => ({
    name: p.name,
    configured: p.isConfigured(env),
  }));
}
