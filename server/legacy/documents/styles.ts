// The builtin document style stack. Each style is a complete editorial
// identity: a DTCG palette + typography, a component-CSS partial with the
// style's animations, an inline effects script, and a narrative VOICE the
// writing agent adopts so the prose matches the page.
//
// Design rules for this stack:
// - Light-first. New styles define no $extensions.pidgin.dark subtree, so
//   documents stay on paper regardless of the reader's OS theme (only the
//   legacy pidgin-editorial keeps its dark variant).
// - Self-contained. System font stacks only, zero external requests; the
//   one same-origin exception (mermaid.js) is injected by typeset.ts.
// - Motion is opt-in. Every animation is gated on prefers-reduced-motion:
//   no-preference, and the scroll-reveal hides content only after its script
//   has committed to revealing it (html[data-fx]), so no-JS readers and
//   print/PDF always get the finished page.
//
// Effect lineage (adapted, inlined, credited): scroll reveals follow the
// IntersectionObserver pattern popularized by michalsnik/aos; hover/link
// treatments follow IanLunn/Hover.css; the teletype title decode is the
// camwiegert/baffle.js scramble; entrance keyframes follow animate.css.

import { DesignSystemDefinition, PIDGIN_EDITORIAL } from "./design-system";

// Scroll-reveal runtime. Stamps data-fx on <html> only after the
// reduced-motion and IntersectionObserver checks pass — the CSS that hides
// unrevealed elements is scoped to html[data-fx], so content is never hidden
// for readers the script won't serve. `extra` carries a style's signature
// effect (title hop, decode) inside the same guards.
function revealScript(stepMs: number, extra = ""): string {
  return `(function () {
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;
  var els = document.querySelectorAll("article > *");
  if (!els.length) return;
  document.documentElement.setAttribute("data-fx", "");
  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].isIntersecting) continue;
      io.unobserve(entries[i].target);
      entries[i].target.classList.add("fx-in");
      try {
        document.dispatchEvent(new CustomEvent("pidgin:reveal", { detail: { el: entries[i].target } }));
      } catch (e) {}
    }
  }, { rootMargin: "0px 0px -7% 0px" });
  for (var k = 0; k < els.length; k++) {
    els[k].style.transitionDelay = ((k % 6) * ${stepMs}) + "ms";
    io.observe(els[k]);
  }
${extra}})();`;
}

// Per-style sound cues via cuelume (github: interaction-sound synth, MIT,
// ~5 kB, served same-origin at /a/assets/cuelume.js — R2-cached like
// mermaid). Strictly opt-in: a small ♪ toggle is injected into the page,
// default OFF, persisted in localStorage; the module is not even fetched
// until the reader turns sound on. Browsers gate Web Audio behind a user
// gesture, so the toggle click doubles as the unlock.
interface AudioCues {
  // cue played when a link is tapped
  link?: string;
  // cue played as elements scroll-reveal (rate-limited)
  reveal?: string;
  // only reveals matching this selector make a sound (default: all)
  revealSelector?: string;
  // confirmation cue when the reader turns sound on
  enable: string;
}

