/**
 * Headers for a first-party HTML page that runs its own scripts.
 *
 * Only a script that carries the page nonce runs, so an injected inline script or
 * event-handler attribute stays inert. Styles stay inline. style-src is stated on
 * purpose: withWebTranslation (web/translation.ts) adds a style nonce when a policy has
 * no style-src, and that would block the page's inline styles. It leaves a style-src
 * with 'unsafe-inline' alone and reuses the script nonce.
 *
 * frame-ancestors 'self' keeps another site from framing a signed-in page (clickjacking).
 * Same-origin framing stays allowed.
 */
export function pageCsp(nonce: string): string {
  return `script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`;
}

export function pageHeaders(nonce: string): Record<string, string> {
  return { "Content-Type": "text/html", "Content-Security-Policy": pageCsp(nonce) };
}
