import { vi } from "vitest";
import { inboxPage, tocPage } from "../web/index";

export const messages = [
  { id: "m1", type: "question", title: "Ship <it>?", body: "Body & text ".repeat(20), priority: "urgent", read: 0, reply: null, instance_project: "proj", instance_model: "model", instance_source: "src", instance_session_id: "s1", created_at: "2026-01-02T03:04:05Z", visual_count: 2, source_url: "https://example.org/x" },
  { id: "m2", type: "message", title: "Hello", body: "", priority: "normal", read: 1, reply: null, instance_project: "proj", instance_model: "model", created_at: "2026-01-03T03:04:05Z" },
  { id: "m3", type: "question", title: "Answered", body: "short", priority: "normal", read: 1, reply: "yes", instance_project: "p", instance_model: "m", created_at: "2026-01-04T03:04:05Z" },
];
export const filters = { typeFilter: "question", offset: 50, hasMore: true, instanceCount: 3, pendingCount: 2, projectFilter: "p", repliedFilter: "false", sourceFilter: "s", unreadOnly: true };
export const docs = [
  { id: "d1", title: "Doc <one>", public: 1, instance_project: "proj", instance_model: "model", created_at: "2026-01-02 03:04:05" },
  { id: "d2", title: "Doc two", public: 0, instance_project: "proj", instance_model: "model", created_at: "2026-01-05 03:04:05" },
];

/** Render the pages with date formatting pinned so the output does not depend on time zone or locale. */
export async function renderPlain(): Promise<Record<string, string>> {
  const a = vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("DATE");
  const b = vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("DATE");
  try {
    return {
      inbox: await inboxPage(messages, filters).text(),
      inboxEmpty: await inboxPage([]).text(),
      toc: await tocPage(docs).text(),
      tocEmpty: await tocPage([]).text(),
    };
  } finally {
    a.mockRestore();
    b.mockRestore();
  }
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