function audioScript(cues: AudioCues): string {
  return `(function () {
  var CUES = ${JSON.stringify({ link: cues.link ?? "", reveal: cues.reveal ?? "", sel: cues.revealSelector ?? "", enable: cues.enable })};
  var KEY = "pidgin-doc-audio";
  var on = false, lume = null, last = 0;
  try { on = localStorage.getItem(KEY) === "on"; } catch (e) {}
  var btn = document.createElement("button");
  btn.id = "pidgin-audio-toggle";
  btn.type = "button";
  btn.title = "Toggle document sounds";
  btn.setAttribute("aria-pressed", String(on));
  btn.textContent = "\\u266A";
  btn.style.cssText = "position:fixed;bottom:10px;left:14px;z-index:9999;width:30px;height:30px;border-radius:50%;border:1px solid currentColor;background:transparent;cursor:pointer;font-size:13px;line-height:1;color:inherit;opacity:" + (on ? ".85" : ".35");
  document.body.appendChild(btn);
  function load() {
    if (lume) return Promise.resolve(lume);
    return import("/a/assets/cuelume.js").then(function (m) { lume = m; return m; });
  }
  function play(cue) {
    if (!on || !cue) return;
    var now = Date.now();
    if (now - last < 160) return;
    last = now;
    load().then(function (m) { try { m.play(cue); } catch (e) {} }).catch(function () {});
  }
  btn.addEventListener("click", function () {
    on = !on;
    try { localStorage.setItem(KEY, on ? "on" : "off"); } catch (e) {}
    btn.style.opacity = on ? ".85" : ".35";
    btn.setAttribute("aria-pressed", String(on));
    if (on) load().then(function (m) { try { m.play(CUES.enable); } catch (e) {} }).catch(function () {});
  });
  if (CUES.link) {
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest("article a")) play(CUES.link);
    });
  }
  if (CUES.reveal) {
    document.addEventListener("pidgin:reveal", function (ev) {
      var el = ev.detail && ev.detail.el;
      if (CUES.sel && !(el && el.matches && el.matches(CUES.sel))) return;
      play(CUES.reveal);
    });
  }
})();`;
}

// Companion CSS for revealScript: `hidden` is the pre-reveal state, and the
// print block guarantees PDFs/print never capture a half-revealed page.
function revealCss(hidden: string, transition: string): string {
  return `
  html[data-fx] article > * { ${hidden} }
  html[data-fx] article > .fx-in { opacity: 1; transform: none; filter: none; transition: ${transition}; }
  @media print {
    html[data-fx] article > * { opacity: 1 !important; transform: none !important; filter: none !important; }
  }`;
}

const SANS_HEADING = ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Helvetica Neue", "sans-serif"];
const MONO_STACK = ["ui-monospace", "SF Mono", "Menlo", "Consolas", "Liberation Mono", "monospace"];

function colorTokens(c: {
  bg: string; surface: string; text: string; muted: string; faint: string;
  accent: string; rule: string; positive: string;
}): Record<string, unknown> {
  return {
    background: { $type: "color", $value: c.bg },
    surface: { $type: "color", $value: c.surface },
    text: { $type: "color", $value: c.text },
    "text-muted": { $type: "color", $value: c.muted },
    "text-faint": { $type: "color", $value: c.faint },
    accent: { $type: "color", $value: c.accent },
    rule: { $type: "color", $value: c.rule },
    positive: { $type: "color", $value: c.positive },
  };
}

function fontTokens(f: { body: string[]; heading: string[]; mono?: string[] }): Record<string, unknown> {
  return {
    body: { $type: "fontFamily", $value: f.body },
    heading: { $type: "fontFamily", $value: f.heading },
    mono: { $type: "fontFamily", $value: f.mono ?? MONO_STACK },
  };
}

// ---------------------------------------------------------------------------
// boardroom — the professional brief
// ---------------------------------------------------------------------------

export const BOARDROOM: DesignSystemDefinition = {
  name: "boardroom",
  displayName: "Boardroom",
  description:
    "The professional brief — cool slate and navy, disciplined sans-serif, tables that mean business. Built for executive summaries and mermaid architecture diagrams.",
  voice:
    "Write as a senior consultant delivering an executive brief. Bottom line up front: open " +
    "with a three-sentence summary — finding, impact, recommendation. Numbered sections with " +
    "precise headings; every claim quantified or attributed. Use tables for comparisons and " +
    "mermaid diagrams for architecture or flows. Close with Risks, then Next Steps with owners. " +
    "No exclamation points, no hedging.",
  source: "builtin",
  tokens: {
    color: colorTokens({
      bg: "#F8F9FB", surface: "#EDF1F6", text: "#1A2433", muted: "#4D5A6E",
      faint: "#8391A5", accent: "#1B5CC4", rule: "#D9DFE8", positive: "#1C7C4D",
    }),
    font: fontTokens({ body: SANS_HEADING, heading: SANS_HEADING }),
  },
  css: `
  body { font-size: 16px; }
  h1.title { font-size: 29px; font-weight: 700; letter-spacing: -0.015em; }
  article h3 { font-size: 18px; }
  article th { border-bottom: 2px solid var(--ds-accent); color: var(--ds-text-muted); }
  article tr:hover td { background: var(--ds-surface); }
  article blockquote {
    border-left: 3px solid var(--ds-accent);
    border-radius: 0 6px 6px 0;
    font-family: var(--ds-font-heading);
    font-size: 15.5px;
  }
  article a { text-decoration-color: var(--ds-accent); }
  article pre.mermaid { border-radius: 8px; }
${revealCss("opacity: 0; transform: translateY(10px);", "opacity .5s ease, transform .5s ease")}`,
  effects: revealScript(45) + "\n" + audioScript({ link: "press", enable: "ready" }),
};

