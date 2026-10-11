import type { Env } from "./types";
import type { DesignSystemDefinition } from "./documents/design-system";
import { compileDesignSystem } from "./documents/design-system";
import { BUILTIN_DESIGN_SYSTEMS } from "./documents/styles";

export interface DesignSystemPalette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  rule: string;
  positive: string;
}

export interface DesignSystemFonts {
  heading: string[];
  body: string[];
  mono: string[];
}

export interface DesignSystemSummary {
  name: string;
  display_name: string;
  description: string;
  // Narrative voice guidance for the writing agent; builtin styles only.
  voice?: string;
  // Resolved swatch data (hex palette + font family stacks) so clients can
  // render visual style pickers natively; builtin styles only.
  palette?: DesignSystemPalette;
  fonts?: DesignSystemFonts;
  source: "builtin" | "imported" | "custom";
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
// "import" is reserved because POST /api/design-systems/import shares the
// path namespace with GET/PUT/DELETE /api/design-systems/{name}.
const RESERVED_NAMES = new Set(["import", ...BUILTIN_DESIGN_SYSTEMS.map((d) => d.name)]);

export function isValidDesignSystemName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function isReservedDesignSystemName(name: string): boolean {
  return RESERVED_NAMES.has(name);
}

interface DesignSystemRow {
  name: string;
  display_name: string;
  description: string | null;
  tokens_json: string;
  css: string | null;
  source: string;
}

function rowToSummary(row: DesignSystemRow): DesignSystemSummary {
  return {
    name: row.name,
    display_name: row.display_name,
    description: row.description ?? "",
    source: row.source === "imported" ? "imported" : "custom",
  };
}

// Swatches are derived from the same compiler the typesetter uses, so a
// client gallery can never drift from real documents. Memoized: builtins are
// static for a worker's lifetime.
const swatchCache = new Map<string, { palette: DesignSystemPalette; fonts: DesignSystemFonts }>();

function builtinSwatch(def: DesignSystemDefinition): { palette: DesignSystemPalette; fonts: DesignSystemFonts } {
  const cached = swatchCache.get(def.name);
  if (cached) return cached;
  const vars: Record<string, string> = {};
  for (const m of compileDesignSystem(def).rootCss.matchAll(/(--ds-[a-z-]+):\s*([^;\n]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  const families = (stack: string | undefined): string[] =>
    (stack ?? "")
      .split(",")
      .map((f) => f.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  const swatch = {
    palette: {
      bg: vars["--ds-bg"] ?? "",
      surface: vars["--ds-surface"] ?? "",
      text: vars["--ds-text"] ?? "",
      muted: vars["--ds-text-muted"] ?? "",
      faint: vars["--ds-text-faint"] ?? "",
      accent: vars["--ds-accent"] ?? "",
      rule: vars["--ds-rule"] ?? "",
      positive: vars["--ds-positive"] ?? "",
    },
    fonts: {
      heading: families(vars["--ds-font-heading"]),
      body: families(vars["--ds-font-body"]),
      mono: families(vars["--ds-font-mono"]),
    },
  };
  swatchCache.set(def.name, swatch);
  return swatch;
}

function builtinSummary(def: DesignSystemDefinition): DesignSystemSummary {
  const { palette, fonts } = builtinSwatch(def);
  return {
    name: def.name,
    display_name: def.displayName,
    description: def.description,
    voice: def.voice,
    palette,
    fonts,
    source: "builtin",
  };
}

export async function listDesignSystems(env: Env, userId: string | null): Promise<DesignSystemSummary[]> {
  const builtins = BUILTIN_DESIGN_SYSTEMS.map(builtinSummary);
  if (!userId) return builtins;
  const result = await env.DB.prepare(
    "SELECT name, display_name, description, tokens_json, css, source FROM design_systems WHERE user_id = ? ORDER BY name"
  )
    .bind(userId)
    .all<DesignSystemRow>();
  return [...builtins, ...(result.results || []).map(rowToSummary)];
}

export async function getDesignSystem(
  env: Env,
  userId: string | null,
  name: string
): Promise<DesignSystemDefinition | null> {
  const builtin = BUILTIN_DESIGN_SYSTEMS.find((d) => d.name === name);
  if (builtin) return builtin;
  if (!userId) return null;
  const row = await env.DB.prepare(
    "SELECT name, display_name, description, tokens_json, css, source FROM design_systems WHERE user_id = ? AND name = ?"
  )
    .bind(userId, name)
    .first<DesignSystemRow>();
  if (!row) return null;
  return {
    name: row.name,
    displayName: row.display_name,
    description: row.description ?? "",
    tokens: JSON.parse(row.tokens_json) as Record<string, unknown>,
    css: row.css ?? "",
    source: row.source === "imported" ? "imported" : "custom",
  };
}

// Upserts a user design system. Name rules are enforced here so every entry
// point (MCP, HTTP, import consumer) shares them. Token/CSS validation is the
// caller's job (validateDesignSystem) so callers can surface field-level errors.
export async function putDesignSystem(
  env: Env,
  userId: string,
  input: {
    name: string;
    displayName?: string;
    description?: string;
    tokens: Record<string, unknown>;
    css?: string;
    source?: "imported" | "custom";
  }
): Promise<DesignSystemSummary> {
  if (!isValidDesignSystemName(input.name)) {
    throw new Error('design system name must match /^[a-z0-9][a-z0-9-]{1,63}$/ (kebab-case)');
  }
  if (isReservedDesignSystemName(input.name)) {
    throw new Error(`"${input.name}" is a built-in or reserved design system name`);
  }
  const summary: DesignSystemSummary = {
    name: input.name,
    display_name: input.displayName || input.name,
    description: input.description || "",
    source: input.source || "custom",
  };
  await env.DB.prepare(
    `INSERT INTO design_systems (id, user_id, name, display_name, description, tokens_json, css, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET
       display_name = excluded.display_name,
       description = excluded.description,
       tokens_json = excluded.tokens_json,
       css = excluded.css,
       source = excluded.source,
       updated_at = datetime('now')`
  )
    .bind(
      crypto.randomUUID(),
      userId,
      summary.name,
      summary.display_name,
      summary.description,
      JSON.stringify(input.tokens),
      input.css || null,
      summary.source
    )
    .run();
  return summary;
}

export async function deleteDesignSystem(env: Env, userId: string, name: string): Promise<boolean> {
  if (isReservedDesignSystemName(name)) return false;
  const result = await env.DB.prepare("DELETE FROM design_systems WHERE user_id = ? AND name = ?")
    .bind(userId, name)
    .run();
  return ((result.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
}

export async function resolveDesignSystem(
  env: Env,
  userId: string | null,
  name?: string
): Promise<DesignSystemDefinition | null> {
  return getDesignSystem(env, userId, name || "pidgin-editorial");
}
