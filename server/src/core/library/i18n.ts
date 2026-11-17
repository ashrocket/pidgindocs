import en from "./i18n/en.json";
import ru from "./i18n/ru.json";
import sv from "./i18n/sv.json";
import es from "./i18n/es.json";

export const libraryCatalogs = { en, ru, sv, es };
export type LibraryLanguage = keyof typeof libraryCatalogs;
type LibraryKey = keyof typeof en;

/** Labels come from the stored catalogs only; a key missing from one language falls back to English. */
export async function libraryTranslator(request: Request) {
  const requested = new URL(request.url).searchParams.get("lang")
    ?? request.headers.get("Accept-Language")?.split(",")[0]?.split("-")[0] ?? "en";
  const language: LibraryLanguage = Object.hasOwn(libraryCatalogs, requested) ? requested as LibraryLanguage : "en";
  const catalog: Record<string, string> = libraryCatalogs[language];
  return { language, t: (key: LibraryKey) => String(catalog[key] ?? en[key]), catalog: libraryCatalogs[language] };
}