// ---------------------------------------------------------------------------
// poignant — after Why the Lucky Stiff's (Poignant) Guide
// ---------------------------------------------------------------------------

// Crayon squiggle used as the section rule, URL-encoded so the css partial
// stays free of raw angle brackets.
const POIGNANT_SQUIGGLE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='8'%3E%3Cpath d='M0 4 Q2.5 0.5 5 4 T10 4 T15 4 T20 4' fill='none' stroke='%23D8442E' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E\")";

export const POIGNANT: DesignSystemDefinition = {
  name: "poignant",
  displayName: "Poignant",
  description:
    "A storybook in crayon after _why's Poignant Guide — wobbly squiggle rules, fox interruptions, typewriter code, wonder with footnotes.",
  voice:
    "Write like _why: warm, digressive, second person. Open mid-thought, as if the reader just " +
    "sat down beside you. Explain with homespun metaphors (a queue is a bakery line; a deploy is " +
    "a balloon launch), give sections short whimsical titles, and let parenthetical asides wander " +
    "off and snap back. Every so often a small fox interrupts in a blockquote to ask the obvious " +
    "question — answer it kindly. Wonder over rigor, but land every fact.",
  source: "builtin",
  tokens: {
    color: colorTokens({
      bg: "#FFF8E7", surface: "#FBEBC9", text: "#3B2C24", muted: "#7A6455",
      faint: "#A38F7D", accent: "#D8442E", rule: "#E8CFA0", positive: "#1F8A70",
    }),
    font: fontTokens({
      body: ["Baskerville", "Iowan Old Style", "Palatino", "Georgia", "serif"],
      heading: ["Chalkboard SE", "Comic Sans MS", "Segoe Print", "cursive"],
      mono: ["Courier New", "Courier", "monospace"],
    }),
  },
  css: `
  h1.title { transform: rotate(-0.6deg); }
  header.doc { letter-spacing: 0.16em; }
  article h2 { font-size: 15px; letter-spacing: 0.1em; text-transform: none; }
  article h2::after { border-top: 0; height: 8px; background: ${POIGNANT_SQUIGGLE} repeat-x left center; opacity: 0.85; }
  article h3 { transform: rotate(-0.35deg); }
  article a { text-decoration-style: wavy; text-decoration-color: var(--ds-positive); text-underline-offset: 4px; }
  article li::marker { content: "✿ "; color: var(--ds-accent); }
  article blockquote {
    border: 2px solid var(--ds-accent);
    border-radius: 14px 14px 14px 2px;
    font-style: italic;
    transform: rotate(-0.4deg);
  }
  article blockquote::before { content: "🦊"; float: left; margin: 2px 10px 0 0; font-size: 19px; font-style: normal; }
  article pre { border: 1.5px dashed var(--ds-rule); border-radius: 8px; }
  article hr { border: 0; }
  article hr::before { content: "⁂"; display: block; text-align: center; color: var(--ds-accent); font-size: 16px; }
  @media (prefers-reduced-motion: no-preference) {
    header.doc .mark { display: inline-block; animation: px-bob 4s ease-in-out infinite; }
    @keyframes px-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
    article h2:hover { animation: px-wiggle 0.4s ease-in-out; }
    @keyframes px-wiggle { 25% { transform: rotate(0.8deg); } 75% { transform: rotate(-0.8deg); } }
    h1.title .px-hop { display: inline-block; animation: px-hop 0.55s cubic-bezier(0.3, 1.6, 0.4, 1) both; }
    @keyframes px-hop { from { opacity: 0; transform: translateY(14px) rotate(-4deg); } to { opacity: 1; transform: none; } }
  }
${revealCss("opacity: 0; transform: translateY(14px) rotate(0.3deg);", "opacity .6s ease, transform .6s cubic-bezier(.3,1.3,.4,1)")}`,
  effects: revealScript(
    60,
    `  var t = document.querySelector("h1.title");
  if (t && !t.firstElementChild) {
    var text = t.textContent || "";
    t.textContent = "";
    for (var j = 0; j < text.length; j++) {
      var s = document.createElement("span");
      s.textContent = text[j];
      if (text[j] !== " ") {
        s.className = "px-hop";
        s.style.animationDelay = (j * 40) + "ms";
      }
      t.appendChild(s);
    }
  }
`
  ) + "\n" + audioScript({ link: "sparkle", reveal: "bloom", enable: "sparkle" }),
};

