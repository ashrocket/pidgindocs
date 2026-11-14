import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { inboxPage, tocPage } from "../web/index";
import { shell } from "../web/shell";
import { docs, filters, messages, renderPlain, sha256 } from "./fixtures-shell-pages";

const env = {} as Env;
const OLD_INBOX_LINKS = '<a href="/auth/logout">Logout</a>';

// Hashes of the pages as they render without a shell, with date formatting pinned.
// The pages interpolate theme colours, so a change to the default palette changes these.
const BEFORE = {
  inbox: "cbe9df9d63eebf3709bca68409cc159b08370f697b3439814fef4e88dcb477ad",
  inboxEmpty: "f2567d3e48403f51ba9d07520aa967882816c7baf3743403ea13d3277fedfd98",
  toc: "68e19038413acac52855f383e75e828448cc65d67ad50617afbd3e59b98a2049",
  tocEmpty: "5c500fb215308975aa00bfbef605500d476cafed7110da466c8e15791651450b",
};

describe("shell defaults", () => {
  it("names the brand, three places and only menu entries that have a page", () => {
    const config = shell(env, {});
    expect(config.brand?.name).toBe("PidginDocs");
    expect(config.brand?.palette).toBeUndefined();
    expect(config.brand?.mark).toBe("/assets/app-icon.jpg");
    expect(config.places).toEqual(["workspace", "inbox", "library"]);
    expect(config.menu?.map((link) => link.href)).toEqual(["/commute", "/registry", "/stats", "/profile", "/setup"]);
  });

  it("adds People only when the caller can manage people", () => {
    expect(shell(env, { canManagePeople: true }).menu?.map((link) => link.href)).toContain("/admin/users");
  });
});

describe("pages without a shell", () => {
  it("render exactly what they did before", async () => {
    const out = await renderPlain();
    for (const [name, html] of Object.entries(out)) {
      expect(await sha256(html), name).toBe(BEFORE[name as keyof typeof BEFORE]);
    }
  });
});

describe("pages with a shell", () => {
  it("inbox shows the shared header, its css and no old link row", async () => {
    const html = await inboxPage(messages, { ...filters, shell: shell(env, {}) }).text();
    expect(html).toContain("data-app-shell");
    expect(html).toContain('<a data-place="inbox" href="/inbox" aria-current="page">Inbox</a>');
    expect(html).toContain("--c-primary:");
    expect(html).toContain(".app-shell{");
    expect(html).not.toContain(OLD_INBOX_LINKS);
    expect(html).not.toContain('<a href="/stats">Stats</a>');
    expect(html).toContain("Mark all read");
    expect(html).toContain("sendReply(");
  });

  it("toc shows the shared header, library tabs above the heading and no old header", async () => {
    const html = await tocPage(docs, shell(env, {})).text();
    expect(html).toContain("data-app-shell");
    expect(html).toContain('<a data-place="library" href="/toc" aria-current="page">Library</a>');
    expect(html).toContain('<a href="/toc" aria-current="page">Documents</a>');
    expect(html.indexOf("library-tabs")).toBeLessThan(html.indexOf("<h1>Documents</h1>"));
    expect(html).not.toContain('<div class="header-links">');
    expect(html).not.toContain(OLD_INBOX_LINKS);
    expect(html).toContain("generateLink(");
  });

  it("both pages show the same shared header markup for the same config", async () => {
    const config = shell(env, {});
    const inbox = await inboxPage([], { shell: config }).text();
    const toc = await tocPage([], config).text();
    const header = (html: string) => html.match(/<header class="app-shell"[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header(inbox)).not.toBe("");
    expect(header(inbox).replace(/ aria-current="page"/g, "")).toBe(header(toc).replace(/ aria-current="page"/g, ""));
  });
});
