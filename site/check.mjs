#!/usr/bin/env node
// Checks the static website in site/public. No dependencies. Node 20 or later.
// Usage: node site/check.mjs
//
// It checks that:
//  - every internal link and in-page anchor resolves;
//  - every page has a title, a lang attribute, a meta description, a skip link,
//    exactly one h1, and no script, style element or inline style;
//  - every image has alt text;
//  - no page or style sheet points to an origin other than
//    github.com/ashrocket/pidgindocs and duva.work;
//  - the color pairs in the style sheet meet their contrast limits.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const BASE = 'https://site.invalid';
const problems = [];
const fail = (file, message) => problems.push(`${file}: ${message}`);

// --- External origins ------------------------------------------------------

// Hosts that appear only as placeholders in examples, never as a link target.
const PLACEHOLDER_HOST = /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net|workers\.dev)$|^localhost$|^127\.0\.0\.1$/;

function isAllowedExternal(url) {
  if (url.protocol !== 'https:') return false;
  if (url.host === 'duva.work') return true;
  if (url.host === 'github.com') {
    const repo = '/ashrocket/pidgindocs';
    return url.pathname === repo || url.pathname === `${repo}.git` || url.pathname.startsWith(`${repo}/`);
  }
  return false;
}

// --- Files -----------------------------------------------------------------

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (!existsSync(ROOT)) {
  console.error(`Missing folder: ${ROOT}`);
  process.exit(1);
}

const files = walk(ROOT);
const rel = (path) => relative(ROOT, path).split(sep).join('/');
const pages = files.filter((f) => f.endsWith('.html'));
const sheets = files.filter((f) => f.endsWith('.css'));
const text = new Map([...pages, ...sheets].map((f) => [f, readFileSync(f, 'utf8')]));

// The public URL path of a page: install/index.html -> /install/
const pagePath = (file) => {
  const r = rel(file);
  if (r === 'index.html') return '/';
  return r.endsWith('/index.html') ? `/${r.slice(0, -'index.html'.length)}` : `/${r}`;
};

const idsOf = (html) => new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));

// Resolve an internal URL to a file, or report why it does not resolve.
function resolveInternal(url) {
  const path = decodeURIComponent(url.pathname);
  const target = path.endsWith('/') ? `${path}index.html` : path;
  const file = join(ROOT, target);
  if (!file.startsWith(ROOT + sep)) return { error: 'leaves the site folder' };
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (!path.endsWith('/') && existsSync(join(ROOT, path, 'index.html'))) {
      return { error: 'needs a trailing slash' };
    }
    return { error: 'does not exist' };
  }
  return { file };
}

// --- Page checks -----------------------------------------------------------

const linked = new Set();
let linkCount = 0;