// ---------------------------------------------------------------------------
// gazette — art-deco society paper
// ---------------------------------------------------------------------------

export const GAZETTE: DesignSystemDefinition = {
  name: "gazette",
  displayName: "Deco Gazette",
  description:
    "A front-page dispatch from a champagne age — Didone headlines between gold double rules, drop caps, centered diamond section marks.",
  voice:
    "Write as a 1920s society-gazette correspondent covering the work as the season's affair. " +
    "Arch, brisk, faintly conspiratorial. Title-case headlines; a bold lede naming who, what, and " +
    "when in a single sentence; elegant transitions (\"Meanwhile, in the matter of the database…\"). " +
    "Keep the facts crisp beneath the sparkle — the gossip is accurate. Close with a toast.",
  source: "builtin",
  tokens: {
    color: colorTokens({
      bg: "#F7F1E3", surface: "#EFE6CE", text: "#201B12", muted: "#5C523D",
      faint: "#8A7E63", accent: "#8A6A14", rule: "#DCCFA8", positive: "#2E5D4B",
    }),
    font: fontTokens({
      body: ["Georgia", "Charter", "Iowan Old Style", "serif"],
      heading: ["Didot", "Bodoni 72", "Playfair Display", "Georgia", "serif"],
    }),
  },
  css: `
  h1.title {
    font-family: var(--ds-font-heading);
    font-weight: 400;
    font-size: 38px;
    text-align: center;
    border-top: 3px double var(--ds-accent);
    border-bottom: 3px double var(--ds-accent);
    padding: 20px 8px;
  }
  header.doc { letter-spacing: 0.3em; justify-content: center; }
  header.doc .rule { display: none; }
  article > p:first-of-type::first-letter {
    font-family: var(--ds-font-heading);
    font-size: 3.3em;
    float: left;
    line-height: 0.82;
    padding: 5px 8px 0 0;
    color: var(--ds-accent);
  }
  article h2 { display: block; text-align: center; letter-spacing: 0.32em; }
  article h2::before { content: "◆  "; color: var(--ds-accent); }
  article h2::after { content: "  ◆"; display: inline; border-top: 0; transform: none; color: var(--ds-accent); }
  article h3 { font-family: var(--ds-font-heading); font-weight: 500; font-variant: small-caps; }
  article blockquote { border-left: 0; border-top: 1px solid var(--ds-rule); border-bottom: 1px solid var(--ds-rule); background: transparent; text-align: center; font-style: italic; font-size: 17px; }
  article hr { border: 0; }
  article hr::before { content: "— ◆ —"; display: block; text-align: center; color: var(--ds-accent); letter-spacing: 0.5em; }
  footer.doc { border-top: 3px double var(--ds-accent); }
  @media (prefers-reduced-motion: no-preference) {
    h1.title { animation: px-titlecard 0.9s ease-out both; }
    @keyframes px-titlecard { from { opacity: 0; letter-spacing: 0.08em; } to { opacity: 1; letter-spacing: normal; } }
  }
${revealCss("opacity: 0; transform: translateY(12px);", "opacity .7s ease, transform .7s ease")}`,
  effects: revealScript(70) + "\n" + audioScript({ link: "chime", enable: "chime" }),
};

