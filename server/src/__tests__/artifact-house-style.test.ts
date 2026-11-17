import { describe, expect, it } from "vitest";

import { designSystemStyleBlock, wrapArtifactHtml } from "../core/artifacts/render";
import { compileDesignSystem, PIDGIN_EDITORIAL } from "../core/documents/design-system";
import { BUILTIN_DESIGN_SYSTEMS } from "../core/documents/styles";

function wrap(content: string, designSystemCss?: string): string {
  return wrapArtifactHtml({
    content,
    title: "T",
    favicon: "🎨",
    artifactId: "a1",
    sourceKind: "html",
    hasCapabilities: false,
    designSystemCss,
  });
}

// A minimal valid token doc: required slots only, no dark subtree.
const LIGHT_ONLY_TOKENS = {
  color: {
    background: { $value: "#FFFFF0" },
    text: { $value: "#111111" },
    accent: { $value: "#AA0000" },
  },
  font: {
    body: { $value: ["Arial"] },
    heading: { $value: ["Georgia"] },
  },
};

// Same doc plus a dark subtree that overrides ONLY the background.
const PARTIAL_DARK_TOKENS = {
  ...LIGHT_ONLY_TOKENS,
  $extensions: { pidgin: { dark: { color: { background: { $value: "#000011" } } } } },
};

