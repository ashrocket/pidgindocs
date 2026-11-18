import type { Env } from "./types";

export const TRANSLATION_LANGUAGES = { en: "English", es: "Spanish", ru: "Russian", sv: "Swedish" } as const;
export type Language = keyof typeof TRANSLATION_LANGUAGES;
const DEFAULT_LANGUAGES: readonly Language[] = ["en", "ru", "sv"];

/** Tenant configuration owns the allowlist. Unconfigured installs keep their existing languages. */
export function translationLanguages(env?: Pick<Env, "WEB_LANGUAGES">): readonly Language[] {
  if (env?.WEB_LANGUAGES === undefined) return DEFAULT_LANGUAGES;
  const languages = [...new Set(env.WEB_LANGUAGES.split(",").map(value => value.trim()))];
  if (!languages.includes("en") || !languages.every(value => Object.hasOwn(TRANSLATION_LANGUAGES, value))) {
    throw new Error("Invalid WEB_LANGUAGES configuration");
  }
  return languages as Language[];
}