// ---------------------------------------------------------------------------
// riso — risograph zine
// ---------------------------------------------------------------------------

export const RISO: DesignSystemDefinition = {
  name: "riso",
  displayName: "Riso Pop",
  description:
    "A risograph zine — fluorescent pink on warm paper with indigo ink, misregistered overprint titles, sticker pull-quotes, springy reveals.",
  voice:
    "Write like the editor of a beloved zine: loud, warm, direct. Short punchy sentences. " +
    "Verdicts in bold. Headings that sell the section. Lists with strong lead-ins, an occasional " +
    "ALL-CAPS aside, and the single most important number or quote pulled into a blockquote " +
    "sticker. Hype only what the work earned.",
  source: "builtin",
  tokens: {
    color: colorTokens({
      bg: "#FFF7EE", surface: "#FFE8D8", text: "#23205A", muted: "#5A5588",
      faint: "#8B87AE", accent: "#E82563", rule: "#E8D5C4", positive: "#00875F",
    }),
    font: fontTokens({
      body: ["Avenir Next", "Helvetica Neue", "Arial", "sans-serif"],
      heading: ["Futura", "Avenir Next", "Trebuchet MS", "Helvetica Neue", "sans-serif"],
    }),
  },
  css: `
  h1.title {
    font-family: var(--ds-font-heading);
    font-weight: 800;
    font-size: 36px;
    text-transform: uppercase;
    letter-spacing: 0.01em;
    text-shadow: 3px 3px 0 var(--ds-accent);
  }
  article h2 { display: block; font-size: 17px; font-weight: 800; letter-spacing: 0.04em; text-transform: none; color: var(--ds-text); }
  article h2::before { content: "■ "; color: var(--ds-accent); }
  article h2::after { content: none; }
  article li::marker { content: "▸ "; color: var(--ds-accent); }
  article a { color: var(--ds-accent); text-decoration-thickness: 2px; }
  article a:hover { background: var(--ds-accent); color: var(--ds-bg); text-decoration: none; }
  article blockquote {
    border: 3px solid var(--ds-text);
    border-radius: 4px;
    background: var(--ds-bg);
    box-shadow: 6px 6px 0 var(--ds-accent);
    font-weight: 600;
    transform: rotate(-1deg);
  }
  article img { border: 3px solid var(--ds-text); box-shadow: 8px 8px 0 var(--ds-positive); }
  article hr { border: 0; height: 8px; width: 50%; background: repeating-linear-gradient(90deg, var(--ds-accent) 0 14px, transparent 14px 28px); }
  @media (prefers-reduced-motion: no-preference) {
    h1.title { animation: px-overprint 0.5s ease-out both; }
    @keyframes px-overprint { from { text-shadow: 0 0 0 var(--ds-accent); } to { text-shadow: 3px 3px 0 var(--ds-accent); } }
  }
${revealCss("opacity: 0; transform: translateY(12px) scale(0.97);", "opacity .45s ease, transform .55s cubic-bezier(.2,1.5,.35,1)")}`,
  effects:
    revealScript(50) +
    "\n" +
    audioScript({ link: "toggle", reveal: "press", revealSelector: "blockquote, img, table", enable: "success" }),
};

// ---------------------------------------------------------------------------
// sumi — ink on washi
// ---------------------------------------------------------------------------