describe("artifact house style (Swiss Airmail reset)", () => {
  it("defines the house --ds-* variables and consumes them in the body", () => {
    const html = wrap("<p>hi</p>");
    expect(html).toContain("--ds-bg: #FEFCF7;");
    expect(html).toContain("--ds-text: #102335;");
    expect(html).toContain("--ds-accent: #1C5FC4;");
    expect(html).toContain("background: var(--ds-bg); color: var(--ds-text);");
  });

  it("swaps the variables in both dark guards (media query and data-theme)", () => {
    const html = wrap("<p>hi</p>");
    expect(html).toContain(':root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html.match(/--ds-bg: #0D1826;/g)?.length).toBe(2);
  });

  it("keeps the reset ahead of authored styles in complete documents", () => {
    const html = wrap(
      "<html><head><style>body{background:red}</style></head><body>x</body></html>"
    );
    expect(html.indexOf("--ds-bg")).toBeGreaterThan(-1);
    expect(html.indexOf("--ds-bg")).toBeLessThan(html.indexOf("background:red"));
  });
});

describe("designSystemStyleBlock", () => {
  // Both dark guards, separately: the media-query guard and the data-theme
  // stamp guard must EACH restate the full set, or one theme state regresses.
  function darkGuards(block: string): [string, string] {
    const stampAt = block.indexOf(':root[data-theme="dark"]');
    return [block.slice(block.indexOf("@media"), stampAt), block.slice(stampAt)];
  }

  it("restates the FULL variable set in EACH dark guard, dark tokens overlaid on light", () => {
    const block = designSystemStyleBlock(compileDesignSystem({ tokens: PARTIAL_DARK_TOKENS, css: "" }));
    for (const guard of darkGuards(block)) {
      // The overridden token…
      expect(guard).toContain("--ds-bg: #000011;");
      // …and tokens the dark subtree does NOT override, restated so the house
      // dark guard in the reset cannot bleed through.
      expect(guard).toContain("--ds-accent: #AA0000;");
      expect(guard).toContain("--ds-font-body: Arial;");
    }
    expect(block).not.toContain("color-scheme: light;");
  });

  it("pins a light-only style in both modes and declares color-scheme light", () => {
    const block = designSystemStyleBlock(compileDesignSystem({ tokens: LIGHT_ONLY_TOKENS, css: "" }));
    expect(block).toContain("color-scheme: light;");
    for (const guard of darkGuards(block)) {
      expect(guard).toContain("--ds-bg: #FFFFF0;");
    }
  });

  it("pins a single-look DARK style as dark, not light", () => {
    const tokens = {
      color: { background: { $value: "#101018" }, text: { $value: "#EEEEEE" } },
      font: { body: { $value: ["Arial"] }, heading: { $value: ["Georgia"] } },
    };
    const block = designSystemStyleBlock(compileDesignSystem({ tokens, css: "" }));
    expect(block).toContain("color-scheme: dark;");
    expect(block).not.toContain("color-scheme: light;");
  });

  it("re-emits token values containing semicolons and url() strings intact", () => {
    const tokens = {
      color: {
        background: { $value: 'url("data:image/svg+xml;base64,AA==") #FAF3E3' },
        text: { $value: "#111111" },
      },
      font: { body: { $value: ["Arial"] }, heading: { $value: ["Georgia"] } },
    };
    const block = designSystemStyleBlock(compileDesignSystem({ tokens, css: "" }));
    expect(block).toContain('--ds-bg: url("data:image/svg+xml;base64,AA==") #FAF3E3;');
    // Scheme pin comes from the trailing hex's luminance, not the url() text.
    expect(block).toContain("color-scheme: light;");
  });

  it("emits dark overrides for the editorial builtin", () => {
    const block = designSystemStyleBlock(compileDesignSystem(PIDGIN_EDITORIAL));
    expect(block).toContain("--ds-bg: #F6EEDF;");
    const darkSection = block.slice(block.indexOf("@media"));
    expect(darkSection).toContain("--ds-bg: #211A12;");
    expect(block).not.toContain("color-scheme: light;");
  });

  it("compiles every builtin style without throwing", () => {
    for (const def of BUILTIN_DESIGN_SYSTEMS) {
      const block = designSystemStyleBlock(compileDesignSystem(def));
      expect(block).toContain("--ds-bg:");
      expect(block).toContain("font-family: var(--ds-font-heading)");
    }
  });
});

describe("design-system layer in wrapped pages", () => {
  it("injects the override layer between the reset and authored styles", () => {
    const boardroom = BUILTIN_DESIGN_SYSTEMS.find((d) => d.name === "boardroom")!;
    const block = designSystemStyleBlock(compileDesignSystem(boardroom));
    const html = wrapArtifactHtml({
      content: "<html><head><style>h1{color:teal}</style></head><body><h1>x</h1></body></html>",
      title: "T",
      favicon: "🎨",
      artifactId: "a1",
      sourceKind: "html",
      hasCapabilities: false,
      designSystemCss: block,
    });
    const house = html.indexOf("--ds-bg: #FEFCF7");
    const override = html.indexOf("--ds-bg: #F8F9FB");
    const authored = html.indexOf("color:teal");
    expect(house).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(house);
    expect(authored).toBeGreaterThan(override);
  });

  it("pins mermaid to match a pinned style on fragment pages", () => {
    const lightBlock = designSystemStyleBlock(
      compileDesignSystem({ tokens: LIGHT_ONLY_TOKENS, css: "" })
    );
    const pinned = wrap('<pre class="mermaid">graph TD; a-->b</pre>', lightBlock);
    expect(pinned).toContain("var dark = false;");

    const darkBlock = designSystemStyleBlock(
      compileDesignSystem({
        tokens: {
          color: { background: { $value: "#101018" }, text: { $value: "#EEEEEE" } },
          font: { body: { $value: ["Arial"] }, heading: { $value: ["Georgia"] } },
        },
        css: "",
      })
    );
    const pinnedDark = wrap('<pre class="mermaid">graph TD; a-->b</pre>', darkBlock);
    expect(pinnedDark).toContain("var dark = true;");

    const unpinned = wrap('<pre class="mermaid">graph TD; a-->b</pre>');
    expect(unpinned).toContain("prefers-color-scheme: dark)').matches");
  });

  it("does NOT pin scheme or mermaid inside authored complete documents", () => {
    const lightBlock = designSystemStyleBlock(
      compileDesignSystem({ tokens: LIGHT_ONLY_TOKENS, css: "" })
    );
    const html = wrapArtifactHtml({
      content:
        '<html><head></head><body><pre class="mermaid">graph TD; a-->b</pre></body></html>',
      title: "T",
      favicon: "🎨",
      artifactId: "a1",
      sourceKind: "html",
      hasCapabilities: false,
      designSystemCss: lightBlock,
    });
    // The authored page owns its theme: no scheme pin, theme-following mermaid.
    expect(html).not.toContain("color-scheme: light;");
    expect(html).toContain("prefers-color-scheme: dark)').matches");
    // The style's variables still ride along for the author to build on.
    expect(html).toContain("--ds-bg: #FFFFF0;");
  });
});
