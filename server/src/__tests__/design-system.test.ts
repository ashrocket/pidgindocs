import { describe, expect, it } from "vitest";
import {
  PIDGIN_EDITORIAL,
  compileDesignSystem,
  validateDesignSystem,
} from "../core/documents/design-system";
import { BUILTIN_DESIGN_SYSTEMS } from "../core/documents/styles";

const minimalTokens = {
  color: {
    background: { $type: "color", $value: "#101820" },
    text: { $type: "color", $value: "#F2F2F2" },
  },
  font: {
    body: { $type: "fontFamily", $value: ["Georgia", "serif"] },
    heading: { $type: "fontFamily", $value: ["Helvetica Neue", "sans-serif"] },
  },
};

describe("validateDesignSystem", () => {
  it("accepts a minimal valid token document", () => {
    expect(validateDesignSystem({ tokens: minimalTokens })).toEqual([]);
  });

  it("reports every missing required token path", () => {
    const errors = validateDesignSystem({ tokens: { color: {} } });
    expect(errors.join(" ")).toContain("color.background");
    expect(errors.join(" ")).toContain("color.text");
    expect(errors.join(" ")).toContain("font.body");
    expect(errors.join(" ")).toContain("font.heading");
  });

  it("rejects non-object token documents", () => {
    expect(validateDesignSystem({ tokens: "nope" }).length).toBeGreaterThan(0);
    expect(validateDesignSystem({ tokens: null }).length).toBeGreaterThan(0);
  });

  it("rejects oversized tokens and css", () => {
    const bigTokens = { ...minimalTokens, blob: { $value: "x".repeat(100_001) } };
    expect(validateDesignSystem({ tokens: bigTokens }).join(" ")).toContain("100");
    const bigCss = "a{}".repeat(30_000);
    expect(validateDesignSystem({ tokens: minimalTokens, css: bigCss }).join(" ")).toContain("50");
  });

  it("rejects scripts and any @import in css", () => {
    expect(
      validateDesignSystem({ tokens: minimalTokens, css: "article { } <script>alert(1)</script>" }).length
    ).toBeGreaterThan(0);
    expect(
      validateDesignSystem({ tokens: minimalTokens, css: '@import url("https://evil.example/x.css");' }).length
    ).toBeGreaterThan(0);
    expect(
      validateDesignSystem({ tokens: minimalTokens, css: '@import url("//evil.example/x.css");' }).length
    ).toBeGreaterThan(0);
    expect(
      validateDesignSystem({ tokens: minimalTokens, css: "@import 'local.css';" }).length
    ).toBeGreaterThan(0);
  });

  it("rejects a </style> breakout in css even without a <script> tag", () => {
    const errors = validateDesignSystem({
      tokens: minimalTokens,
      css: "</style><img src=x onerror=alert(1)>",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("</style>");
  });

  it("rejects a token value that breaks out of the <style> block", () => {
    const tokens = {
      ...minimalTokens,
      color: {
        ...minimalTokens.color,
        accent: { $type: "color", $value: "red</style><script>" },
      },
    };
    const errors = validateDesignSystem({ tokens });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("color.accent");
  });

  it("rejects a dark-override token value that breaks out of the <style> block", () => {
    const tokens = {
      ...minimalTokens,
      $extensions: {
        pidgin: {
          dark: { color: { background: { $value: "red</style><script>" } } },
        },
      },
    };
    const errors = validateDesignSystem({ tokens });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("color.background");
  });
});

describe("compileDesignSystem", () => {
  it("emits required vars plus fallback-chain defaults", () => {
    const { rootCss } = compileDesignSystem({ tokens: minimalTokens });
    expect(rootCss).toContain("--ds-bg: #101820");
    expect(rootCss).toContain("--ds-text: #F2F2F2");
    // fallback chain: surface falls back to background, accent to text
    expect(rootCss).toContain("--ds-surface: #101820");
    expect(rootCss).toContain("--ds-accent: #F2F2F2");
    // static default for mono
    expect(rootCss).toContain("--ds-font-mono: ui-monospace");
  });

  it("serializes fontFamily arrays, quoting names with spaces", () => {
    const { rootCss } = compileDesignSystem({ tokens: minimalTokens });
    expect(rootCss).toContain('--ds-font-heading: "Helvetica Neue", sans-serif');
    expect(rootCss).toContain("--ds-font-body: Georgia, serif");
  });

  it("resolves {alias} references against the root document", () => {
    const tokens = {
      ...minimalTokens,
      color: {
        ...minimalTokens.color,
        accent: { $type: "color", $value: "{color.text}" },
      },
    };
    const { rootCss } = compileDesignSystem({ tokens });
    expect(rootCss).toContain("--ds-accent: #F2F2F2");
  });

  it("emits dark overrides from $extensions.pidgin.dark", () => {
    const tokens = {
      ...minimalTokens,
      $extensions: {
        pidgin: {
          dark: { color: { background: { $value: "#000000" } } },
        },
      },
    };
    const { darkCss } = compileDesignSystem({ tokens });
    expect(darkCss).toContain("prefers-color-scheme: dark");
    expect(darkCss).toContain("--ds-bg: #000000");
    // dark block is partial: only overridden vars appear
    expect(darkCss).not.toContain("--ds-text:");
  });

  it("returns empty darkCss when no dark extension exists", () => {
    expect(compileDesignSystem({ tokens: minimalTokens }).darkCss).toBe("");
  });

  it("passes the css partial through verbatim", () => {
    const css = "article blockquote { border-radius: 8px; }";
    expect(compileDesignSystem({ tokens: minimalTokens, css }).partialCss).toBe(css);
  });

  it("throws on invalid input", () => {
    expect(() => compileDesignSystem({ tokens: { color: {} } })).toThrow(/color\.background/);
  });
});

describe("PIDGIN_EDITORIAL", () => {
  it("is registered as a builtin and compiles to today's palette", () => {
    expect(BUILTIN_DESIGN_SYSTEMS).toContain(PIDGIN_EDITORIAL);
    expect(PIDGIN_EDITORIAL.name).toBe("pidgin-editorial");
    const compiled = compileDesignSystem(PIDGIN_EDITORIAL);
    expect(compiled.rootCss).toContain("--ds-bg: #F6EEDF");
    expect(compiled.rootCss).toContain("--ds-accent: #B4552D");
    expect(compiled.darkCss).toContain("--ds-bg: #211A12");
    expect(compiled.darkCss).toContain("--ds-accent: #D4754E");
  });
});
