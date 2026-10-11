import type { Env, NotifyPayload, Provider } from "../types";

export const github: Provider = {
  name: "github",

  isConfigured(env: Env): boolean {
    return !!(env.GITHUB_TOKEN && env.GITHUB_REPO);
  },

  async send(message: string, payload: NotifyPayload, env: Env): Promise<string> {
    const title = `PidginDocs needs attention: ${payload.session_name || "session"}`;
    const labels = [payload.source, "notification"];

    const resp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "pidgin-worker",
        },
        body: JSON.stringify({ title, body: message, labels }),
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      return `failed (${resp.status}: ${body.slice(0, 100)})`;
    }
    return "sent";
  },
};
