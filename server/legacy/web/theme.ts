// PidginDocs web design tokens — Swiss-airmail palette (2026 rebrand).
//
// Single source of truth for the app's own chrome. Page functions should
// import `theme` and interpolate `${theme.ink}` etc. into their
// template-literal HTML/CSS instead of hardcoding hex literals.
//
// Every hex here is identical, role for role, to final-tokens.md §2a (web)
// and, for the 11 semantic roles, to final-tokens.md §1a (Swift) — do not
// let these drift apart. See final-tokens.md for the full rationale,
// contrast verification, and OLD_HEX -> theme.KEY migration table.

export const theme = {
  // Text
  ink: "#102335", // primary text
  muted: "#405A77", // secondary text (Swift inkSoft)
  dim: "#6D6555", // tertiary/metadata text — the AA floor (Swift inkMute/brass)

  // Surfaces
  paper: "#FBF7EF", // card/panel background (= anchor paper)
  sand: "#F3ECDF", // page background (= anchor cream)
  surface: "#FEFCF7", // lightest surface (Swift `cream`)
  line: "#C6BCA9", // borders, decorative strokes — chrome only, never text
  borderLight: "#DEDBD3", // lighter form-input borders

  // Primary action (fills/borders only — never inline text)
  primary: "#082F5A", // buttons, primary fills (= anchor navy, Swift moss)
  primaryDeep: "#062648", // pressed/hover state (Swift mossDeep)

  // Accent / link (inline text only — never a button fill)
  accent: "#1C5FC4", // "more" links, unread-row left border, inline links (Swift sky)

  // Attention (routine, non-alarm — waiting states, "Required" markers)
  attention: "#96462C", // Swift terra
  attentionDeep: "#703421", // Swift terraDeep
  attentionBg: "#F1E5DC", // tinted background for the "Required" badge

  // Notice
  notice: "#8F531E", // Swift amber
  noticeBg: "#F0E7DA",

  // Error / urgent (the only role drawn from anchor red for routine, non-icon use)
  error: "#7E2E25",
  errorBg: "#EEE3DB",

  // Badges — one bg/text pair per message type + the answered variant,
  // each independently contrast-checked against its own bg (§3)
  badgeMessageBg: "#E3E3E0",
  badgeMessageText: "#082F5A",
  badgeQuestionBg: "#EFE8D9",
  badgeQuestionText: "#825D17",
  badgeDocumentBg: "#E6E8E3",
  badgeDocumentText: "#2D5E76",
  badgeStatusBg: "#E9E8E4",
  badgeStatusText: "#476185",
  badgeAnsweredBg: "#E7E9E6",
  badgeAnsweredText: "#306791",

  // Reply-state indicators
  live: "#1763A1", // filled capsule bg, white text — the one live/actionable state
  idle: "#7C613C", // small-caps tinted label
  never: "#5E656E", // small-caps tinted label, cool quiet neutral
} as const;
