import { describe, expect, it } from "vitest";
import {
  appHref, appPath, appRootUrl, basePath, clientBase, clientBaseScript, prefixBasePath, prefixCookiePath, routePath, stripBasePath,
} from "../core/base-path";

describe("basePath", () => {
  it("treats unset and empty values as no base", () => {
    expect(basePath({})).toBe("");
    expect(basePath({ BASE_PATH: "" })).toBe("");
    expect(basePath({ BASE_PATH: "  " })).toBe("");
  });

  it("returns a normalized /name", () => {
    expect(basePath({ BASE_PATH: "/alice" })).toBe("/alice");
    expect(basePath({ BASE_PATH: "/alice/" })).toBe("/alice");
    expect(basePath({ BASE_PATH: " /alice-smith " })).toBe("/alice-smith");
    expect(basePath({ BASE_PATH: "/a1b" })).toBe("/a1b");
    expect(basePath({ BASE_PATH: "/" + "a".repeat(31) })).toBe("/" + "a".repeat(31));
  });

  it.each([
    "alice", "/", "//", "/Alice", "/ab", "/a", "/1abc", "/-abc", "/abc-", "/ab_c", "/a b c", "/alice/x", "/alice//",
    "/" + "a".repeat(32), "/alice?x=1", "/alice#", "/ali.ce", "/%61lice", "https://example.test/alice", "/..", "/alice/..",
  ])("throws for %s so a bad config fails closed", (value) => {
    expect(() => basePath({ BASE_PATH: value })).toThrow(/BASE_PATH/);
  });

  it("throws for a value that is not a string", () => {
    expect(() => basePath({ BASE_PATH: 5 as unknown as string })).toThrow(/BASE_PATH/);
  });
});

describe("appPath", () => {
  it("adds the base and leaves paths alone without one", () => {
    expect(appPath({ BASE_PATH: "/alice" }, "/workspace")).toBe("/alice/workspace");
    expect(appPath({ BASE_PATH: "/alice" }, "/")).toBe("/alice/");
    expect(appPath({ BASE_PATH: "/alice" }, "/workspace?view=board#x")).toBe("/alice/workspace?view=board#x");
    expect(appPath({}, "/workspace")).toBe("/workspace");
    expect(appPath({ BASE_PATH: "" }, "/workspace")).toBe("/workspace");
  });

  it("accepts a base that basePath() already returned", () => {
    expect(appPath("/alice", "/setup")).toBe("/alice/setup");
    expect(appPath("", "/setup")).toBe("/setup");
    expect(() => appPath("alice", "/setup")).toThrow(/BASE_PATH/);
  });

  it("rejects anything that is not an absolute app path", () => {
    for (const path of ["", "workspace", "//evil.example", "/\\evil.example", "https://evil.example/x"]) {
      expect(() => appPath({ BASE_PATH: "/alice" }, path)).toThrow(RangeError);
    }
  });
});

describe("routePath", () => {
  it("returns an app route-space path unchanged, whatever the base", () => {
    expect(routePath("/help")).toBe("/help");
    expect(routePath("/workspace?view=board")).toBe("/workspace?view=board");
    expect(() => routePath("help")).toThrow(RangeError);
    expect(() => routePath("//evil.example")).toThrow(RangeError);
  });
});

describe("absolute URLs", () => {
  it("appHref keeps the prefix that new URL('/x', WORKER_URL) drops", () => {
    expect(new URL("/signin", "https://example.test/alice").href).toBe("https://example.test/signin");
    expect(appHref({ BASE_PATH: "/alice", WORKER_URL: "https://example.test/alice" }, "/signin")).toBe("https://example.test/alice/signin");
    // Right whether or not WORKER_URL carries the prefix.
    expect(appHref({ BASE_PATH: "/alice", WORKER_URL: "https://example.test" }, "/signin?next=%2Fa")).toBe("https://example.test/alice/signin?next=%2Fa");
  });

  it("appHref without a base equals the expression it replaces", () => {
    for (const url of ["https://team.example.test", "https://team.example.test/", "http://localhost:8787"]) {
      expect(appHref({ WORKER_URL: url }, "/signin?next=%2Fa")).toBe(new URL("/signin?next=%2Fa", url).href);
    }
  });

  it("appRootUrl returns WORKER_URL untouched without a base, otherwise origin plus base", () => {
    expect(appRootUrl({ WORKER_URL: "https://example.test" })).toBe("https://example.test");
    expect(appRootUrl({ BASE_PATH: "/alice", WORKER_URL: "https://example.test/alice" })).toBe("https://example.test/alice");
    expect(appRootUrl({ BASE_PATH: "/alice", WORKER_URL: "https://example.test" })).toBe("https://example.test/alice");
    expect(appRootUrl({ BASE_PATH: "/alice", WORKER_URL: "" }, "https://example.test")).toBe("https://example.test/alice");
  });
});

describe("client constant", () => {
  it("defines APP_BASE as a JSON string", () => {
    expect(clientBase({ BASE_PATH: "/alice" })).toBe('window.APP_BASE="/alice";');
    expect(clientBase({})).toBe('window.APP_BASE="";');
    expect(clientBaseScript({ BASE_PATH: "/alice" }, "n0nce")).toBe('<script nonce="n0nce">window.APP_BASE="/alice";</script>');
    expect(clientBaseScript("/alice")).toBe('<script>window.APP_BASE="/alice";</script>');
  });
});

