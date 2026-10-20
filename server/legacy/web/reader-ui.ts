// Pidgin core: reading controls shared by message and document pages.
// The reader copies visible text with textContent; authored HTML never enters
// the first-party reader overlay as markup.
export const READER_STYLE = `<style>
  #pidgin-reader-bar { all: initial; position: fixed; z-index: 2147483646; left: 0; right: 0;
    bottom: 0; padding: 8px max(12px, env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    display: flex; align-items: center; gap: 8px; overflow-x: auto; background: #f8fbfa;
    border-top: 1px solid #ccdcd8; box-shadow: 0 -4px 24px #143a3620;
    font: 600 15px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #pidgin-reader-bar *, #pidgin-reader-overlay * { box-sizing: border-box; }
  #pidgin-reader-bar a, #pidgin-reader-bar button { flex: none; min-height: 44px; border: 1px solid #bbd1cb;
    border-radius: 10px; padding: 10px 12px; background: white; color: #204e49;
    font: inherit; text-decoration: none; cursor: pointer; }
  #pidgin-reader-bar a { margin-right: auto; }
  #pidgin-reader-bar button[aria-pressed="true"] { border-color: #204e49; background: #dcebe7; }
  #pidgin-reader-bar :focus-visible { outline: 3px solid #b87b3b; outline-offset: 2px; }
  #pidgin-reader-bar[hidden], #pidgin-reader-bar [hidden], #pidgin-reader-options[hidden], #pidgin-reader-overlay[hidden] { display: none !important; }
  #pidgin-reader-options { all: initial; position: fixed; z-index: 2147483647; left: 12px; right: 12px;
    bottom: calc(72px + env(safe-area-inset-bottom)); display: flex; flex-wrap: wrap; justify-content: center;
    gap: 8px; padding: 12px; border: 1px solid #ccdcd8; border-radius: 14px;
    background: #f8fbfa; box-shadow: 0 -8px 32px #143a3630; }
  #pidgin-reader-options button { min-width: 44px; min-height: 44px; padding: 8px; border: 1px solid #bbd1cb;
    border-radius: 10px; background: white; color: #204e49; font: 600 16px/1.3 system-ui, sans-serif; cursor: pointer; }
  #pidgin-reader-options button[aria-pressed="true"] { border-color: #204e49; background: #dcebe7; }
  #pidgin-reader-options :focus-visible { outline: 3px solid #b87b3b; outline-offset: 2px; }
  #pidgin-reader-overlay { all: initial; position: fixed; z-index: 2147483645; inset: 0; overflow-y: auto;
    background: #fff; color: #202829; -webkit-overflow-scrolling: touch;
    font: 19px/1.75 Georgia, "Times New Roman", serif; }
  #pidgin-reader-overlay[data-theme="sepia"] { background: #f6efdf; color: #342b22; }
  #pidgin-reader-overlay[data-theme="dark"] { background: #1e2427; color: #f4f0e8; }
  #pidgin-reader-overlay article { max-width: 42em; margin: 0 auto; padding: 36px 22px calc(110px + env(safe-area-inset-bottom)); }
  #pidgin-reader-overlay h1 { font: 700 1.7em/1.2 Georgia, serif; overflow-wrap: anywhere; margin: 0 0 1em; }
  #pidgin-reader-overlay pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 0; }
  body:has(#pidgin-reader-bar) { padding-bottom: calc(78px + env(safe-area-inset-bottom)) !important; }
  @media print { #pidgin-reader-bar, #pidgin-reader-options { display: none !important; } #pidgin-reader-overlay { position: static; overflow: visible; } }
</style>`;

