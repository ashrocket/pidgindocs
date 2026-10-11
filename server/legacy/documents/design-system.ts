// W3C DTCG (Design Tokens Community Group) design systems for PidginDocs
// documents. A design system = a DTCG token document + an optional
// component-CSS partial. The compiler flattens tokens into the --ds-* CSS
// custom properties that the base document stylesheet (typeset.ts) consumes.
// Dark mode: token overrides under $extensions.pidgin.dark are emitted inside
// @media (prefers-color-scheme: dark).

export interface DesignSystemDefinition {
  name: string;
  displayName: string;
  description: string;
  // Narrative voice the writing agent adopts when authoring markdown for this
  // style. Surfaced through list/get so agents can match prose to palette.
  voice?: string;
  tokens: Record<string, unknown>;
  css: string;
  // Inline effects script injected into typeset pages (scroll reveals, title
  // treatments). Builtin styles only: the user storage path persists tokens +
  // css and never round-trips effects, so stored systems cannot carry script.
  effects?: string;
  source: "builtin" | "imported" | "custom";
}

export interface CompiledDesignSystem {
  rootCss: string;
  darkCss: string;
  partialCss: string;
  effectsJs: string;
  // The same variables as structured pairs, so consumers that re-emit them
  // (the artifact style layer) never have to parse CSS text — values may
  // legally contain ';', newlines, or url(...) strings.
  rootVars: Array<{ name: string; value: string }>;
  darkVars: Array<{ name: string; value: string }>;
}

interface TokenSlot {
  path: string;
  cssVar: string;
  fallbackPath?: string;
  staticDefault?: string;
  required?: boolean;
}

// The full token → CSS variable contract. Fallback chains keep minimal token
// documents renderable; only the four `required` paths must exist.
const TOKEN_SLOTS: TokenSlot[] = [
  { path: "color.background", cssVar: "--ds-bg", required: true },
  { path: "color.surface", cssVar: "--ds-surface", fallbackPath: "color.background" },
  { path: "color.text", cssVar: "--ds-text", required: true },
  { path: "color.text-muted", cssVar: "--ds-text-muted", fallbackPath: "color.text" },
  { path: "color.text-faint", cssVar: "--ds-text-faint", fallbackPath: "color.text-muted" },
  { path: "color.accent", cssVar: "--ds-accent", fallbackPath: "color.text" },
  { path: "color.rule", cssVar: "--ds-rule", fallbackPath: "color.text-faint" },
  { path: "color.positive", cssVar: "--ds-positive", fallbackPath: "color.accent" },
  { path: "font.body", cssVar: "--ds-font-body", required: true },
  { path: "font.heading", cssVar: "--ds-font-heading", required: true },
  { path: "font.mono", cssVar: "--ds-font-mono", staticDefault: 'ui-monospace, "SF Mono", Menlo, monospace' },
];

const MAX_TOKENS_BYTES = 100_000;
const MAX_CSS_BYTES = 50_000;
const MAX_ALIAS_DEPTH = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenNodeAt(tree: Record<string, unknown>, path: string): Record<string, unknown> | null {
  let node: unknown = tree;
  for (const part of path.split(".")) {
    if (!isPlainObject(node)) return null;
    node = node[part];
  }
  return isPlainObject(node) ? node : null;
}

function serializeTokenValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const families = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (!families.length) return null;
    return families
      .map((family) => (/[^a-zA-Z0-9-]/.test(family) ? `"${family}"` : family))
      .join(", ");
  }
  return null;
}

// Resolves a token path to its serialized CSS value. `lookupTree` is where the
// path itself is looked up (the root doc, or the dark subtree); {alias}
// references always resolve against the root document.
function resolveTokenValue(
  lookupTree: Record<string, unknown>,
  rootTokens: Record<string, unknown>,
  path: string,
  depth = 0
): string | null {
  if (depth > MAX_ALIAS_DEPTH) return null;
  const node = tokenNodeAt(lookupTree, path);
  if (!node || !("$value" in node)) return null;
  const raw = node.$value;
  if (typeof raw === "string") {
    const alias = raw.trim().match(/^\{([a-zA-Z0-9.$_-]+)\}$/);
    if (alias) return resolveTokenValue(rootTokens, rootTokens, alias[1], depth + 1);
  }
  return serializeTokenValue(raw);
}

function darkSubtree(tokens: Record<string, unknown>): Record<string, unknown> | null {
  const extensions = tokens.$extensions;
  if (!isPlainObject(extensions)) return null;
  const pidgin = extensions.pidgin;
  if (!isPlainObject(pidgin)) return null;
  return isPlainObject(pidgin.dark) ? pidgin.dark : null;
}

