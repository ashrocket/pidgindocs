import { describe, expect, it } from "vitest";
import { compileDesignSystem, validateDesignSystem } from "../core/documents/design-system";
import { BUILTIN_DESIGN_SYSTEMS, BOARDROOM, POIGNANT, TELETYPE } from "../core/documents/styles";
import { typesetDocument } from "../core/documents/typeset";
import { isReservedDesignSystemName, listDesignSystems } from "../core/design-systems";
import type { Env } from "../core/types";

const base = {
  title: "Deploy Report",
  project: "pidgin",
  createdAt: "2026-07-17T10:00:00.000Z",
};

describe("builtin style stack", () => {
  it("ships the full stack: editorial plus at least six new styles", () => {
    expect(BUILTIN_DESIGN_SYSTEMS.length).toBeGreaterThanOrEqual(7);
    const names = BUILTIN_DESIGN_SYSTEMS.map((d) => d.name);
    expect(names).toContain("pidgin-editorial");
    expect(names).toContain("boardroom");
    expect(names).toContain("poignant");
    expect(names).toContain("solidified-sky");
    expect(new Set(names).size).toBe(names.length);
  });

  it("every builtin has display metadata, a narrative voice, and a reserved name", () => {
    for (const def of BUILTIN_DESIGN_SYSTEMS) {
      expect(def.displayName.length, def.name).toBeGreaterThan(0);
      expect(def.description.length, def.name).toBeGreaterThan(0);
      expect((def.voice ?? "").length, `${def.name} needs a voice`).toBeGreaterThan(40);
      expect(def.source).toBe("builtin");
      expect(isReservedDesignSystemName(def.name), def.name).toBe(true);
    }
  });

  it("every builtin validates and compiles", () => {
    for (const def of BUILTIN_DESIGN_SYSTEMS) {
      expect(validateDesignSystem(def), def.name).toEqual([]);
      const compiled = compileDesignSystem(def);
      expect(compiled.rootCss, def.name).toContain("--ds-bg:");
      expect(compiled.rootCss, def.name).toContain("--ds-accent:");
    }
  });

  it("new styles are light-only; only pidgin-editorial keeps a dark variant", () => {
    for (const def of BUILTIN_DESIGN_SYSTEMS) {
      const { darkCss } = compileDesignSystem(def);
      if (def.name === "pidgin-editorial") {
        expect(darkCss).toContain("prefers-color-scheme: dark");
      } else {
        expect(darkCss, `${def.name} must not ship a dark palette`).toBe("");
      }
    }
  });

  it("css animations are gated on prefers-reduced-motion or the data-fx reveal hook", () => {
    for (const def of BUILTIN_DESIGN_SYSTEMS) {
      if (!def.css.includes("animation")) continue;
      expect(def.css, def.name).toContain("prefers-reduced-motion: no-preference");
    }
    // reveal styles must never leak hidden content into print
    for (const def of BUILTIN_DESIGN_SYSTEMS) {
      if (!def.css.includes("html[data-fx]")) continue;
      expect(def.css, def.name).toContain("@media print");
    }
  });

  it("effects scripts respect reduced motion, stay self-contained, and cannot break the script tag", () => {
    const withEffects = BUILTIN_DESIGN_SYSTEMS.filter((d) => d.effects);
    expect(withEffects.length).toBeGreaterThanOrEqual(6);
    for (const def of withEffects) {
      const fx = def.effects!;
      expect(fx, def.name).toContain("prefers-reduced-motion: reduce");
      expect(fx, def.name).not.toMatch(/<\/script/i);
      expect(fx, def.name).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
      // the only allowed import is the same-origin cuelume module
      expect(fx.replace(/import\("\/a\/assets\/cuelume\.js"\)/g, ""), def.name).not.toMatch(/import\(/);
      expect(fx.length, def.name).toBeLessThan(8000);
    }
  });

  it("sound is strictly opt-in: toggle injected, default off, module loaded lazily", () => {
    const withAudio = BUILTIN_DESIGN_SYSTEMS.filter((d) => d.effects?.includes("pidgin-audio-toggle"));
    expect(withAudio.map((d) => d.name).sort()).toEqual(
      ["boardroom", "gazette", "poignant", "riso", "solidified-sky", "sumi", "teletype"]
    );
    for (const def of withAudio) {
      const fx = def.effects!;
      // off unless the reader explicitly stored "on"
      expect(fx, def.name).toContain('localStorage.getItem(KEY) === "on"');
      expect(fx, def.name).toContain('import("/a/assets/cuelume.js")');
      // every audio map names its enable-confirmation cue
      expect(fx, def.name).toMatch(/"enable":"[a-z]+"/);
    }
  });

  it("compileDesignSystem rejects an effects script containing </script", () => {
    expect(() =>
      compileDesignSystem({ ...BOARDROOM, effects: 'var s = "</script>";' })
    ).toThrow(/effects/);
  });

  it("listDesignSystems surfaces the voice on builtin summaries", async () => {
    const systems = await listDesignSystems({} as Env, null);
    const poignant = systems.find((s) => s.name === "poignant");
    expect(poignant?.voice).toMatch(/_why/);
    expect(poignant?.source).toBe("builtin");
  });
});

describe("typesetDocument with styled stack", () => {
  it("injects the effects script for styles that carry one", () => {
    const html = typesetDocument({ ...base, markdown: "hello **world**" }, compileDesignSystem(TELETYPE));
    expect(html).toContain("IntersectionObserver");
    expect(html).toContain("prefers-reduced-motion: reduce");
  });

  it("does not inject any script for the default editorial style", () => {
    const html = typesetDocument({ ...base, markdown: "hello" });
    expect(html).not.toContain("IntersectionObserver");
  });

  it("declares color-scheme light for light-only styles and light dark for editorial", () => {
    const teletype = typesetDocument({ ...base, markdown: "x" }, compileDesignSystem(TELETYPE));
    expect(teletype).toContain('<meta name="color-scheme" content="light">');
    const editorial = typesetDocument({ ...base, markdown: "x" });
    expect(editorial).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("renders mermaid fences as pre.mermaid and injects the same-origin renderer", () => {
    const markdown = "intro\n\n```mermaid\ngraph TD; A-->B;\n```\n";
    const html = typesetDocument({ ...base, markdown }, compileDesignSystem(BOARDROOM));
    expect(html).toMatch(/<pre class="mermaid">graph TD; A-->B;\s*<\/pre>/);
    expect(html).toContain('<script src="/a/assets/mermaid.js" defer></script>');
    // light-only style pins the neutral theme — no OS-driven dark diagrams
    expect(html).toContain("theme: 'neutral'");
    expect(html).not.toContain("prefers-color-scheme: dark)').matches ? 'dark'");
  });

  it("editorial mermaid follows the page's dark variant", () => {
    const markdown = "```mermaid\ngraph TD; A-->B;\n```";
    const html = typesetDocument({ ...base, markdown });
    expect(html).toContain("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral'");
  });

  it("omits the mermaid renderer when no fence is present", () => {
    const html = typesetDocument({ ...base, markdown: "no diagrams here" }, compileDesignSystem(BOARDROOM));
    expect(html).not.toContain("mermaid.js");
  });

  it("poignant style keeps its squiggle self-contained (data URI, no external URLs)", () => {
    expect(POIGNANT.css).toContain("data:image/svg+xml");
    expect(POIGNANT.css).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it("settings page renders the visual style gallery", async () => {
    const { setupPage } = await import("../core/web/index");
    const status = {
      ready: true,
      currentStep: "done",
      microsoft365: { configured: true },
      onedrive: { configured: true },
      commute: { configured: true },
      gchat: { configured: false },
      matrix: { configured: false },
      push: { apns_configured: true, device_count: 1 },
    } as never;
    const html = await setupPage(status).text();
    expect(html).toContain("Explore document styles");
    for (const def of BUILTIN_DESIGN_SYSTEMS) {
      expect(html).toContain(`>${def.name}</code>`);
    }
    // specimen cards carry the real palette, not hardcoded chrome colors
    expect(html).toContain("#FFF8E7"); // poignant paper
    expect(html).toContain("#F6F3EA"); // teletype ivory
  });
});
