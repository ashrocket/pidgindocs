import { describe, expect, it } from "vitest";
import { appShellCss, appShellHeader, LIBRARY_TABS_CSS, libraryTabsHtml } from "../core/web/app-shell";
import { paletteCss } from "../core/web/theme";

function placeKeys(html: string): string[] {
  return [...html.matchAll(/data-place="([^"]+)"/g)].map((m) => m[1]);
}

function menuKeys(html: string): string[] {
  return [...html.matchAll(/data-menu="([^"]+)"/g)].map((m) => m[1]);
}

describe("appShellHeader places", () => {
  it("renders workspace, inbox and library by default, without runbooks", () => {
    expect(placeKeys(appShellHeader())).toEqual(["workspace", "inbox", "library"]);
  });

  it("renders requested places in canonical order only", () => {
    expect(placeKeys(appShellHeader({ places: ["runbooks", "workspace"] }))).toEqual(["workspace", "runbooks"]);
  });

  it("marks exactly one active place inside the place row", () => {
    const html = appShellHeader({ active: "inbox" });
    const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav).toMatch(/<a data-place="inbox"[^>]*aria-current="page"/);
  });

  it("prefixes brand and place hrefs with the base, and uses a caller's mark as given", () => {
    const html = appShellHeader({ base: "/alice", brand: { name: "Example", mark: "/alice/assets/x.png" } });
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith("/alice/")).toBe(true);
    }
    expect(html).toContain('href="/alice/workspace"');
    expect(html).toContain('src="/alice/assets/x.png"');
  });

  it("escapes the brand name", () => {
    const html = appShellHeader({ brand: { name: '<b>"x"&' } });
    expect(html).toContain("&lt;b&gt;&quot;x&quot;&amp;");
    expect(html).not.toContain("<b>");
  });

  it("renders menu links in the given order, then Sign out, and drops unsafe ones", () => {
    const html = appShellHeader({
      menu: [
        { key: "people", label: "People", href: "/people" },
        { key: "bad", label: "Bad", href: "//evil.example" },
        { key: "js", label: "J", href: "javascript:alert(1)" },
      ],
      activeMenu: "people",
    });
    expect(menuKeys(html)).toEqual(["people", "signout"]);
    expect(html).toContain('<a data-menu="people" href="/people" aria-current="page">People</a>');
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("javascript:");
  });

  it("uses no script, inline style or inline handlers, and keeps the nav button", () => {
    const html = appShellHeader({ active: "workspace", menu: [{ key: "x", label: "X", href: "/x" }] });
    expect(html).toContain("data-dnav-open");
    expect(html).not.toContain("<script");
    expect(html).not.toContain(" style=");
    expect(html).not.toContain(" onclick");
  });

  it("refuses a protocol-relative mark", () => {
    expect(appShellHeader({ brand: { name: "X", mark: "//evil.example/x.png" } })).not.toContain("<img");
  });
  it("drops backslash-shaped and whitespace-bearing local paths", () => {
    const html = appShellHeader({
      brand: { name: "X", mark: "/\\evil.example/x.png" },
      menu: [
        { key: "bs", label: "Bs", href: "/\\evil.example" },
        { key: "sp", label: "Sp", href: "/a b" },
      ],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(menuKeys(html)).not.toContain("bs");
    expect(menuKeys(html)).not.toContain("sp");
  });

  it("has no built-in entries except Sign out, written under the base", () => {
    expect(menuKeys(appShellHeader())).toEqual(["signout"]);
    expect(appShellHeader({ base: "/alice" })).toContain('<a data-menu="signout" href="/alice/auth/logout">Sign out</a>');
  });

  it("builds library tabs with the current one marked", () => {
    const docs = libraryTabsHtml("/alice", "documents");
    expect(docs).toContain('<a href="/alice/artifacts">Artifacts</a>');
    expect(docs).toContain('<a href="/alice/toc" aria-current="page">Documents</a>');
    expect(libraryTabsHtml("", "artifacts")).toContain('<a href="/artifacts" aria-current="page">Artifacts</a>');
    expect(LIBRARY_TABS_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("palette CSS", () => {
  it("applies valid overrides and falls back for unsafe values", () => {
    const css = paletteCss({ primary: "#20518d", ink: "red;}body{display:none" });
    expect(css).toContain("--c-primary:#20518d");
    expect(css).toContain("--c-ink:#183c3c");
    expect(css).not.toContain("display:none");
  });

  it("defines the focus role and kebab-cases every name with a single rule", () => {
    const css = paletteCss();
    expect(css).toContain("--c-focus:#d9b88f");
    expect(css).toContain("--c-badge-message-bg:");
    expect(css.split("{")).toHaveLength(2);
  });

  it("keeps hex colour literals out of the shell rules", () => {
    const css = appShellCss();
    const rules = css.slice(paletteCss().length);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
