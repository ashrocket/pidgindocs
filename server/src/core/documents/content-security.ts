/** Authored HTML has an opaque origin, even when viewed on the product's host.
 * Scripts and local downloads work; cookies, DOM access to the app, popups,
 * form submissions and network access do not.
 *
 * `assets` names the one script source a typeset document may load besides
 * its inline scripts: this host's `/a/assets/` (the mermaid renderer and the
 * sound module the typesetter links). Under the sandbox the page's origin is
 * opaque, so 'self' would not match; the host must be spelled out, as the
 * artifact CSP does. Without it the page still runs inline scripts only. */
export function documentContentCsp(assets?: string): string {
  const scriptSrc = assets ? `${assets} 'unsafe-inline'` : "'unsafe-inline'";
  return (
    `sandbox allow-scripts allow-downloads; default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; ` +
    "img-src data: blob:; font-src data:; media-src data: blob:; " +
    "connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
  );
}

export const DOCUMENT_CONTENT_CSP = documentContentCsp();