export const SUMI: DesignSystemDefinition = {
  name: "sumi",
  displayName: "Sumi",
  description:
    "Sumi-e ink on washi paper — a narrow measure, one brush stroke per section, a vermilion seal, and reveals that bleed in like ink.",
  voice:
    "Write with restraint. Short declarative sentences, one idea per paragraph, generous silence " +
    "between sections. No hype and no filler adjectives; prefer the concrete image to the " +
    "abstraction. End each section with a single-line takeaway, and the document with the one " +
    "thing that matters most, alone on its own line.",
  source: "builtin",
  tokens: {
    color: colorTokens({
      bg: "#F7F5EF", surface: "#ECE9DF", text: "#262420", muted: "#6B675C",
      faint: "#9A9587", accent: "#B23A2E", rule: "#D9D4C5", positive: "#5A6B4F",
    }),
    font: fontTokens({
      body: ["Hiragino Mincho ProN", "Yu Mincho", "Songti SC", "Georgia", "serif"],
      heading: ["Hiragino Mincho ProN", "Yu Mincho", "Songti SC", "Georgia", "serif"],
    }),
  },
  css: `
  .sheet { max-width: 580px; }
  body { font-size: 16.5px; line-height: 1.9; letter-spacing: 0.005em; }
  h1.title { font-weight: 500; font-size: 30px; line-height: 1.3; }
  header.doc .mark { background: var(--ds-accent); color: var(--ds-bg); padding: 3px 6px; border-radius: 2px; letter-spacing: 0.1em; }
  header.doc .rule { border-top-color: var(--ds-rule); }
  article h2 { color: var(--ds-text); font-family: var(--ds-font-heading); font-weight: 500; letter-spacing: 0.34em; margin-top: 54px; }
  article h2::before { content: ""; display: inline-block; width: 26px; height: 3px; background: var(--ds-accent); transform: translateY(-4px); }
  article h2::after { content: none; }
  article blockquote { border-left: 1px solid var(--ds-rule); background: transparent; padding: 4px 22px; color: var(--ds-text-muted); font-size: 16px; }
  article li::marker { color: var(--ds-text-faint); }
  article hr { border: 0; width: auto; margin: 46px 0; }
  article hr::before { content: "◦"; display: block; text-align: center; color: var(--ds-text-faint); }
  footer.doc { border-top-color: var(--ds-rule); }
${revealCss("opacity: 0; filter: blur(6px);", "opacity .9s ease, filter 1.1s ease")}`,
  effects:
    revealScript(90) + "\n" + audioScript({ link: "droplet", reveal: "whisper", revealSelector: "h2", enable: "droplet" }),
};

// ---------------------------------------------------------------------------
// teletype — wire-service printout
// ---------------------------------------------------------------------------

export const TELETYPE: DesignSystemDefinition = {
  name: "teletype",
  displayName: "Teletype",
  description:
    "A wire-service teletype on ivory paper — typewriter mono, ribbon-red accents, printout-cadence reveals, and a headline that decodes itself.",
  voice:
    "Write like a clean ops log crossed with a wire dispatch: terse imperative lines, one fact " +
    "per line, exact numbers and commands verbatim in code spans. Prefer bullet lists and tables " +
    "to prose. Prefix key results with ok: / warn: / fail:. No adjectives, no filler; log open " +
    "questions as open questions.",
  source: "builtin",
  tokens: {
    color: colorTokens({
      bg: "#F6F3EA", surface: "#ECE7D8", text: "#2B2A24", muted: "#6B685C",
      faint: "#98937F", accent: "#B3372B", rule: "#DCD5BF", positive: "#2F6B46",
    }),
    font: fontTokens({ body: MONO_STACK, heading: MONO_STACK }),
  },
  css: `
  body { font-size: 15px; line-height: 1.75; }
  h1.title { font-size: 22px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
  h1.title::after { content: "▌"; color: var(--ds-accent); margin-left: 6px; }
  header.doc .mark { border: 1.5px solid var(--ds-accent); color: var(--ds-accent); padding: 2px 6px; transform: rotate(-2deg); }
  article h2 { letter-spacing: 0.24em; }
  article a { text-decoration: none; border-bottom: 1px dashed var(--ds-accent); }
  article blockquote { border-left: 4px double var(--ds-accent); background: transparent; }
  article th { border-bottom: 2px solid var(--ds-text); }
  article hr { border: 0; }
  article hr::before { content: "* * *"; display: block; text-align: center; color: var(--ds-text-faint); letter-spacing: 0.4em; }
  ::selection { background: var(--ds-accent); color: var(--ds-bg); }
  @media (prefers-reduced-motion: no-preference) {
    h1.title::after { animation: px-blink 1.1s steps(1) infinite; }
    @keyframes px-blink { 50% { opacity: 0; } }
  }
${revealCss("opacity: 0;", "opacity .12s linear")}`,
  effects: revealScript(
    55,
    `  var t = document.querySelector("h1.title");
  if (t) {
    var done = t.textContent || "";
    var glyphs = "#%&@$=+*:.▓▒░";
    var tick = 0;
    var timer = setInterval(function () {
      tick++;
      var settled = Math.floor(tick * done.length / 22);
      var out = "";
      for (var j = 0; j < done.length; j++) {
        out += (j <= settled || done[j] === " ") ? done[j] : glyphs[Math.floor(Math.random() * glyphs.length)];
      }
      t.textContent = out;
      if (settled >= done.length) clearInterval(timer);
    }, 45);
  }
`
  ) + "\n" + audioScript({ link: "tick", reveal: "tick", enable: "ready" }),
};

