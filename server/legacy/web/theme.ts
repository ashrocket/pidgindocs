// PidginDocs web design tokens: the original palette. Moss green for actions,
// terra orange for attention, brown ink on cream.
//
// This object is the default Palette. Page functions import `theme` and
// interpolate `${theme.ink}` and so on instead of hardcoding hex literals;
// another edition supplies its own values through resolvePalette and paletteCss.
//
// Every text role keeps 4.5:1 on each surface and on its own tinted
// background, and the focus ring keeps 3:1 on each surface.
// server/legacy/__tests__/theme-contrast.test.ts enforces both.

export const theme = {
  // Text
  ink: "#2B1F18", // primary text
  muted: "#6B5446", // secondary text
  dim: "#726154", // tertiary and metadata text, the AA floor

  // Surfaces
  paper: "#F7ECDB", // card and panel background
  sand: "#F0E1CF", // page background
  surface: "#FAF4E8", // lightest surface
  line: "#E0CDB4", // borders and decorative strokes, never text
  borderLight: "#E8D7C2", // lighter form-input borders

  // Primary action (fills/borders only — never inline text)
  primary: "#5A6B3A", // buttons and primary fills, never inline text
  primaryDeep: "#3D4A22", // pressed and hover state

  // Accent / link (inline text only — never a button fill)
  accent: "#48687E", // inline links and the unread-row border, never a button fill

  // Attention (routine, non-alarm — waiting states, "Required" markers)
  attention: "#A64724", // waiting states and "Required" markers
  attentionDeep: "#8E3818",
  attentionBg: "#F6E1D4", // tinted background for the "Required" badge

  // Notice
  notice: "#915616",
  noticeBg: "#F5E6CC",

  // Error / urgent
  error: "#8E3818",
  errorBg: "#F4DDD2",

  // Badges — one bg/text pair per message type + the answered variant,
  // each independently contrast-checked against its own bg
  badgeMessageBg: "#E8DCC8",
  badgeMessageText: "#2B1F18",
  badgeQuestionBg: "#F3E3C8",
  badgeQuestionText: "#7A4A0E",
  badgeDocumentBg: "#DFE6EA",
  badgeDocumentText: "#33566E",
  badgeStatusBg: "#E0CDB4",
  badgeStatusText: "#5A4638",
  badgeAnsweredBg: "#D4DFD0",
  badgeAnsweredText: "#3D4A22",

  // Reply-state indicators
  live: "#4F6645", // filled capsule, white text: the one live state
  idle: "#746337", // small-caps tinted label
  never: "#726154", // small-caps quiet label

  // Focus ring
  focus: "#C8552B", // focus ring
} as const;

export type Palette = Record<keyof typeof theme, string>;

// CSS hex colours have 3, 4, 6 or 8 digits.
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Returns a full palette from a partial one, in theme order.
// Every value is either a validated hex colour from the input or the default.
export function resolvePalette(palette: Partial<Palette> = theme): Palette {
  const resolved = {} as Palette;
  for (const role of Object.keys(theme) as (keyof Palette)[]) {
    const given: unknown = palette[role];
    resolved[role] = typeof given === "string" && HEX_COLOUR.test(given) ? given : theme[role];
  }
  return resolved;
}

// Emits a palette as CSS custom properties on :root.
// Invalid values fall back to the default in `theme`.
export function paletteCss(palette: Partial<Palette> = theme): string {
  const resolved = resolvePalette(palette);
  let css = ":root{";
  for (const role of Object.keys(theme) as (keyof Palette)[]) {
    const name = role.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    css += `--c-${name}:${resolved[role]};`;
  }
  return css + "}";
}
