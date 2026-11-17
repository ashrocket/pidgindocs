import { describe, expect, it } from "vitest";
import { operatorReader, sanitizeReaderHtml } from "../core/documents/operator-reader";

describe("operator reader isolation", () => {
  it("renders rejected authored links as ordinary text", async () => {
    const html = await sanitizeReaderHtml('<p><a href="javascript:alert(1)">Unsafe reference</a> and <a>missing destination</a>.</p>');
    expect(html).toBe('<p>Unsafe reference and missing destination.</p>');
  });
  it("removes raw-text containers instead of reactivating their unchecked markup", async () => {
    for (const tag of ["xmp", "plaintext", "noembed", "noframes", "textarea", "title"]) {
      const html = await sanitizeReaderHtml(`<${tag}><meta http-equiv="refresh" content="0;url=https://example.invalid/escape"><img src=x onerror="alert(1)"></${tag}>`);
      expect(html, tag).not.toContain("http-equiv");
      expect(html, tag).not.toContain("example.invalid");
      expect(html, tag).not.toContain("onerror");
    }
  });
  it("retains readable structure and strips active HTML, styling and unsafe URLs", async () => {
    const html = await sanitizeReaderHtml('<html><head><style>body{display:none}</style></head><body><h2 onclick="alert(1)">Decision</h2><p style="color:white">Keep <strong>the full text</strong>.</p><ul><li>First</li></ul><pre><code>&lt;script&gt; is text</code></pre><table><tr><th scope="col">Result</th><td colspan="2">Ready</td></tr></table><a href="https://example.invalid/report">Report</a><a href="javascript:alert(1)">Unsafe</a><script>window.attack=true</script><iframe src="/api/private"></iframe><svg><a href="javascript:alert(1)">SVG</a></svg><form action="/api/private"><input name="x"></form><img src="/api/private" onerror="alert(1)"></body></html>');
    expect(html).toContain('<h2>Decision</h2>');
    expect(html).toContain('<strong>the full text</strong>');
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('<pre tabindex="0"><code>&lt;script&gt; is text</code></pre>');
    expect(html).toContain('scope="col"');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('href="https://example.invalid/report"');
    expect(html).not.toMatch(/<script|<style|<iframe|<svg|<form|<img|onclick=|onerror=|style=|javascript:|\/api\/private/);
  });

  it("preserves inline raster diagrams but blocks external and SVG images", async () => {
    const html = await sanitizeReaderHtml('<figure><img src="data:image/png;base64,aGVsbG8=" alt="Release diagram" onerror="alert(1)"><figcaption>The release flow</figcaption></figure><img src="https://evil.invalid/track" alt="External image"><img src="data:image/svg+xml;base64,PHN2Zz4=" onload="alert(1)">');
    expect(html).toContain('src="data:image/png;base64,aGVsbG8="');
    expect(html).toContain('alt="Release diagram"');
    expect(html).toContain('<figcaption>The release flow</figcaption>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('evil.invalid');
    expect(html).not.toContain('image/svg');
  });

  it("scopes known authored app links once and preserves explicit deployment paths", async () => {
    const html = await sanitizeReaderHtml('<a href="/docs/one?token=x">One</a><a href="/alice/docs/two">Two</a><a href="/bob/docs/three">Three</a><a href="https://example.invalid/docs/four">Four</a>', '/alice');
    expect(html).toContain('href="/alice/docs/one?token=x"');
    expect(html).toContain('href="/alice/docs/two"');
    expect(html).toContain('href="/bob/docs/three"');
    expect(html).toContain('href="https://example.invalid/docs/four"');
    expect(html).not.toContain('/alice/alice');
    const reader = await operatorReader({ base: '/alice', rawHtml: '<p>Text</p>', title: 'Scoped', sourceUrl: 'javascript:bad', returnUrl: 'javascript:bad', returnLabel: 'Back to workspace' });
    expect(reader.html).toContain('href="/alice/workspace"');
    expect(reader.html).not.toContain('href="/workspace"');
  });

  it("keeps an opaque origin and allows only its nonced reader controls", async () => {
    const result = await operatorReader({ rawHtml: '<p>Selectable text</p><script>alert(1)</script>', title: 'A <safe> title', sourceUrl: '/docs/id?token=a&expires=1', returnUrl: '/workspace?view=board', returnLabel: 'Back to Bulletin' });
    expect(result.csp).toContain('sandbox allow-scripts allow-downloads;');
    expect(result.csp).not.toContain('allow-same-origin');
    expect(result.csp).not.toContain("'unsafe-inline'");
    expect(result.csp).toContain("connect-src 'none'");
    expect(result.html).toContain('A &lt;safe&gt; title');
    expect(result.html).toContain('/docs/id?token=a&amp;expires=1');
    expect(result.html).not.toContain('alert(1)');
    expect(result.html).not.toContain('user-select: none');
    expect(result.html).not.toContain('localStorage');
    expect(result.html).not.toContain('replaceState');
  });
});
