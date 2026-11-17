import { appPath } from "../base-path";
import type { Language } from "../translation-languages";
import { DOCUMENT_CONTENT_CSP } from "./content-security";
import { contentAttribute } from "../wire-names";
import { editionProductName } from "../edition-hooks";

const escape = (text: unknown) => String(text ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
const readingTags = new Set("p h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code strong em b i s del ins sup sub br hr table caption thead tbody tfoot tr th td dl dt dd abbr details summary a img figure figcaption".split(" "));
// Never unwrap raw-text/RCDATA containers: their text can become executable
// markup when reparsed inside the reader's HTML document.
const forbiddenTags = new Set("head title script style iframe xmp plaintext noembed noframes object embed svg math template noscript form input button textarea select option video audio canvas link meta base".split(" "));

function safeLink(value: string): string | null {
  const href = value.trim();
  if (!href || /[\u0000-\u0020\\]/.test(href)) return null;
  if (/^(?:https?:\/\/|mailto:|#|\/(?!\/))/.test(href)) return href;
  // Document-relative authored references remain relative to this document.
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//") ? href : null;
}

/** HTMLRewriter parses HTML, including malformed markup, before this allowlist.
 * No authored attributes survive except validated links and table semantics.
 * The opaque CSP is a second boundary, not a substitute for sanitization. */
export async function sanitizeReaderHtml(html: string, base = ""): Promise<string> {
  const rewriter = new HTMLRewriter().on("*", { element(element) {
      const tag = element.tagName.toLowerCase();
      const classes = (element.getAttribute("class") || "").split(/\s+/);
      if (((tag === "header" || tag === "footer") && classes.includes("doc")) || (tag === "h1" && classes.includes("title"))) { element.remove(); return; }
      if (forbiddenTags.has(tag)) { element.remove(); return; }
      if (!readingTags.has(tag)) { element.removeAndKeepContent(); return; }
      const image = tag === "img" ? element.getAttribute("src") || "" : "";
      const alt = tag === "img" ? element.getAttribute("alt") || "" : "";
      if (tag === "img" && !/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\r\n]+$/i.test(image)) { if (alt) element.replace(alt); else element.remove(); return; }
      let href = tag === "a" ? safeLink(element.getAttribute("href") || "") : null;
      // Preserve absolute and already-prefixed references. Only known root app
      // links need the active deployment prefix when reading imported content.
      if (href && /^\/(?:docs|idoc|a|workspace)(?:[/?#]|$)/.test(href)) href = appPath(base, href);
      if (tag === "a" && !href) { element.removeAndKeepContent(); return; }
      const title = element.getAttribute("title");
      const id = element.getAttribute("id");
      const span = tag === "td" || tag === "th" ? element.getAttribute("colspan") : null;
      const rows = tag === "td" || tag === "th" ? element.getAttribute("rowspan") : null;
      const scope = tag === "th" ? element.getAttribute("scope") : null;
      for (const [name] of Array.from(element.attributes)) element.removeAttribute(name);
      if (image) { element.setAttribute("src", image); element.setAttribute("alt", alt); }
      if (href) { element.setAttribute("href", href.startsWith("#") ? "#content-" + href.slice(1) : href); element.setAttribute("rel", "noreferrer noopener"); }
      if (id && /^[A-Za-z][A-Za-z0-9_.:-]{0,100}$/.test(id)) element.setAttribute("id", "content-" + id);
      if (title) element.setAttribute("title", title);
      if (span && /^[1-9]\d?$/.test(span)) element.setAttribute("colspan", span);
      if (rows && /^[1-9]\d?$/.test(rows)) element.setAttribute("rowspan", rows);
      if (scope && /^(col|row|colgroup|rowgroup)$/.test(scope)) element.setAttribute("scope", scope);
      if (tag === "h1") element.tagName = "h2";
      // Keyboard users can scroll wide technical material independently.
      if (tag === "pre" || tag === "table") element.setAttribute("tabindex", "0");
    } });
  return rewriter.transform(new Response(html)).text();
}

export interface OperatorReaderInput {
  base?: string;
  rawHtml: string;
  language?: Language;
  title: string;
  sourceUrl: string;
  returnUrl: string;
  returnLabel: "Back to Bulletin" | "Back to workspace";
  author?: string | null;
  createdAt?: string | null;
  ticket?: { key: string; url: string } | null;
  versionHtml?: string;
}

export type ReaderLabels = (key: string, language: Language, values: Record<string, string | number>) => string;

const READER_CSS = `
:root{--paper:#faf7f0;--ink:#253934;--muted:#56675f;--line:#d8ded4;--accent:#285e55;--selection:#cee6d6;--code:#edece5;--body-size:22px;color-scheme:light;font-family:Georgia,"Times New Roman",serif;background:var(--paper);color:var(--ink)}
:root[data-reader-theme=light]{--paper:#fff;--ink:#24352f;--muted:#54645d;--line:#dce3dd;--code:#f3f5f2}
:root[data-reader-theme=dark]{--paper:#192522;--ink:#e9eee6;--muted:#b7c5ba;--line:#43554a;--accent:#aed7be;--selection:#3e6550;--code:#24372e;color-scheme:dark}
@media(prefers-color-scheme:dark){:root:not([data-reader-theme]){--paper:#192522;--ink:#e9eee6;--muted:#b7c5ba;--line:#43554a;--accent:#aed7be;--selection:#3e6550;--code:#24372e;color-scheme:dark}}
:root[data-reader-font=sans]{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
:root[data-reader-size=small]{--body-size:20px}:root[data-reader-size=large]{--body-size:26px}
*{box-sizing:border-box}html{scroll-behavior:auto;-webkit-text-size-adjust:100%}body{margin:0;background:var(--paper);color:var(--ink);-webkit-user-select:text;user-select:text}::selection{background:var(--selection);color:var(--ink)}
a{color:var(--accent);text-underline-offset:4px;text-decoration-thickness:1px;overflow-wrap:anywhere}a:hover{text-decoration-thickness:2px}a:focus-visible,summary:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--accent);outline-offset:5px;border-radius:3px}
.reader-nav{font:14px/1.4 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;gap:24px;max-width:1500px;padding:16px 32px;margin:auto;border-bottom:1px solid var(--line)}.reader-nav a{min-height:44px;display:inline-flex;align-items:center;text-decoration:none}.reader-brand{font-weight:750;font-size:21px;letter-spacing:-.5px;margin-right:4px}.reader-back{margin-right:auto}.reader-nav details{position:relative}.reader-nav summary{display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;list-style:none;font-weight:650}.reader-nav summary::-webkit-details-marker{display:none}.reader-options{position:absolute;right:0;top:52px;z-index:2;width:260px;border:1px solid var(--line);border-radius:12px;background:var(--paper);padding:20px;box-shadow:0 12px 32px #0002}.reader-choice{margin-bottom:16px}.reader-choice:last-child{margin-bottom:0}.reader-options label{display:block;margin:0;font-size:13px;font-weight:650}.reader-options select{display:block;margin-top:6px;width:100%;min-height:44px;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px;font:16px/1.4 system-ui}
.reader-page{width:min(100% - 64px,68ch);margin:76px auto 120px;font-size:var(--body-size);line-height:1.7;overflow-wrap:anywhere}.reader-heading{margin:0 0 46px;padding-bottom:32px;border-bottom:1px solid var(--line)}.reader-heading h1{margin:0 0 24px;font-size:clamp(34px,3.5vw,54px);font-weight:600;line-height:1.13;letter-spacing:-.025em;text-wrap:balance}.reader-context{font:calc(var(--body-size)*.68)/1.6 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--muted);display:flex;align-items:center;gap:8px 20px;flex-wrap:wrap}.reader-context a{font-weight:650;min-height:44px;display:inline-flex;align-items:center}.reader-version{font:calc(var(--body-size)*.68)/1.6 system-ui;color:var(--muted);margin-top:20px}.reader-version aside{display:block}
.reader-content img{display:block;max-width:100%;height:auto;margin:1.8em auto}.reader-content figure{margin:1.8em 0}.reader-content figcaption{font:calc(var(--body-size)*.68)/1.6 system-ui;color:var(--muted);margin-top:12px}.reader-content p{margin:0 0 1.45em}.reader-content h2,.reader-content h3,.reader-content h4,.reader-content h5,.reader-content h6{line-height:1.25;letter-spacing:-.015em;margin:2.2em 0 .8em;text-wrap:balance}.reader-content h2{font-size:1.5em}.reader-content h3{font-size:1.22em}.reader-content ul,.reader-content ol{padding-left:1.35em;margin:0 0 1.5em}.reader-content li{padding-left:.25em;margin:.4em 0}.reader-content blockquote{margin:1.8em 0;padding:0 0 0 1.2em;border-left:1px solid var(--accent);color:var(--muted);font-style:italic}.reader-content pre{max-width:100%;overflow:auto;padding:22px;background:var(--code);border-radius:8px;font:calc(var(--body-size)*.72)/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;tab-size:2}.reader-content code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78em;background:var(--code);padding:.12em .25em;border-radius:3px}.reader-content pre code{font:inherit;padding:0;background:none}.reader-content table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:1.8em 0;font:calc(var(--body-size)*.76)/1.6 system-ui;font-variant-numeric:tabular-nums}.reader-content th,.reader-content td{text-align:left;padding:12px 18px;border-bottom:1px solid var(--line);vertical-align:top;min-width:140px}.reader-content th{font-weight:650}.reader-content caption{text-align:left;font-weight:650;margin-bottom:12px}.reader-content hr{border:0;border-top:1px solid var(--line);margin:2.6em 0}.reader-content details{margin:1.5em 0}.reader-content summary{cursor:pointer;min-height:44px}.reader-content dl{margin:1.5em 0}.reader-content dt{font-weight:700}.reader-content dd{margin:.3em 0 1em 1.2em}.reader-end{margin-top:60px;padding-top:24px;border-top:1px solid var(--line);font:14px/1.6 system-ui}.reader-end a{display:inline-flex;align-items:center;min-height:44px}
@media(max-width:700px){:root{--body-size:19px}:root[data-reader-size=small]{--body-size:17px}:root[data-reader-size=large]{--body-size:22px}.reader-nav{padding:10px 20px;gap:16px;flex-wrap:wrap}.reader-brand{font-size:20px}.reader-source{order:4}.reader-nav summary{font-size:13px}.reader-page{width:calc(100% - 40px);margin:42px auto 80px}.reader-heading{margin-bottom:32px;padding-bottom:24px}.reader-heading h1{font-size:34px;line-height:1.16}.reader-context{gap:8px 14px}.reader-content pre{padding:16px}.reader-options{width:min(260px,calc(100vw - 40px))}}
.reader-overflow-hint{display:block;margin:1.4em 0 .4em;color:var(--muted);font:calc(var(--body-size)*.68)/1.5 system-ui}.reader-overflow-hint[hidden]{display:none}.reader-overflow-hint:not([hidden])+pre,.reader-overflow-hint:not([hidden])+table{margin-top:0}
@media print{.reader-overflow-hint,.reader-nav,.reader-end{display:none}.reader-page{width:auto;max-width:none;margin:0;font-size:12pt}:root{--paper:#fff;--ink:#000;--muted:#333;--line:#bbb;--accent:#000}}
`;

/** Sandboxed pages cannot use application storage. Reader choices stay in the
 * URL fragment, so reopening this reading address restores them without a
 * network request, application cookies or history.replaceState. Explicit return
 * links carry only allowlisted choices to the application shell for persistence. */
const READER_SCRIPT = `
const root=document.documentElement,choices={font:['serif','sans'],size:['small','medium','large'],theme:['light','warm','dark']},readerPreferences=new URLSearchParams(),readerSystemTheme=matchMedia('(prefers-color-scheme: dark)');
const readerReturnLinks=Array.from(document.querySelectorAll('[data-reader-return]')).map(link=>({link,href:link.getAttribute('href')}));
function updateReaderReturnLinks(){const fragment=readerPreferences.toString();for(const {link,href} of readerReturnLinks)link.setAttribute('href',fragment?href.split('#')[0]+'#'+fragment:href)}
function updateReaderTheme(){const theme=readerPreferences.get('read-theme')||(readerSystemTheme.matches?'dark':'warm');root.dataset.readerTheme=theme;document.getElementById('reader-theme').value=theme}
readerSystemTheme.addEventListener('change',updateReaderTheme);
const readerOverflowBlocks=Array.from(document.querySelectorAll('.reader-content pre,.reader-content table')).map((element,index)=>{const hint=document.getElementById('reader-overflow-template').content.firstElementChild.cloneNode(true);hint.id='reader-overflow-'+index;element.before(hint);element.setAttribute('aria-describedby',hint.id);return {element,hint}});
function updateReaderOverflow(){for(const {element,hint} of readerOverflowBlocks)hint.hidden=element.scrollWidth<=element.clientWidth+1}
const readerResizeObserver=new ResizeObserver(updateReaderOverflow);readerOverflowBlocks.forEach(({element})=>readerResizeObserver.observe(element));addEventListener('resize',updateReaderOverflow);
function applyReaderChoices(){const values=new URLSearchParams(location.hash.slice(1));for(const key of Object.keys(choices)){const value=values.get('read-'+key);if(choices[key].includes(value)){readerPreferences.set('read-'+key,value);root.dataset['reader'+key[0].toUpperCase()+key.slice(1)]=value;document.getElementById('reader-'+key).value=value}}updateReaderTheme();updateReaderReturnLinks();requestAnimationFrame(updateReaderOverflow)}
applyReaderChoices();addEventListener('hashchange',applyReaderChoices);
document.querySelectorAll('[data-reader-choice]').forEach(select=>select.addEventListener('change',()=>{readerPreferences.set('read-'+select.dataset.readerChoice,select.value);root.dataset['reader'+select.dataset.readerChoice[0].toUpperCase()+select.dataset.readerChoice.slice(1)]=select.value;updateReaderReturnLinks();requestAnimationFrame(updateReaderOverflow);try{location.hash=readerPreferences.toString()}catch{}}));
document.addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=document.getElementById('reader-settings');if(menu.open){menu.open=false;menu.querySelector('summary').focus()}}});
`;

export async function operatorReader(input: OperatorReaderInput, translate?: ReaderLabels): Promise<{ html: string; csp: string }> {
  const nonce = crypto.randomUUID();
  const language = input.language || "en";
  const label = (key: string, values: Record<string, string | number> = {}) => escape(translate
    ? translate(key, language, values)
    : key.replace(/\{\{(value\d+)\}\}/g, (_, name: string) => String(values[name] ?? "")));
  const article = await sanitizeReaderHtml(input.rawHtml, input.base);
  const version = input.versionHtml ? await sanitizeReaderHtml(input.versionHtml, input.base) : "";
  const ticketHref = input.ticket && safeLink(input.ticket.url);
  const source = safeLink(input.sourceUrl) || appPath(input.base || "", "/workspace");
  const back = safeLink(input.returnUrl) || appPath(input.base || "", "/workspace");
  const timestamp = input.createdAt ? new Date(input.createdAt) : null;
  const date = timestamp && Number.isFinite(timestamp.getTime()) ? new Intl.DateTimeFormat(language, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(timestamp) : "";
  const csp = DOCUMENT_CONTENT_CSP.replace("script-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`).replace("style-src 'unsafe-inline'", `style-src 'nonce-${nonce}'`);
  return { csp, html: `<!doctype html><html lang="${language}" data-reader-font="serif" data-reader-size="medium"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(input.title)} · ${editionProductName()}</title><style nonce="${nonce}">${READER_CSS}</style></head><body>
<nav class="reader-nav" aria-label="${label("Reader navigation")}"><a class="reader-brand" data-reader-return href="${escape(back)}" translate="no">${editionProductName()}</a><a class="reader-back" data-reader-return href="${escape(back)}">${label(input.returnLabel)}</a><a class="reader-source" href="${escape(source)}">${label("View original")}</a><details id="reader-settings"><summary>${label("Text settings")}</summary><div class="reader-options"><div class="reader-choice"><label for="reader-font">${label("Reading font")}</label><select id="reader-font" data-reader-choice="font"><option value="serif">${label("Serif")}</option><option value="sans">${label("Sans serif")}</option></select></div><div class="reader-choice"><label for="reader-size">${label("Text size")}</label><select id="reader-size" data-reader-choice="size"><option value="small">${label("Small")}</option><option value="medium" selected>${label("Medium")}</option><option value="large">${label("Large")}</option></select></div><div class="reader-choice"><label for="reader-theme">${label("Page appearance")}</label><select id="reader-theme" data-reader-choice="theme"><option value="light">${label("Light")}</option><option value="warm" selected>${label("Warm")}</option><option value="dark">${label("Dark")}</option></select></div></div></details></nav>
<main class="reader-page"><header class="reader-heading"><h1 ${contentAttribute()}>${escape(input.title)}</h1><div class="reader-context">${input.author ? `<span translate="no">${escape(input.author)}</span>` : ""}${date ? `<time datetime="${escape(input.createdAt)}" translate="no">${escape(date)}</time>` : ""}${input.ticket && ticketHref ? `<a href="${escape(ticketHref)}" aria-label="${label("Ticket {{value0}}", { value0: input.ticket.key })}"><span translate="no">${escape(input.ticket.key)}</span></a>` : ""}</div>${version ? `<div class="reader-version">${version}</div>` : ""}</header><article class="reader-content" id="reader-content" ${contentAttribute()}>${article}</article><footer class="reader-end"><a href="${escape(source)}">${label("View original")}</a></footer></main><template id="reader-overflow-template"><span class="reader-overflow-hint" hidden>${label("Scroll horizontally for more")}</span></template><script nonce="${nonce}">${READER_SCRIPT}</script></body></html>` };
}