// ---------------------------------------------------------------------------
// solidified-sky — the Descent & Transformation guide
// (IA pattern extracted Feb 2026 from maninae.github.io/solidified-sky —
// "A Tree Is Made of Air" — into the claude-design doc "Descent +
// Transformation IA Pattern"; palette carried over from that analysis.)
// ---------------------------------------------------------------------------

export const SOLIDIFIED_SKY: DesignSystemDefinition = {
  name: "solidified-sky",
  displayName: "Solidified Sky",
  description:
    "The Descent & Transformation guide — paper, forest green, and ochre; numbered magnification stops that zoom macro to micro while one tracked thing changes state.",
  voice:
    "Structure the document as a descent: a fixed sequence of magnification stops, widest frame " +
    "first, each h2 revealing one nested part of the level before it. Bind a transformation to " +
    "the descent — one tracked unit enters in a starting state and leaves changed, and every " +
    "section must advance both the zoom and the state together. Open each stop with a question " +
    "that makes the reader's default assumption feel wrong; answer it in plain language before " +
    "any jargon; then break the mechanism into two or three labeled chunks (a mermaid diagram " +
    "counts as one). Close a stop by correcting one misconception OR folding deeper detail into " +
    "an aside — never both. End the document with one callback that ties the last stop to the " +
    "first, turning the line into a loop.",
  source: "builtin",
  tokens: {
    color: colorTokens({
      bg: "#F7F5F0", surface: "#EEF3EE", text: "#1B1F1C", muted: "#52584F",
      faint: "#8A9086", accent: "#3C6E56", rule: "#E4E0D6", positive: "#2F9E5C",
    }),
    font: fontTokens({
      body: SANS_HEADING,
      heading: ["Avenir Next", "Futura", "Helvetica Neue", "Segoe UI", "sans-serif"],
    }),
  },
  css: `
  article { counter-reset: stop; }
  article h2 { counter-increment: stop; letter-spacing: 0.14em; }
  article h2::before { content: "↓ stop " counter(stop, decimal-leading-zero); color: var(--ds-bg); background: var(--ds-accent); padding: 2px 8px; border-radius: 999px; letter-spacing: 0.08em; font-size: 10px; }
  article h4 { color: #A8762C; }
  article blockquote { background: var(--ds-surface); border-left: 3px solid var(--ds-accent); border-radius: 10px; }
  article table th { border-bottom: 2px solid var(--ds-accent); }
  article hr { border: 0; }
  article hr::before { content: "↓"; display: block; text-align: center; color: var(--ds-text-faint); }
  article pre.mermaid { border-radius: 12px; }
${revealCss("opacity: 0; transform: translateY(14px) scale(1.015);", "opacity .6s ease, transform .65s cubic-bezier(.25,.8,.3,1)")}`,
  effects:
    revealScript(65) + "\n" + audioScript({ link: "tick", reveal: "page", revealSelector: "h2", enable: "ready" }),
};

export const BUILTIN_DESIGN_SYSTEMS: DesignSystemDefinition[] = [
  PIDGIN_EDITORIAL,
  BOARDROOM,
  POIGNANT,
  SOLIDIFIED_SKY,
  GAZETTE,
  RISO,
  SUMI,
  TELETYPE,
];
