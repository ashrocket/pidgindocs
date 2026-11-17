import type { Env, NotifyPayload, Provider } from "../types";

function stripMarkdown(message: string): string {
  return message.replace(/\*/g, "").replace(/\[([^\]]+)\]/g, "$1");
}

export const telnyx: Provider = {
  name: "telnyx",

  isConfigured(env: Env): boolean {
    return !!(env.TELNYX_API_KEY && env.TELNYX_FROM_NUMBER && env.TELNYX_TO_NUMBER);
  },

  async send(message: string, _payload: NotifyPayload, env: Env): Promise<string> {
    const plain = stripMarkdown(message);

    const resp = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.TELNYX_FROM_NUMBER,
        to: env.TELNYX_TO_NUMBER,
        text: plain.slice(0, 1600),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return `failed (${resp.status}: ${body.slice(0, 100)})`;
    }
    return "sent";
  },
};
