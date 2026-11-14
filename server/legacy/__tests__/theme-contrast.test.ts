// Contrast floor for the default PidginDocs palette, by the WCAG 2 relative-luminance formula.
// Text roles need 4.5:1 on whatever they sit on; the focus ring needs 3:1 against each surface.
import { describe, expect, it } from "vitest";
import { theme } from "../web/theme";

function luminance(hex: string): number {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? digits.split("").map((c) => c + c).join("") : digits.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(full.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const surfaces = [theme.surface, theme.paper, theme.sand];

describe("default palette contrast", () => {
  it("measures black on white as 21 to 1", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#FFF", "#000")).toBeCloseTo(21, 5);
  });

  it.each([
    "ink",
    "muted",
    "dim",
    "accent",
    "attention",
    "attentionDeep",
    "notice",
    "error",
    "idle",
    "never",
  ] as const)("%s is readable as text on every surface", (role) => {
    for (const surface of surfaces) expect(contrast(theme[role], surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["attention", "attentionBg"],
    ["notice", "noticeBg"],
    ["error", "errorBg"],
    ["badgeMessageText", "badgeMessageBg"],
    ["badgeQuestionText", "badgeQuestionBg"],
    ["badgeDocumentText", "badgeDocumentBg"],
    ["badgeStatusText", "badgeStatusBg"],
    ["badgeAnsweredText", "badgeAnsweredBg"],
  ] as const)("%s is readable on %s", (text, background) => {
    expect(contrast(theme[text], theme[background])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["primary", "primaryDeep", "live"] as const)("white text is readable on %s", (role) => {
    expect(contrast("#FFFFFF", theme[role])).toBeGreaterThanOrEqual(4.5);
  });

  it("the focus ring stands out from every surface", () => {
    for (const surface of surfaces) expect(contrast(theme.focus, surface)).toBeGreaterThanOrEqual(3);
  });
});
