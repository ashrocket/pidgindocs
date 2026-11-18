/** Zoom for rendered Mermaid diagrams, injected when a stored document is served.
 *
 * Documents store their HTML at publish time, so this is added in the viewer
 * rather than by the typesetter: every published document with a diagram gets
 * it, old ones included. It waits for the page's own renderer to replace each
 * `pre.mermaid` source with an SVG, then wraps the diagram in a clipped frame
 * with its own zoom:
 *
 * - toolbar: zoom out, zoom level (click to reset), zoom in, expand to the window;
 * - ⌘/Ctrl + scroll and trackpad pinch (including Safari's gesture events) zoom
 *   the diagram around the pointer and never the page; a plain scroll still
 *   scrolls the page;
 * - touch: two-finger pinch zooms the diagram; one finger scrolls the page
 *   until the diagram is zoomed, then pans it;
 * - drag pans a zoomed diagram; double-click zooms in, or resets when zoomed;
 * - keys inside a focused diagram: + − 0, and Esc closes the expanded view.
 *
 * The page runs sandboxed with an opaque origin and no network, so nothing is
 * stored or fetched; the expanded view is a fixed overlay, not the Fullscreen API. */

const STYLE = `<style>
  .dz-frame { position: relative; margin: 0 0 16px; outline: none; }
  .dz-frame .dz-view { position: relative; overflow: hidden; touch-action: pan-x pan-y; }
  .dz-frame .dz-view pre.mermaid { margin: 0; transform-origin: 0 0; }
  .dz-frame.dz-zoomed .dz-view { touch-action: none; cursor: grab; }
  .dz-frame.dz-dragging .dz-view { cursor: grabbing; }
  .dz-frame.dz-dragging, .dz-frame.dz-dragging * { -webkit-user-select: none; user-select: none; }
  .dz-bar {
    position: absolute; top: 8px; right: 8px; z-index: 2; display: flex; gap: 2px; padding: 2px;
    border: 1px solid var(--ds-rule, rgba(0,0,0,.15)); border-radius: 8px;
    background: var(--ds-bg, #fff); color: var(--ds-text, #222);
    box-shadow: 0 1px 4px rgba(0,0,0,.08);
    opacity: 0; transition: opacity .15s;
    font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .dz-frame:hover .dz-bar, .dz-frame:focus-within .dz-bar, .dz-frame.dz-zoomed .dz-bar, .dz-frame.dz-open .dz-bar { opacity: 1; }
  @media (hover: none) { .dz-bar { opacity: 1; } }
  .dz-btn {
    min-width: 28px; height: 26px; padding: 0 6px; border: 0; border-radius: 6px;
    background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  .dz-btn:hover { background: var(--ds-surface, rgba(0,0,0,.06)); }
  .dz-btn:focus-visible { outline: 2px solid var(--ds-accent, #1f5554); outline-offset: 1px; }
  .dz-level { min-width: 46px; font-variant-numeric: tabular-nums; }
  .dz-frame.dz-open .dz-view {
    position: fixed; inset: 0; z-index: 2147483000; background: var(--ds-bg, #fff);
    touch-action: none; cursor: grab;
  }
  .dz-frame.dz-open .dz-view pre.mermaid {
    width: 100%; height: 100%; border: 0; border-radius: 0; padding: 24px;
    display: flex; align-items: center; justify-content: center; overflow: visible;
  }
  .dz-frame.dz-open .dz-view pre.mermaid svg { max-width: none !important; width: 100%; height: 100%; }
  .dz-frame.dz-open .dz-bar { position: fixed; top: 12px; right: 12px; z-index: 2147483001; }
  @media print {
    .dz-bar { display: none !important; }
    .dz-frame .dz-view pre.mermaid { transform: none !important; }
  }
</style>`;

