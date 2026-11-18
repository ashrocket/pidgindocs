import type { Env, NotifyPayload, Provider } from "../types";

function stripMarkdown(message: string): string {
  return message.replace(/\*/g, "").replace(/\[([^\]]+)\]/g, "$1");
}

export const whatsapp: Provider = {
  name: "whatsapp",

  isConfigured(env: Env): boolean {
    return !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID && env.WHATSAPP_TO);
  },

  async send(message: string, _payload: NotifyPayload, env: Env): Promise<string> {
    const plain = stripMarkdown(message);

    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: env.WHATSAPP_TO,
          type: "text",
          text: { body: plain.slice(0, 4096) },
        }),
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      return `failed (${resp.status}: ${body.slice(0, 100)})`;
    }
    return "sent";
  },
};