for (const file of pages) {
  const name = rel(file);
  const html = text.get(file);
  const here = new URL(pagePath(file), BASE);

  if (!/<title>\s*\S[^<]*<\/title>/i.test(html)) fail(name, 'missing or empty <title>');
  if (!/<html\b[^>]*\slang\s*=\s*["'][a-z]{2}/i.test(html)) fail(name, 'missing lang attribute on <html>');
  if (!/<meta\s+name\s*=\s*["']description["']\s+content\s*=\s*["'][^"']{20,}["']/i.test(html)) {
    fail(name, 'missing or too short meta description');
  }
  if (!/<meta\s+name\s*=\s*["']viewport["']/i.test(html)) fail(name, 'missing viewport meta');
  if (!/<a\s+class\s*=\s*["']skip["']\s+href\s*=\s*["']#main["']/i.test(html) || !idsOf(html).has('main')) {
    fail(name, 'missing skip link to #main, or no element with id="main"');
  }
  const h1 = (html.match(/<h1\b/gi) ?? []).length;
  if (h1 !== 1) fail(name, `expected exactly one <h1>, found ${h1}`);

  // These would break the Content Security Policy in public/_headers.
  if (/<script\b/i.test(html)) fail(name, 'contains a <script>');
  if (/<style\b/i.test(html)) fail(name, 'contains a <style> element');
  if (/\sstyle\s*=/i.test(html)) fail(name, 'contains an inline style attribute');

  for (const img of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\salt\s*=/i.test(img)) fail(name, `image without alt text: ${img.slice(0, 60)}`);
  }

  // Every URL in an attribute that a browser follows or loads.
  const values = [];
  for (const m of html.matchAll(/\s(href|src|action|poster|data|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = m[2] ?? m[3];
    if (m[1].toLowerCase() === 'srcset') {
      values.push(...value.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean));
    } else {
      values.push(value);
    }
  }

  for (const value of values) {
    linkCount += 1;
    if (value.startsWith('#')) {
      if (value.length > 1 && !idsOf(html).has(decodeURIComponent(value.slice(1)))) {
        fail(name, `anchor ${value} has no matching id`);
      }
      continue;
    }
    let url;
    try {
      url = new URL(value, here);
    } catch {
      fail(name, `cannot parse URL: ${value}`);
      continue;
    }
    // A protocol-relative URL like //host/x resolves to another host here.
    if (url.origin !== BASE) {
      if (!isAllowedExternal(url)) fail(name, `external origin not allowed: ${value}`);
      continue;
    }
    const result = resolveInternal(url);
    if (result.error) {
      fail(name, `link ${value} ${result.error}`);
      continue;
    }
    linked.add(result.file);
    if (url.hash.length > 1 && result.file.endsWith('.html')) {
      if (!idsOf(text.get(result.file)).has(decodeURIComponent(url.hash.slice(1)))) {
        fail(name, `link ${value} points to a missing anchor`);
      }
    }
  }

  // Outside origins in visible text must be placeholders. This catches a URL
  // that was typed as text and later turned into a link.
  for (const m of html.matchAll(/https?:\/\/([^\s"'<>/:)]+)[^\s"'<>]*/gi)) {
    let url;
    try {
      url = new URL(m[0]);
    } catch {
      continue;
    }
    if (!isAllowedExternal(url) && !PLACEHOLDER_HOST.test(url.hostname)) {
      fail(name, `external origin in text: ${m[0]}`);
    }
  }
}

// --- Style sheets ----------------------------------------------------------

for (const file of sheets) {
  const name = rel(file);
  const css = text.get(file);
  if (/@import\b/i.test(css)) fail(name, 'contains @import');
  for (const m of css.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi)) {
    const url = new URL(m[2], new URL(`/${rel(file)}`, BASE));
    if (url.origin !== BASE) fail(name, `external origin in url(): ${m[2]}`);
    else if (resolveInternal(url).error) fail(name, `url(${m[2]}) ${resolveInternal(url).error}`);
    else linked.add(resolveInternal(url).file);
  }
}

// Every page except the 404 page must be reachable from another page.
for (const file of pages) {
  const name = rel(file);
  if (name === '404.html' || name === 'index.html') continue;
  if (!linked.has(file)) fail(name, 'no page links to it');
}

// --- Contrast --------------------------------------------------------------

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, minimum ratio, where it is used]
const PAIRS = [
  ['--ink', '--paper', 7, 'body text'],
  ['--muted', '--paper', 4.5, 'small text'],
  ['--link', '--paper', 4.5, 'links'],
  ['--navy-deep', '--paper', 7, 'headings'],
  ['--paper', '--navy', 7, 'primary button'],
  ['--paper', '--navy-deep', 7, 'code blocks and dark band'],
  ['--sky', '--navy-deep', 4.5, 'fact headings on the dark band'],
  ['--on-dark-dim', '--navy-deep', 4.5, 'quiet text on dark'],
  ['--navy-deep', '--sky-soft', 7, 'text on the light blue panels'],
  ['--ink', '--sky-soft', 7, 'body text on the light blue panels'],
  ['--link', '--sky-soft', 4.5, 'links on the light blue panels'],
  ['--ink', '--paper-deep', 7, 'inline code'],
];

for (const file of sheets) {
  const css = text.get(file);
  const vars = Object.fromEntries(
    [...css.matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2].toLowerCase()]),
  );
  for (const [fg, bg, min, use] of PAIRS) {
    if (!vars[fg] || !vars[bg]) {
      fail(rel(file), `contrast check needs ${fg} and ${bg}`);
      continue;
    }
    const value = ratio(vars[fg], vars[bg]);
    if (value < min) fail(rel(file), `${use}: ${fg} on ${bg} is ${value.toFixed(2)}:1, need ${min}:1`);
  }
}

// --- Result ----------------------------------------------------------------

if (problems.length > 0) {
  console.error(`Site check failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Site check passed: ${pages.length} pages, ${sheets.length} style sheet, ${linkCount} URLs checked.`);