export function validateDesignSystem(input: { tokens: unknown; css?: string }): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input.tokens)) {
    return ["tokens must be a JSON object (a W3C DTCG token document)"];
  }
  if (JSON.stringify(input.tokens).length > MAX_TOKENS_BYTES) {
    errors.push(`tokens document exceeds ${MAX_TOKENS_BYTES / 1000}KB limit`);
  }
  for (const slot of TOKEN_SLOTS) {
    if (!slot.required) continue;
    if (resolveTokenValue(input.tokens, input.tokens, slot.path) === null) {
      errors.push(`required token "${slot.path}" is missing or unresolvable`);
    }
  }
  const dark = darkSubtree(input.tokens);
  if (dark === null && isPlainObject(input.tokens.$extensions) &&
      isPlainObject((input.tokens.$extensions as Record<string, unknown>).pidgin) &&
      "dark" in ((input.tokens.$extensions as Record<string, unknown>).pidgin as Record<string, unknown>)) {
    errors.push("$extensions.pidgin.dark must be an object of token overrides");
  }

  // Token values are emitted verbatim into a <style> block (compileDesignSystem),
  // so any value carrying '<' or '>' could break out of the style element. Check
  // every slot's resolved value in both the root document and the dark subtree.
  for (const slot of TOKEN_SLOTS) {
    const rootValue = resolveTokenValue(input.tokens, input.tokens, slot.path);
    if (rootValue !== null && /[<>]/.test(rootValue)) {
      errors.push(`token "${slot.path}" value may not contain '<' or '>'`);
    }
    if (dark) {
      const darkValue = resolveTokenValue(dark, input.tokens, slot.path);
      if (darkValue !== null && /[<>]/.test(darkValue)) {
        errors.push(`token "$extensions.pidgin.dark.${slot.path}" value may not contain '<' or '>'`);
      }
    }
  }

  const css = input.css ?? "";
  if (css.length > MAX_CSS_BYTES) {
    errors.push(`css partial exceeds ${MAX_CSS_BYTES / 1000}KB limit`);
  }
  if (/<\s*script/i.test(css)) {
    errors.push("css partial may not contain <script>");
  }
  if (/<\/style/i.test(css)) {
    errors.push("css partial may not contain </style>");
  }
  if (/@import/i.test(css)) {
    errors.push("css partial may not use @import (documents are self-contained)");
  }
  return errors;
}

export function compileDesignSystem(def: {
  tokens: Record<string, unknown>;
  css?: string;
  effects?: string;
}): CompiledDesignSystem {
  const errors = validateDesignSystem({ tokens: def.tokens, css: def.css });
  if (errors.length) {
    throw new Error(`invalid design system: ${errors.join("; ")}`);
  }
  // The effects script is emitted verbatim inside a <script> element; a
  // literal "</script" would terminate it mid-source.
  if (def.effects && /<\/script/i.test(def.effects)) {
    throw new Error("invalid design system: effects script may not contain </script");
  }

  const rootVars: Array<{ name: string; value: string }> = [];
  for (const slot of TOKEN_SLOTS) {
    let value = resolveTokenValue(def.tokens, def.tokens, slot.path);
    if (value === null && slot.fallbackPath) {
      // Walk the declared fallback chain until a token resolves.
      let fallback: TokenSlot | undefined = TOKEN_SLOTS.find((s) => s.path === slot.fallbackPath);
      while (value === null && fallback) {
        value = resolveTokenValue(def.tokens, def.tokens, fallback.path);
        fallback = fallback.fallbackPath ? TOKEN_SLOTS.find((s) => s.path === fallback!.fallbackPath) : undefined;
      }
    }
    if (value === null && slot.staticDefault) value = slot.staticDefault;
    if (value !== null) rootVars.push({ name: slot.cssVar, value });
  }

  const dark = darkSubtree(def.tokens);
  const darkVars: Array<{ name: string; value: string }> = [];
  if (dark) {
    for (const slot of TOKEN_SLOTS) {
      const value = resolveTokenValue(dark, def.tokens, slot.path);
      if (value !== null) darkVars.push({ name: slot.cssVar, value });
    }
  }

  return {
    rootCss: `:root {\n${rootVars.map((v) => `  ${v.name}: ${v.value};`).join("\n")}\n}`,
    darkCss: darkVars.length
      ? `@media (prefers-color-scheme: dark) {\n  :root {\n${darkVars.map((v) => `    ${v.name}: ${v.value};`).join("\n")}\n  }\n}`
      : "",
    partialCss: def.css ?? "",
    effectsJs: def.effects ?? "",
    rootVars,
    darkVars,
  };
}

// Today's hardcoded editorial theme, extracted verbatim from typeset.ts so the
// default rendering is visually unchanged.
export const PIDGIN_EDITORIAL: DesignSystemDefinition = {
  name: "pidgin-editorial",
  displayName: "PidginDocs Editorial",
  description: "Warm paper & ink editorial typography — PidginDocs's default document style.",
  voice:
    "The house voice: a good broadsheet's briefing column. Clear declarative sentences, " +
    "structured sections, restrained emphasis. State what happened, why it matters, and " +
    "what comes next — in that order. Let the facts carry the tone.",
  source: "builtin",
  css: "",
  tokens: {
    color: {
      background: { $type: "color", $value: "#F6EEDF" },
      surface: { $type: "color", $value: "#EDE0C8" },
      text: { $type: "color", $value: "#281D14" },
      "text-muted": { $type: "color", $value: "#5C4F42" },
      "text-faint": { $type: "color", $value: "#8A7B6B" },
      accent: { $type: "color", $value: "#B4552D" },
      rule: { $type: "color", $value: "#D8C9B0" },
      positive: { $type: "color", $value: "#4F6B45" },
    },
    font: {
      body: { $type: "fontFamily", $value: ["Iowan Old Style", "Charter", "Palatino", "Georgia", "serif"] },
      heading: { $type: "fontFamily", $value: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "sans-serif"] },
      mono: { $type: "fontFamily", $value: ["ui-monospace", "SF Mono", "Menlo", "monospace"] },
    },
    $extensions: {
      pidgin: {
        dark: {
          color: {
            background: { $value: "#211A12" },
            surface: { $value: "#2C231A" },
            text: { $value: "#EDE3D2" },
            "text-muted": { $value: "#BFB09C" },
            "text-faint": { $value: "#8A7B6B" },
            accent: { $value: "#D4754E" },
            rule: { $value: "#3D3225" },
            positive: { $value: "#8FAE7E" },
          },
        },
      },
    },
  },
};

// The full builtin style stack (this file's PIDGIN_EDITORIAL plus the styles
// module's palettes) is assembled in ./styles.ts to keep this file focused on
// the token compiler. Import BUILTIN_DESIGN_SYSTEMS from "./styles".
