import type { Env, NotifyPayload } from "../types";
import { json } from "../utils";
import { resolveApiKeyUser, unauthorized } from "../middleware";
import { formatMessage, fanOutToProviders, getProviderStatus } from "../providers";

export async function handleNotify(request: Request, env: Env): Promise<Response> {
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();

  let payload: NotifyPayload;
  try {
    payload = (await request.json()) as NotifyPayload;
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  if (typeof payload.context !== "string" || !payload.source) {
    return json({ ok: false, error: "missing required fields: source, context" }, 400);
  }

  const message = formatMessage(payload);
  const results = await fanOutToProviders(env, message, payload);

  return json({ ok: true, data: { results } });
}

export async function handleProviders(request: Request, env: Env): Promise<Response> {
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();
  return json({ ok: true, data: { providers: getProviderStatus(env) } });
}