export function readerScript(appName: string, homeHref: string, sourceSelector?: string): string {
  return `<script>(function () {
    var appName = ${JSON.stringify(appName)};
    var homeHref = ${JSON.stringify(homeHref)};
    var sourceSelector = ${JSON.stringify(sourceSelector || "")};
    function init() {
      if (!document.body || document.getElementById('pidgin-reader-bar')) return;
      var bar = document.createElement('nav');
      bar.id = 'pidgin-reader-bar';
      bar.setAttribute('aria-label', 'Reading controls');
      var home = document.createElement('a'); home.href = homeHref; home.textContent = '← ' + appName;
      home.setAttribute('aria-label', 'Back to ' + appName); bar.appendChild(home);
      var options = document.createElement('div'); options.id = 'pidgin-reader-options';
      options.setAttribute('aria-label', 'Reading appearance'); options.hidden = true;
      function button(label, title, action, parent) {
        var el = document.createElement('button'); el.type = 'button'; el.textContent = label;
        el.setAttribute('aria-label', title); el.addEventListener('click', action); (parent || bar).appendChild(el); return el;
      }
      var overlay = document.createElement('main'); overlay.id = 'pidgin-reader-overlay'; overlay.hidden = true;
      var article = document.createElement('article'); var heading = document.createElement('h1');
      var text = document.createElement('pre'); article.append(heading, text); overlay.appendChild(article);
      var background = [];
      var scale = 1; var theme = 'light';
      function apply() { overlay.dataset.theme = theme; overlay.style.fontSize = (19 * scale) + 'px';
        themes.forEach(function (item) { item.button.setAttribute('aria-pressed', String(theme === item.name)); }); }
      var toggle = button('Reader', 'Open reader mode', function () {
        if (overlay.hidden) {
          var source = sourceSelector && document.querySelector(sourceSelector) || document.body;
          // Hide app chrome while collecting visible text from full documents.
          bar.hidden = true;
          var excluded = Array.from(document.querySelectorAll('[data-reader-exclude]'));
          var former = excluded.map(function (item) { return item.hidden; });
          excluded.forEach(function (item) { item.hidden = true; });
          var readable = (source.innerText || source.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();
          excluded.forEach(function (item, index) { item.hidden = former[index]; }); bar.hidden = false;
          heading.textContent = document.querySelector('h1.title')?.textContent || document.querySelector('h1')?.textContent || document.title.split(' · ')[0] || appName;
          var titleAt = readable.indexOf(heading.textContent);
          if (titleAt >= 0 && titleAt < 300) {
            readable = (readable.slice(0, titleAt) + readable.slice(titleAt + heading.textContent.length)).trim();
          }
          text.textContent = readable;
          background = Array.from(document.body.children).filter(function (item) { return item !== overlay && item !== options && item !== bar; })
            .map(function (item) { var previous = item.inert; item.inert = true; return {item:item, previous:previous}; });
          overlay.hidden = false; document.documentElement.style.overflow = 'hidden';
          toggle.textContent = 'Done'; toggle.setAttribute('aria-label', 'Close reader mode');
          settings.hidden = false; apply(); overlay.scrollTop = 0;
        } else {
          overlay.hidden = true; document.documentElement.style.overflow = '';
          background.forEach(function (entry) { entry.item.inert = entry.previous; }); background = [];
          toggle.textContent = 'Reader'; toggle.setAttribute('aria-label', 'Open reader mode');
          settings.hidden = true; options.hidden = true;
        }
      });
      var settings = button('Aa', 'Reading appearance', function () { options.hidden = !options.hidden; });
      settings.hidden = true;
      button('A−', 'Smaller text', function () { scale = Math.max(.8, +(scale - .1).toFixed(1)); apply(); }, options);
      button('A+', 'Larger text', function () { scale = Math.min(1.6, +(scale + .1).toFixed(1)); apply(); }, options);
      var themes = ['light', 'sepia', 'dark'].map(function (name) {
        var symbols = {light:'○', sepia:'◐', dark:'●'};
        return { name: name, button: button(symbols[name], name + ' theme', function () { theme = name; apply(); }, options) };
      });
      document.body.append(overlay, options, bar);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true}); else init();
  })();</script>`;
}

export function addReaderUi(html: string, appName: string, homeHref: string): string {
  const script = readerScript(appName, homeHref);
  const withStyle = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${READER_STYLE}</head>`)
    : `${READER_STYLE}${html}`;
  return /<\/body>/i.test(withStyle)
    ? withStyle.replace(/<\/body>/i, `${script}</body>`)
    : `${withStyle}${script}`;
}