describe("request adapter", () => {
  const base = { BASE_PATH: "/alice" };
  const strip = (url: string, init?: RequestInit) => stripBasePath(new Request(url, init), base);

  it("removes the prefix and keeps method, query, headers and body", async () => {
    const result = strip("https://example.test/alice/api/messages?limit=5&q=a%2Fb", {
      method: "POST", headers: { "X-Test": "1", "Content-Type": "text/plain" }, body: "hello",
    });
    expect(result).toBeInstanceOf(Request);
    const request = result as Request;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://example.test/api/messages?limit=5&q=a%2Fb");
    expect(request.headers.get("X-Test")).toBe("1");
    expect(await request.text()).toBe("hello");
  });

  it("maps /alice/ to the app root", () => {
    expect((strip("https://example.test/alice/") as Request).url).toBe("https://example.test/");
  });

  it("redirects /alice to /alice/ and keeps the query string", () => {
    const plain = strip("https://example.test/alice") as Response;
    expect(plain.status).toBe(308);
    expect(plain.headers.get("Location")).toBe("/alice/");
    expect((strip("https://example.test/alice?next=%2Fa") as Response).headers.get("Location")).toBe("/alice/?next=%2Fa");
  });

  it.each([
    "https://example.test/", "https://example.test/api/messages", "https://example.test/alicex/api", "https://example.test/alicex",
    "https://example.test/Alice/api", "https://example.test/bob/alice/api", "https://example.test//alice/api", "https://example.test/alice-/api",
  ])("answers 404 for %s", (url) => {
    const result = strip(url) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(404);
  });

  it("does not let dot segments escape the prefix", () => {
    expect((strip("https://example.test/alice/../bob/api") as Response).status).toBe(404);
  });

  it("returns the request itself when there is no base", () => {
    const request = new Request("https://example.test/api/messages");
    expect(stripBasePath(request, {})).toBe(request);
    expect(stripBasePath(request, "")).toBe(request);
  });
});

describe("response adapter", () => {
  const base = { BASE_PATH: "/alice" };
  const COOKIE = "session=abc%20def; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000";

  it("adds the prefix to a Location that starts with a single slash", () => {
    const redirect = (location: string) => prefixBasePath(new Response(null, { status: 302, headers: { Location: location } }), base).headers.get("Location");
    expect(redirect("/workspace")).toBe("/alice/workspace");
    expect(redirect("/")).toBe("/alice/");
    expect(redirect("/setup?saved=key-revoked")).toBe("/alice/setup?saved=key-revoked");
    expect(redirect("https://example.test/alice/workspace")).toBe("https://example.test/alice/workspace");
    expect(redirect("//evil.example/x")).toBe("//evil.example/x");
    expect(redirect("/\\evil.example")).toBe("/\\evil.example");
    expect(redirect("example-app://auth/google?code=1")).toBe("example-app://auth/google?code=1");
    expect(redirect("relative/page")).toBe("relative/page");
  });

  it("works on the immutable headers of Response.redirect", () => {
    const result = prefixBasePath(Response.redirect("https://example.test/alice/x", 302), base);
    expect(result.headers.get("Location")).toBe("https://example.test/alice/x");
    expect(result.status).toBe(302);
  });

  it("sets Path=/alice/ on cookies whose Path is / and keeps every other attribute", () => {
    expect(prefixCookiePath(COOKIE, base)).toBe("session=abc%20def; HttpOnly; Secure; SameSite=Lax; Path=/alice/; Max-Age=2592000");
    expect(prefixCookiePath("a=b; path=/; SameSite=Strict", base)).toBe("a=b; path=/alice/; SameSite=Strict");
    expect(prefixCookiePath("a=b;Path=/;HttpOnly", base)).toBe("a=b;Path=/alice/;HttpOnly");
  });

  it("keeps scoped login cookies reachable at the prefixed callback", () => {
    expect(prefixCookiePath("example_login=x; HttpOnly; Secure; SameSite=Lax; Path=/auth/entra; Max-Age=600", base))
      .toBe("example_login=x; HttpOnly; Secure; SameSite=Lax; Path=/alice/auth/entra; Max-Age=600");
  });

  it("leaves a cookie without Path, a value that spells Path, and a non-app Path alone", () => {
    expect(prefixCookiePath("a=b; HttpOnly", base)).toBe("a=b; HttpOnly");
    expect(prefixCookiePath("note=Path=/; HttpOnly", base)).toBe("note=Path=/; HttpOnly");
    expect(prefixCookiePath("a=b; Path=//x", base)).toBe("a=b; Path=//x");
  });

  it("rewrites each Set-Cookie header separately and keeps the rest of the response", async () => {
    const headers = new Headers({ "Content-Type": "text/html", "X-Keep": "yes" });
    headers.append("Set-Cookie", COOKIE);
    headers.append("Set-Cookie", "other=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/");
    headers.set("Location", "/workspace");
    const result = prefixBasePath(new Response("body", { status: 303, statusText: "See Other", headers }), base);
    expect(result.status).toBe(303);
    expect(result.statusText).toBe("See Other");
    expect(result.headers.get("X-Keep")).toBe("yes");
    expect(result.headers.get("Location")).toBe("/alice/workspace");
    expect((result.headers as Headers & { getSetCookie(): string[] }).getSetCookie()).toEqual([
      "session=abc%20def; HttpOnly; Secure; SameSite=Lax; Path=/alice/; Max-Age=2592000",
      "other=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/alice/",
    ]);
    expect(await result.text()).toBe("body");
  });

  it("returns a response with nothing to change as is, and no-base responses as is", () => {
    const plain = new Response("x");
    expect(prefixBasePath(plain, base)).toBe(plain);
    const withLocation = new Response(null, { status: 302, headers: { Location: "/x" } });
    expect(prefixBasePath(withLocation, {})).toBe(withLocation);
    expect(prefixBasePath(withLocation, "")).toBe(withLocation);
  });
});