const SCRIPT = `<script>
(function () {
  var MAX = 8;
  function setup(pre) {
    if (pre.getAttribute('data-dz') || !pre.querySelector('svg')) return;
    pre.setAttribute('data-dz', '1');
    var frame = document.createElement('div');
    frame.className = 'dz-frame';
    frame.tabIndex = -1;
    var view = document.createElement('div');
    view.className = 'dz-view';
    pre.parentNode.insertBefore(frame, pre);
    view.appendChild(pre);
    frame.appendChild(view);
    var bar = document.createElement('div');
    bar.className = 'dz-bar';
    frame.appendChild(bar);
    function button(label, text, run) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dz-btn';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.textContent = text;
      b.addEventListener('click', function (e) { e.stopPropagation(); run(); });
      bar.appendChild(b);
      return b;
    }
    var s = 1, x = 0, y = 0, open = false, held = null;

    function clamp() {
      var w = view.clientWidth, h = view.clientHeight;
      x = Math.min(0, Math.max(w - w * s, x));
      y = Math.min(0, Math.max(h - h * s, y));
    }
    function apply() {
      clamp();
      pre.style.transform = s === 1 ? '' : 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
      frame.classList.toggle('dz-zoomed', s > 1);
      level.textContent = Math.round(s * 100) + '%';
    }
    function zoomAt(cx, cy, factor) {
      var r = view.getBoundingClientRect();
      var next = Math.min(MAX, Math.max(1, s * factor));
      var k = next / s, px = cx - r.left, py = cy - r.top;
      x = px - (px - x) * k;
      y = py - (py - y) * k;
      s = next;
      apply();
    }
    function zoomCentre(factor) {
      var r = view.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    }
    function reset() { s = 1; x = 0; y = 0; apply(); }
    function setOpen(next) {
      if (next === open) return;
      open = next;
      if (open) {
        frame.style.height = frame.offsetHeight + 'px';
        frame.classList.add('dz-open');
        document.documentElement.style.overflow = 'hidden';
        expand.textContent = '\\u2715';
        expand.title = 'Close';
        expand.setAttribute('aria-label', 'Close');
        frame.focus({ preventScroll: true });
      } else {
        frame.classList.remove('dz-open');
        frame.style.height = '';
        document.documentElement.style.overflow = '';
        expand.textContent = '\\u2922';
        expand.title = 'Expand diagram';
        expand.setAttribute('aria-label', 'Expand diagram');
      }
      reset();
    }

    button('Zoom out', '\\u2212', function () { zoomCentre(1 / 1.5); });
    var level = button('Reset zoom', '100%', reset);
    level.classList.add('dz-level');
    button('Zoom in', '+', function () { zoomCentre(1.5); });
    var expand = button('Expand diagram', '\\u2922', function () { setOpen(!open); });

    // Trackpad pinch arrives as ctrl+wheel in Chrome, Edge and Firefox; Safari also sends gesture events.
    var gesture = false, gestureBase = 1;
    view.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Pinch sends small deltas; a mouse-wheel notch is ~100, so cap a step near 1.5x.
        var dy = Math.max(-40, Math.min(40, e.deltaY * (e.deltaMode === 1 ? 5 : 1)));
        if (!gesture) zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
      } else if (open) {
        e.preventDefault();
        x -= e.deltaX; y -= e.deltaY; apply();
      }
    }, { passive: false });
    view.addEventListener('gesturestart', function (e) { e.preventDefault(); gesture = true; gestureBase = s; });
    view.addEventListener('gesturechange', function (e) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, (gestureBase * e.scale) / s);
    });
    view.addEventListener('gestureend', function (e) { e.preventDefault(); gesture = false; });

    // Pointers: one drags a zoomed diagram, two pinch.
    var points = {};
    function list() { return Object.keys(points).map(function (k) { return points[k]; }); }
    view.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      points[e.pointerId] = { x: e.clientX, y: e.clientY };
      var all = list();
      if (all.length === 2) {
        held = { d: Math.hypot(all[0].x - all[1].x, all[0].y - all[1].y) || 1 };
      } else if (all.length === 1 && (s > 1 || open)) {
        held = { px: e.clientX, py: e.clientY };
        frame.classList.add('dz-dragging');
      } else return;
      try { view.setPointerCapture(e.pointerId); } catch (_) {}
    });
    view.addEventListener('pointermove', function (e) {
      if (!points[e.pointerId] || !held) return;
      points[e.pointerId] = { x: e.clientX, y: e.clientY };
      var all = list();
      if (all.length === 2 && held.d) {
        if (gesture) return; // Safari's gesture events already drive this pinch.
        var d = Math.hypot(all[0].x - all[1].x, all[0].y - all[1].y) || 1;
        zoomAt((all[0].x + all[1].x) / 2, (all[0].y + all[1].y) / 2, d / held.d);
        held.d = d;
      } else if (all.length === 1 && held.px !== undefined) {
        x += e.clientX - held.px; y += e.clientY - held.py;
        held.px = e.clientX; held.py = e.clientY;
        apply();
      }
    });
    function lift(e) {
      delete points[e.pointerId];
      if (list().length === 0) { held = null; frame.classList.remove('dz-dragging'); }
      else if (held && held.d) held = null;
    }
    view.addEventListener('pointerup', lift);
    view.addEventListener('pointercancel', lift);
    view.addEventListener('dblclick', function (e) {
      e.preventDefault();
      if (s > 1) reset(); else zoomAt(e.clientX, e.clientY, 2);
    });
    frame.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') { zoomCentre(1.5); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { zoomCentre(1 / 1.5); e.preventDefault(); }
      else if (e.key === '0') { reset(); e.preventDefault(); }
      else if (e.key === 'Escape' && open) { setOpen(false); e.preventDefault(); }
    });
    view.addEventListener('click', function () { frame.focus({ preventScroll: true }); });
    addEventListener('resize', apply);
    apply();
  }

  function scan() {
    var pending = document.querySelectorAll('pre.mermaid:not([data-dz])');
    for (var i = 0; i < pending.length; i++) setup(pending[i]);
    return document.querySelectorAll('pre.mermaid:not([data-dz])').length;
  }
  if (!scan()) return;
  var watch = new MutationObserver(function () { if (!scan()) watch.disconnect(); });
  watch.observe(document.body, { childList: true, subtree: true });
})();
</script>`;

/** The style and script that give every rendered diagram its own zoom. */
export const DIAGRAM_ZOOM = STYLE + SCRIPT;

/** Stored HTML that holds a Mermaid diagram source. */
export function hasDiagram(html: string): boolean {
  return /<pre\b[^>]*class=["'][^"']*\bmermaid\b/i.test(html);
}
