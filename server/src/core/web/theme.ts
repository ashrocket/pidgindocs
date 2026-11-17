// Light surfaces, teal actions, and warm sand accents.
// Shared semantic roles keep the existing document/inbox functionality consistent.
export const theme = {
  ink: "#183c3c", muted: "#506968", dim: "#647672",
  paper: "#FFFFFF", sand: "#eaf2f2", surface: "#f8fbfa",
  line: "#c6d9d6", borderLight: "#dae6e3",
  primary: "#2c6362", primaryDeep: "#204d4c", accent: "#246361",
  attention: "#865b2b", attentionDeep: "#69431c", attentionBg: "#f5ecdf",
  notice: "#805929", noticeBg: "#f5ecdf",
  error: "#a13d38", errorBg: "#fbeceb",
  badgeMessageBg: "#eaf2f2", badgeMessageText: "#2c6362",
  badgeQuestionBg: "#f5ecdf", badgeQuestionText: "#805929",
  badgeDocumentBg: "#e8f1ec", badgeDocumentText: "#376851",
  badgeStatusBg: "#edf0f4", badgeStatusText: "#52647a",
  badgeAnsweredBg: "#e8f1ec", badgeAnsweredText: "#376851",
  live: "#2c6362", idle: "#805929", never: "#647672",
  focus: "#d9b88f",
} as const;

/** A full set of theme colours, keyed by the same roles as `theme`. */
export type Palette = Record<keyof typeof theme, string>;

const HEX_COLOUR = /^#[0-9a-fA-F]{3,8}$/;

/**
 * Returns a full palette in theme order. Each role keeps the given value only when
 * it is a hex colour string; otherwise it takes the default. Never mutates its input.
 */
export function resolvePalette(palette: Partial<Palette> = theme): Palette {
  const resolved = {} as Palette;
  for (const role of Object.keys(theme) as (keyof Palette)[]) {
    const given: unknown = palette[role];
    resolved[role] = typeof given === "string" && HEX_COLOUR.test(given) ? given : theme[role];
  }
  return resolved;
}

/**
 * Renders the theme as one `:root` rule of `--c-*` custom properties. Overrides
 * are used only when they are plain hex colours, so a palette value cannot
 * close the rule and inject other CSS.
 */
export function paletteCss(palette: Partial<Palette> = {}): string {
  const resolved = resolvePalette(palette);
  const declarations = (Object.keys(theme) as (keyof Palette)[]).map((role) => {
    const name = role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    return `--c-${name}:${resolved[role]};`;
  });
  return `:root{${declarations.join("")}}`;
}
