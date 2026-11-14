import type { Palette } from "./theme";
import { paletteCss } from "./theme";

/** A top-level destination in the shell's place row. */
export type Place = "workspace" | "inbox" | "library";

/** An extra account-menu entry supplied by the page that renders the shell. */
export interface ShellLink {
  key: string;
  label: string;
  href: string;
}

/**
 * The product mark and colours a shell is drawn with. `name` is plain text and is escaped.
 * `mark` is a final app-relative path to a square image, base already included. It is
 * validated (starts with "/", not "//", no backslash, whitespace or control character) and
 * escaped, never markup.
 */
export interface Brand {
  name: string;
  mark?: string;
  palette?: Partial<Palette>;
}

/** Inputs to the shared page header. Every field is optional. */
export interface AppShellOptions {
  brand?: Brand;
  base?: string;
  active?: Place | "";
  places?: readonly Place[];
  menu?: readonly ShellLink[];
  activeMenu?: string;
}

/** What a deployment supplies for the shell: brand, place row and account menu (Sign out is always added). */
export interface ShellConfig {
  brand?: Brand;
  places?: readonly Place[];
  menu?: readonly ShellLink[];
}

/** Places rendered when a page does not ask for a specific set. */
export const DEFAULT_PLACES: readonly Place[] = ["workspace", "inbox", "library"];

/** Joins a mount prefix and an app path. This app is served from the root, so callers pass "". */
export function appPath(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function allPlaces(base: string): ReadonlyArray<{ key: Place; label: string; href: string }> {
  return [
    { key: "workspace", label: "Workspace", href: appPath(base, "/workspace") },
    { key: "inbox", label: "Inbox", href: appPath(base, "/inbox") },
    { key: "library", label: "Library", href: appPath(base, "/toc") },
  ];
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

// Browsers read "/\" as "//", so backslashes, whitespace and control characters are refused too.
const UNSAFE_PATH_CHARS = /[\\\s\x00-\x1f]/;

function isLocalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !UNSAFE_PATH_CHARS.test(value)
  );
}

/** The place links to render, in canonical order, with the active one flagged. */
export function placeLinks(options: AppShellOptions = {}): Array<{ key: Place; label: string; href: string; current: boolean }> {
  const wanted = new Set<Place>(options.places ?? DEFAULT_PLACES);
  const base = options.base ?? "";
  return allPlaces(base)
    .filter((place) => wanted.has(place.key))
    .map((place) => ({ ...place, current: place.key === options.active }));
}

function menuItem(key: string, label: string, href: string, activeMenu: string | undefined): string {
  const current = key === activeMenu ? ' aria-current="page"' : "";
  return `<a data-menu="${esc(key)}" href="${esc(href)}"${current}>${esc(label)}</a>`;
}

function accountMenu(options: AppShellOptions): string {
  const base = options.base ?? "";
  const links = (options.menu ?? [])
    .filter((link) => isLocalPath(link.href))
    .map((link) => menuItem(link.key, link.label, link.href, options.activeMenu));
  links.push(menuItem("signout", "Sign out", appPath(base, "/auth/logout"), options.activeMenu));
  return links.join("");
}

/** The shared page header: brand, place row, and the account menu. It needs no script. */
export function appShellHeader(options: AppShellOptions = {}): string {
  const base = options.base ?? "";
  const mark = options.brand?.mark;
  const name = options.brand?.name || "Workspace";
  const markHtml = isLocalPath(mark)
    ? `<img class="app-mark" src="${esc(mark)}" alt="">`
    : "";
  const places = placeLinks(options)
    .map((place) => {
      const current = place.current ? ' aria-current="page"' : "";
      return `<a data-place="${esc(place.key)}" href="${esc(place.href)}"${current}>${esc(place.label)}</a>`;
    })
    .join("");
  return [
    '<header class="app-shell" data-app-shell>',
    `<a class="app-brand" href="${esc(appPath(base, "/workspace"))}">${markHtml}<span class="app-name">${esc(name)}</span></a>`,
    `<nav class="app-places" aria-label="Main">${places}</nav>`,
    `<div class="app-tools"><details class="app-account"><summary>Account</summary><div class="app-menu">${accountMenu(options)}</div></details></div>`,
    "</header>",
  ].join("");
}

const APP_SHELL_RULES = `
.app-shell{display:flex;align-items:center;gap:12px;min-height:60px;padding:0 16px;border-bottom:1px solid var(--c-line);background:var(--c-paper);color:var(--c-ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:1.3;font-weight:400;position:relative;box-sizing:border-box}
.app-shell .app-brand{display:flex;align-items:center;gap:8px;margin-right:16px;color:var(--c-ink);font-size:15px;font-weight:700;text-decoration:none}
.app-shell .app-mark{display:block;height:28px;width:auto}
.app-shell .app-places{display:flex;align-items:stretch;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
.app-shell .app-places a{display:flex;align-items:center;min-height:44px;padding:0 10px;color:var(--c-muted);font-size:15px;font-weight:500;text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap}
.app-shell .app-places a[aria-current=page]{color:var(--c-ink);font-weight:650;border-bottom:2px solid var(--c-primary)}
.app-shell .app-tools{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.app-shell .app-account{position:relative}
.app-shell .app-account summary{display:flex;align-items:center;min-height:44px;padding:0 10px;cursor:pointer;color:var(--c-ink);list-style:none}
.app-shell .app-account summary::-webkit-details-marker{display:none}
.app-shell .app-menu{position:absolute;right:0;top:100%;display:flex;flex-direction:column;min-width:200px;padding:6px 0;background:var(--c-paper);border:1px solid var(--c-line);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:20}
.app-shell .app-menu a{display:flex;align-items:center;min-height:44px;padding:0 14px;color:var(--c-ink);font-size:15px;font-weight:400;text-decoration:none}
.app-shell .app-menu a[aria-current=page]{font-weight:650}
.app-shell :focus-visible{outline:3px solid var(--c-focus);outline-offset:2px}
@media(max-width:700px){.app-shell{gap:6px;padding:0 10px}.app-shell .app-brand{margin-right:4px}.app-shell .app-brand:has(> .app-mark) > .app-name{display:none}}
@media print{.app-shell{display:none}}
`;

/** Palette roles as `--c-*` properties, followed by the shell's layout and colour rules. */
export function appShellCss(brand?: Brand): string {
  return paletteCss(brand?.palette) + APP_SHELL_RULES;
}

/** The Artifacts / Documents tab row that sits above a library page's heading. */
export function libraryTabsHtml(base: string, current: "artifacts" | "documents"): string {
  const page = (key: "artifacts" | "documents") => (key === current ? ' aria-current="page"' : "");
  return `<nav class="library-tabs" aria-label="Library"><a href="${esc(appPath(base, "/artifacts"))}"${page("artifacts")}>Artifacts</a><a href="${esc(appPath(base, "/toc"))}"${page("documents")}>Documents</a></nav>`;
}

export const LIBRARY_TABS_CSS = ".library-tabs{display:flex;gap:8px;margin-top:8px}.library-tabs a{display:inline-flex;align-items:center;min-height:44px;padding:0 10px;color:var(--c-muted);text-decoration:none;border-bottom:2px solid transparent}.library-tabs a[aria-current=page]{color:var(--c-ink);border-bottom-color:var(--c-primary)}";
