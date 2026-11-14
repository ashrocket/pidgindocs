import { describe, expect, it } from "vitest";
import { appPath, appShellCss, appShellHeader, libraryTabsHtml, LIBRARY_TABS_CSS, placeLinks } from "../web/app-shell";
import { paletteCss } from "../web/theme";

const brand = { name: "PidginDocs", mark: "/assets/app-icon.jpg" };

describe("shared page header", () => {
  it("shows the brand name and the three places with the active one marked", () => {
    const html = appShellHeader({ brand, active: "inbox" });
    expect(html).toContain('<span class="app-name">PidginDocs</span>');
    expect(html).toContain('<img class="app-mark" src="/assets/app-icon.jpg" alt="">');
    expect(html).toContain('<a data-place="workspace" href="/workspace">Workspace</a>');
    expect(html).toContain('<a data-place="inbox" href="/inbox" aria-current="page">Inbox</a>');
    expect(html).toContain('<a data-place="library" href="/toc">Library</a>');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("is plain markup: no script, account menu built from details, Sign out uses the existing logout route", () => {
    const html = appShellHeader({ brand, menu: [{ key: "setup", label: "Setup", href: "/setup" }] });
    expect(html).not.toMatch(/<script|\son\w+=/i);
    expect(html).toContain("<details");
    expect(html).toContain('<a data-menu="setup" href="/setup">Setup</a>');
    expect(html).toContain('<a data-menu="signout" href="/auth/logout">Sign out</a>');
  });

  it("falls back to a generic name and omits the mark when none is given", () => {
    const html = appShellHeader();
    expect(html).toContain('<span class="app-name">Workspace</span>');
    expect(html).not.toContain("app-mark");
  });

  it.each(["//evil.example", "/\\evil", "/a b", "javascript:alert(1)", "https://evil.example/x", "/a\tb", "/a\nb", ""])(
    "does not render the menu href %j",
    (href) => {
      const html = appShellHeader({ brand, menu: [{ key: "bad", label: "Bad", href }] });
      expect(html).not.toContain('data-menu="bad"');
      expect(html).toContain('data-menu="signout"');
    },
  );

  it.each(["//evil.example/x.png", "/\\evil.png", "/a b.png", "javascript:alert(1)", "data:image/png;base64,AAAA"])(
    "does not render the mark %j",
    (mark) => {
      const html = appShellHeader({ brand: { name: "PidginDocs", mark } });
      expect(html).not.toContain("<img");
      expect(html).toContain("PidginDocs");
    },
  );

  it("escapes every brand and label value", () => {
    const html = appShellHeader({
      brand: { name: `<b>"x"&'y'</b>`, mark: '/m.png"onerror="alert(1)' },
      menu: [{ key: 'k"><i>', label: "<u>L</u>", href: '/p?a="1"&b=<2>' }],
      activeMenu: 'k"><i>',
    });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<u>");
    expect(html).not.toContain("<i>");
    expect(html).not.toMatch(/"onerror=/);
    expect(html).toContain("&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;");
    expect(html).toContain("&lt;u&gt;L&lt;/u&gt;");
    expect(html).toContain('href="/p?a=&quot;1&quot;&amp;b=&lt;2&gt;"');
  });

  it("limits the place row to the places asked for", () => {
    const places = placeLinks({ places: ["library", "workspace"], active: "library" });
    expect(places.map((place) => place.key)).toEqual(["workspace", "library"]);
    expect(places.find((place) => place.current)?.key).toBe("library");
  });

  it("joins a base and a path without doubling the slash", () => {
    expect(appPath("", "/inbox")).toBe("/inbox");
    expect(appPath("/app/", "/inbox")).toBe("/app/inbox");
  });
});

describe("shared page css", () => {
  it("starts with the :root block from paletteCss and carries the shell rules", () => {
    const css = appShellCss();
    expect(css.startsWith(paletteCss())).toBe(true);
    expect(css).toContain(".app-shell{");
    expect(css).toContain(":focus-visible");
  });

  it("applies a partial brand palette", () => {
    const css = appShellCss({ name: "X", palette: { primary: "#112233" } });
    expect(css.startsWith(paletteCss({ primary: "#112233" }))).toBe(true);
    expect(css).toContain("--c-primary:#112233;");
  });
});

describe("library tabs", () => {
  it("links Artifacts and Documents and marks the current one", () => {
    const html = libraryTabsHtml("", "documents");
    expect(html).toContain('<a href="/artifacts">Artifacts</a>');
    expect(html).toContain('<a href="/toc" aria-current="page">Documents</a>');
    expect(LIBRARY_TABS_CSS).toContain(".library-tabs");
  });
});
