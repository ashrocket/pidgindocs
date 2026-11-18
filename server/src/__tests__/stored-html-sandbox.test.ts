// Release gate for the hosted edition on the shared origin:
// every response that serves
// user-authored HTML runs it in an opaque origin, so a page of one Solo user can
// never read another user's cookies or call their API.
import { describe, expect, it } from "vitest";
import { DOCUMENT_CONTENT_CSP, documentContentCsp } from "../core/documents/content-security";
import { artifactCsp } from "../core/artifacts/render";

const FORBIDDEN = ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals"];

function expectOpaque(csp: string) {
  const sandbox = csp.split(";").map(part => part.trim()).find(part => part.startsWith("sandbox"));
  expect(sandbox, csp).toBeTruthy();
  for (const token of FORBIDDEN) expect(csp, token).not.toContain(token);
  expect(csp).toMatch(/form-action 'none'/);
  expect(csp).toMatch(/base-uri 'none'/);
}

describe("stored HTML always runs in an opaque origin", () => {
  it("documents", () => {
    expectOpaque(DOCUMENT_CONTENT_CSP);
    expect(DOCUMENT_CONTENT_CSP).toMatch(/connect-src 'none'/);
  });

  it("documents that load the host's renderer assets stay opaque and offline", () => {
    const csp = documentContentCsp("https://example.test/alice/a/assets/");
    expectOpaque(csp);
    expect(csp).toContain("script-src https://example.test/alice/a/assets/ 'unsafe-inline';");
    expect(csp).toMatch(/connect-src 'none'/);
  });

  it("artifacts, with and without capabilities, framed or not", () => {
    for (const capabilities of [false, true])
      for (const frame of ["'none'", "https://example.test"])
        expectOpaque(artifactCsp(capabilities, frame, "https://acme.example.test", "a1"));
  });

  it("a Solo artifact's runtime and assets stay under that user's prefix", () => {
    const csp = artifactCsp(true, "'none'", "https://example.test/alice", "a1");
    expectOpaque(csp);
    expect(csp).toContain("connect-src https://example.test/alice/api/artifacts/a1/rt/;");
    expect(csp).toContain("script-src https://example.test/alice/a/assets/ ");
    expect(csp).not.toMatch(/connect-src https:\/\/example\.test\/(?!alice\/)/);
    // Without capabilities an artifact cannot connect anywhere.
    expect(artifactCsp(false, "'none'", "https://example.test/alice", "a1")).toContain("connect-src 'none';");
  });
});
