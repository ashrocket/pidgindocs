// Palette contract shared by every edition: one object in, one :root block out.
// Assertions read values from `theme` so the same file passes on any default palette.
import { describe, expect, it } from "vitest";
import { paletteCss, resolvePalette, theme, type Palette } from "../web/theme";

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const roles = Object.keys(theme) as (keyof Palette)[];
const kebab = (role: string) => role.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const decl = (role: keyof Palette, value: string) => `--c-${kebab(role)}:${value};`;
const without = (role: string) =>
  Object.fromEntries(Object.entries(theme).filter(([key]) => key !== role)) as unknown as Palette;

describe("palette contract", () => {
  it("has 32 roles, focus last, every default a hex colour", () => {
    expect(roles).toHaveLength(32);
    expect(roles[roles.length - 1]).toBe("focus");
    for (const role of roles) expect(theme[role]).toMatch(HEX);
  });

  it("emits one :root block with every role in theme order", () => {
    const expected = ":root{" + roles.map((role) => decl(role, theme[role])).join("") + "}";
    expect(paletteCss(theme)).toBe(expected);
    expect(paletteCss()).toBe(expected);
  });

  it("names variables --c- plus the kebab-case role", () => {
    const css = paletteCss(theme);
    expect(css).toContain(`--c-ink:${theme.ink};`);
    expect(css).toContain(`--c-primary-deep:${theme.primaryDeep};`);
    expect(css).toContain(`--c-border-light:${theme.borderLight};`);
    expect(css).toContain(`--c-badge-message-bg:${theme.badgeMessageBg};`);
    expect(css).toContain(`--c-focus:${theme.focus};`);
  });

  it("writes a brand's own values", () => {
    const brand: Palette = { ...theme, primary: "#AbC", focus: "#11223344" };
    const css = paletteCss(brand);
    expect(css).toContain("--c-primary:#AbC;");
    expect(css).toContain("--c-focus:#11223344;");
    expect(css).toContain(`--c-ink:${theme.ink};`);
  });

  it.each([
    "red;}body{display:none",
    "#12",
    "#123456789",
    "rgb(0,0,0)",
    "",
    " #102335",
    "#10233G",
    "#102335;",
    "#102335\n",
  ])("falls back to the default for %j", (bad) => {
    expect(paletteCss({ ...theme, primary: bad })).toBe(paletteCss(theme));
  });

  it("falls back for a missing or non-string role", () => {
    expect(paletteCss(without("primary"))).toBe(paletteCss(theme));
    expect(paletteCss({ ...theme, primary: 42 } as unknown as Palette)).toBe(paletteCss(theme));
    expect(paletteCss({ ...theme, primary: null } as unknown as Palette)).toBe(paletteCss(theme));
  });

  it("ignores roles the default palette does not have", () => {
    const extra = { ...theme, evil: "#000000", "x;}body{": "#000" } as unknown as Palette;
    expect(paletteCss(extra)).toBe(paletteCss(theme));
  });

  it("does not change the palette it is given", () => {
    const brand = { ...theme, primary: "nope" };
    const before = JSON.stringify(brand);
    paletteCss(brand);
    expect(JSON.stringify(brand)).toBe(before);
  });

  it("resolves a partial palette to a full one in theme order", () => {
    const full = resolvePalette({ primary: "#AbC" });
    expect(Object.keys(full)).toEqual(Object.keys(theme));
    expect(full.primary).toBe("#AbC");
    expect(full.ink).toBe(theme.ink);
  });

  it("resolves nothing, an empty object and the default to the default", () => {
    expect(resolvePalette()).toEqual({ ...theme });
    expect(resolvePalette(undefined)).toEqual({ ...theme });
    expect(resolvePalette({})).toEqual({ ...theme });
    expect(resolvePalette(theme)).toEqual({ ...theme });
  });

  it("resolves invalid, undefined and unknown entries away", () => {
    const messy = { primary: "red;}body{display:none", ink: undefined, evil: "#000000" };
    expect(resolvePalette(messy as unknown as Partial<Palette>)).toEqual({ ...theme });
  });

  it("returns a new object and leaves its input and the default alone", () => {
    const input = { primary: "#123456" };
    const defaultPrimary = theme.primary;
    const full = resolvePalette(input);
    expect(full).not.toBe(theme);
    full.primary = "#010203";
    expect(theme.primary).toBe(defaultPrimary);
    expect(input).toEqual({ primary: "#123456" });
  });

  it("emits a partial palette the same as its resolved form", () => {
    const partial = { primary: "#AbC", focus: "#11223344" };
    expect(paletteCss(partial)).toBe(paletteCss(resolvePalette(partial)));
    expect(paletteCss(partial)).toContain("--c-primary:#AbC;");
    expect(paletteCss({})).toBe(paletteCss(theme));
  });
});
