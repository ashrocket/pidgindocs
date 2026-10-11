import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { sha256Hex } from "../auth-utils";
import type { Env } from "../types";
import { buildIndex, flatten, htmlToText, metadataCandidates, splitPassages } from "../jevbox/indexing";
import { createTraversal, type RouteNode } from "../jevbox/beam-search";
import { buildAnswerPrompt, citedNumbers } from "../jevbox/answer";
import { rank } from "../jevbox/retrieval";

// Jevbox library search in PidginDocs: local indexing, JEV beam routing, passage
// scoring, and cited answers, through the real pidgindocs.example.workers.dev host route
// against migrated D1 and R2. TypeSafe and Anthropic responses are stubbed.

type TestEnv = Env & {
  TEST_MIGRATIONS: D1Migration[];
};

const baseEnv = {
  ...bindings,
  API_KEY: "jevbox-test-key",
  OWNER_EMAIL: "owner@example.com",
  WORKER_URL: "https://pidgindocs.example.workers.dev",
  ENVIRONMENT: "production",
  TYPESAFE_API_KEY: "ts-test-key",
  ANTHROPIC_API_KEY: "sk-test",
} as unknown as TestEnv;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(async () => { await applyD1Migrations(baseEnv.DB, baseEnv.TEST_MIGRATIONS); });
afterEach(() => vi.unstubAllGlobals());

type Json = any;

async function makeUser(label: string, env: TestEnv = baseEnv) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const key = `pidgin_sk_${id}`;
  await env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, `${id}@example.com`).run();
  await env.DB.prepare("INSERT INTO api_keys (key_hash, key_prefix, user_id) VALUES (?, ?, ?)")
    .bind(await sha256Hex(key), "pidgin_sk", id).run();
  const api = async (path: string, init: RequestInit = {}, targetEnv: TestEnv = env): Promise<{ status: number; body: Json }> => {
    const response = await worker.fetch(new Request(`https://pidgindocs.example.workers.dev${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    }), targetEnv, ctx);
    return { status: response.status, body: await response.json() };
  };
  return { id, api };
}

async function addDoc(userId: string, title: string, label: string, markdown: string) {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO messages (id, type, title, body, doc_key, priority, doc_slug, doc_version, is_latest,
       instance_model, instance_session_id, instance_project, instance_source, user_id, source_size)
     VALUES (?, 'document', ?, 'summary', ?, 'normal', ?, 1, 1, 'test', 's', ?, 'test', ?, ?)`
  ).bind(id, title, `docs/${id}.html`, id, label, userId, markdown.length).run();
  await baseEnv.DOCS.put(`docs/${id}.md`, markdown);
  await baseEnv.DOCS.put(`docs/${id}.html`, `<html><body>${markdown}</body></html>`);
  return id;
}

async function addArtifact(userId: string, title: string, label: string | null, html: string, version = 1) {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    "INSERT INTO artifacts (id, user_id, title, favicon, instance_project, current_version) VALUES (?, ?, ?, '🕊️', ?, ?)"
  ).bind(id, userId, title, label, version).run();
  await baseEnv.DOCS.put(`artifacts/${id}/v${version}.html`, html);
  return id;
}

// A deterministic stand-in for JEV: Choice prefers options whose text
// mentions the keyword; Score rates evidence by whether it contains it.
function stubProviders(keyword: RegExp, answer = "The fence uses western red cedar [1].") {
  const calls = { jev: 0, anthropic: 0, bodies: [] as Json[] };
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.startsWith("https://api.typesafe.ai/")) {
      calls.jev++;
      calls.bodies.push(body);
      const answers: Record<string, Json> = {};
      for (const [qid, question] of Object.entries<Json>(body.questions)) {
        if (question.type === "choice") {
          const keys = Object.keys(question.criteria);
          // Filing questions describe one item in state; routing questions only carry the query.
          const relevant = !body.state?.title || keyword.test(JSON.stringify(body.state));
          const hits = relevant ? keys.filter((k) => k !== "none" && keyword.test(JSON.stringify(question.criteria[k]))) : [];
          const fallback = keys.find((k) => k === "none" || k === "none_fit") ?? keys[0];
          const probabilities: Record<string, number> = {};
          for (const k of keys) {
            probabilities[k] = hits.length ? (hits.includes(k) ? 1 / hits.length : 0) : k === fallback ? 1 : 0;
          }
          answers[qid] = { type: "choice", choice: hits[0] ?? fallback, probabilities, confidence: 0.9 };
        } else {
          const evidence = JSON.stringify(question.instructions.evidence ?? body.state);
          answers[qid] = { type: "score", score: keyword.test(evidence) ? 3 : 0, legend: {}, probabilities: {}, confidence: 0.9 };
        }
      }
      return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 100, output_tokens: 10 } }), { status: 200 });
    }
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.anthropic++;
      calls.bodies.push(body);
      return new Response(JSON.stringify({ content: [{ type: "text", text: answer }], stop_reason: "end_turn" }), { status: 200 });
    }
    return new Response("not stubbed", { status: 599 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("Jevbox indexing", () => {
  it("turns HTML into headed text, drops scripts, and keeps table rows", () => {
    const text = htmlToText(`<html><head><title>x</title><style>.a{}</style></head><body>
      <h1>Fence plan</h1><p>Use <b>cedar</b> &amp; steel posts.</p><script>alert(1)</script>
      <h2 class="x">Costs</h2><table class="t"><tr><th>Item</th><th>Cost</th></tr><tr><td>Posts</td><td>$40</td></tr></table>
      <ul><li>One</li><li>Two</li></ul></body></html>`);
    expect(text).toContain("# Fence plan");
    expect(text).toContain("## Costs");
    expect(text).toContain("Use cedar & steel posts.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".a{}");
    expect(text).toContain("<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Posts</td><td>$40</td></tr></table>");
    expect(text).toContain("- One");
  });

  it("builds a heading tree that ignores fenced code and keeps the opening as a sibling", () => {
    const parsed = buildIndex(
      "Intro text before headings, long enough to keep.\n\n# A\nalpha\n```\n# not a heading\n```\n## A1\nbeta\n# B\ngamma",
      "Doc title"
    );
    expect(parsed.nodes.map((n) => n.title)).toEqual(["Doc title", "A", "B"]);
    expect(parsed.nodes[1].children.map((n) => n.title)).toEqual(["A1"]);
    expect(flatten(parsed.nodes).map((n) => n.title)).not.toContain("not a heading");
    expect(parsed.outline).toBe("Outline: Doc title; A; A1; B");
    expect(parsed.nodes[1].passages[0].content).toContain("# not a heading");
  });

  it("splits long text with overlap and splits tables at rows with repeated headers", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`).join("\n\n");
    const passages = splitPassages(long, 1000, 100);
    expect(passages.length).toBeGreaterThan(3);
    expect(passages.every((p) => p.content.length <= 1000)).toBe(true);
    const rows = Array.from({ length: 40 }, (_, i) => `<tr><td>row ${i}</td><td>${"x".repeat(40)}</td></tr>`).join("");
    const tables = splitPassages(`Lead in.\n\n<table><tr><th>Name</th><th>Value</th></tr>${rows}</table>`, 800, 50)
      .filter((p) => p.content.includes("<table>"));
    expect(tables.length).toBeGreaterThan(2);
    expect(tables.every((p) => p.content.includes("<tr><th>Name</th><th>Value</th></tr>"))).toBe(true);
  });

  it("proposes direct candidates only for distinctive matches", () => {
    const items = [
      { id: "a", name: "Fence lumber order", outline: "Outline: Cedar; Posts" },
      { id: "b", name: "Quarterly report", outline: "Outline: Revenue" },
      { id: "c", name: "Garden notes", outline: "Outline: Soil" },
    ];
    expect(metadataCandidates(items, "how much cedar lumber did we order?").map((c) => c.id)).toEqual(["a"]);
    expect(metadataCandidates(items, "the")).toEqual([]);
  });

  it("parses only in-range citation numbers", () => {
    expect(citedNumbers("A [2]. B [1][2]. C [9]. D [x]", 3)).toEqual([1, 2]);
  });
});

describe("Jevbox beam traversal", () => {
  it("follows the routes JEV prefers and defers routes rated at or below none", async () => {
    const leaf = (id: string, text: string): RouteNode<string> => ({ id, describe: async () => text, children: [], value: id });
    const roots = [
      { id: "p1", describe: async () => "Home projects: fence", children: [leaf("fence", "fence cedar"), leaf("deck", "deck stain")] },
      { id: "p2", describe: async () => "Work: invoices", children: [leaf("inv", "invoice")] },
    ];
    const choose = vi.fn(async (_q: string, menus: { id: string; choices: { id: string; text: string }[] }[]) =>
      new Map(menus.map((menu) => [menu.id, Object.fromEntries([
        ...menu.choices.map((c) => [c.id, /fence/.test(c.text) ? 0.9 : 0.05]),
        ["none", 0.1 - (menu.choices.length - 1) * 0.05 + 0.05],
      ])]))
    );
    const traversal = createTraversal<string>(roots, { choose }, "fence", (node) => node.value !== undefined);
    const first = await traversal.walk();
    expect(first.map((r) => r.node.id)).toContain("fence");
    expect(first.find((r) => r.node.id === "fence")!.score).toBeCloseTo(0.9, 5);
  });
});

describe("Jevbox library search routes", () => {
  it("indexes on demand, routes to the right section, and answers with citations", async () => {
    const { id: user, api } = await makeUser("jev");
    const other = await makeUser("jev-other");
    const fence = await addDoc(user, "Fence lumber order", "creek-valley",
      "# Fence lumber order\n\nOrdered for the back fence.\n\n## Materials\n\nWestern red cedar boards, 140 pieces, from Creek Valley Lumber.\n\n## Delivery\n\nArrives Tuesday.");
    await addDoc(user, "Quarterly revenue", "finance", "# Revenue\n\nQ3 revenue rose 12%.\n\n## Costs\n\nCloud spend fell.");
    const art = await addArtifact(user, "Deck stain options", "home",
      "<h1>Deck</h1><p>Semi-transparent stain in walnut.</p><script>var cedar=1</script>");
    await addDoc(other.id, "Other user's fence", "creek-valley", "# Fence\n\nSecret cedar plan for another user.");

    const home = await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "Home", sources: ["creek-valley", "home"] }) });
    expect(home.status).toBe(201);
    await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "Finance", sources: ["finance"] }) });

    const before = await api("/api/library/search/index");
    expect(before.body.data.index).toMatchObject({ total: 3, ready: 0, pending: 3 });
    const prepared = await api("/api/library/search/index", { method: "POST", body: "{}" });
    expect(prepared.body.data.index).toMatchObject({ total: 3, ready: 3, pending: 0, failed: 0, indexed: 3 });

    const calls = stubProviders(/cedar/i);
    const search = await api("/api/library/search", { method: "POST", body: JSON.stringify({ query: "What wood is the fence made of?" }) });
    expect(search.status).toBe(200);
    const data = search.body.data;
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0]).toMatchObject({ ref: 1, type: "document", id: fence, title: "Fence lumber order", score: 3 });
    expect(data.results[0].section_path).toEqual(["Fence lumber order", "Materials"]);
    expect(data.results.every((r: Json) => !/another user/.test(r.content))).toBe(true);
    // The script text inside the artifact was never indexed as evidence.
    expect(data.results.every((r: Json) => !r.content.includes("var cedar"))).toBe(true);
    expect(data.trace.some((s: Json) => s.stage === "item" && s.item.id === fence)).toBe(true);
    expect(data.usage.calls).toBe(calls.jev);
    expect(data.usage.input_tokens).toBe(calls.jev * 100);
    // JEV requests carry the question in state and never the other user's content.
    expect(JSON.stringify(calls.bodies)).not.toContain("Secret cedar plan");

    const ask = await api("/api/library/ask", { method: "POST", body: JSON.stringify({ question: "What wood is the fence made of?" }) });
    expect(ask.status).toBe(200);
    expect(ask.body.data).toMatchObject({ answered: true, citations: [1], model: "claude-opus-5-5" });
    expect(ask.body.data.answer).toContain("[1]");
    const anthropic = calls.bodies.at(-1);
    expect(anthropic.model).toBe("claude-opus-5-5");
    expect(anthropic.fallbacks).toBe("default");
    expect(anthropic.output_config).toEqual({ effort: "medium" });
    expect(anthropic.messages[0].content).toContain("Western red cedar");

    // Scoped to the deck artifact only: the fence document is not searched.
    const scoped = await api("/api/library/search", {
      method: "POST",
      body: JSON.stringify({ query: "cedar?", items: [{ type: "artifact", id: art }] }),
    });
    expect(scoped.body.data.searched_items).toBe(1);
    expect(scoped.body.data.results).toEqual([]);
  });

  it("re-indexes changed items and prunes deleted ones", async () => {
    const { id: user, api } = await makeUser("jev-change");
    const art = await addArtifact(user, "Plan", null, "<h1>Plan</h1><p>First version text about oak.</p>");
    expect((await api("/api/library/search/index", { method: "POST", body: "{}" })).body.data.index.ready).toBe(1);
    await baseEnv.DB.prepare("UPDATE artifacts SET current_version = 2 WHERE id = ?").bind(art).run();
    await baseEnv.DOCS.put(`artifacts/${art}/v2.html`, "<h1>Plan</h1><p>Second version text about cedar.</p>");
    expect((await api("/api/library/search/index")).body.data.index).toMatchObject({ ready: 0, pending: 1 });
    stubProviders(/cedar/i);
    const search = await api("/api/library/search", { method: "POST", body: JSON.stringify({ query: "cedar" }) });
    expect(search.body.data.results[0].content).toContain("Second version");

    await baseEnv.DB.prepare("DELETE FROM artifacts WHERE id = ?").bind(art).run();
    expect((await api("/api/library/search/index", { method: "POST", body: "{}" })).body.data.index.total).toBe(0);
    const rows = await baseEnv.DB.prepare("SELECT COUNT(*) AS n FROM library_search_index WHERE user_id = ?").bind(user).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("validates input and reports a missing TypeSafe key", async () => {
    const { api } = await makeUser("jev-errors");
    expect((await api("/api/library/search", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
    expect((await api("/api/library/search", { method: "POST", body: JSON.stringify({ query: "x", project_id: "nope" }) })).status).toBe(400);
    expect((await api("/api/library/search", { method: "POST", body: JSON.stringify({ query: "x", limit: 99 }) })).status).toBe(400);
    const noKey = { ...baseEnv, TYPESAFE_API_KEY: undefined } as unknown as TestEnv;
    const missing = await api("/api/library/search", { method: "POST", body: JSON.stringify({ query: "x" }) }, noKey);
    expect(missing.status).toBe(409);
    expect(missing.body.error).toMatch(/TYPESAFE_API_KEY/);
    const unauth = await worker.fetch(new Request("https://pidgindocs.example.workers.dev/api/library/search", { method: "POST", body: "{}" }), baseEnv, ctx);
    expect(unauth.status).toBe(401);
  });

  it("exposes search and ask as MCP tools", async () => {
    const { id: user, api } = await makeUser("jev-mcp");
    const doc = await addDoc(user, "Cabin trip", "home", "# Cabin trip\n\n## Packing\n\nBring the cedar kindling and two lanterns.");
    stubProviders(/cedar/i, "Bring cedar kindling [1].");
    const rpc = async (name: string, args: Json) =>
      (await api("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).body.result;
    const tools = (await api("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).body.result.tools;
    expect(tools.map((t: Json) => t.name)).toEqual(expect.arrayContaining(["pidgin_search_library", "pidgin_ask_library"]));

    const search = await rpc("pidgin_search_library", { query: "what kindling?" });
    expect(search.isError).toBe(false);
    expect(search.structuredContent.results[0]).toMatchObject({ id: doc, section_path: ["Cabin trip", "Packing"] });
    const ask = await rpc("pidgin_ask_library", { question: "what kindling?" });
    expect(ask.structuredContent).toMatchObject({ answered: true, citations: [1] });
    expect((await rpc("pidgin_search_library", {})).isError).toBe(true);
  });

  it("suggests and applies JEV filing for unfiled items only when confident", async () => {
    const { api } = await makeUser("jev-file");
    const user = (await api("/api/library")).body;
    expect(user.ok).toBe(true);
    const userId = (await baseEnv.DB.prepare("SELECT user_id FROM api_keys ORDER BY rowid DESC LIMIT 1").first<{ user_id: string }>())!.user_id;
    const home = (await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "Home", description: "House, fence, and garden" }) })).body.data.project_id;
    await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "Work", description: "Invoices and clients" }) });
    await api("/api/library/tags", { method: "POST", body: JSON.stringify({ name: "plan" }) });
    const fence = await addDoc(userId, "Fence lumber order", "general", "# Fence\n\nCedar boards.");
    const loose = await addArtifact(userId, "Untitled sketch", null, "<p>Doodle</p>");

    const calls = stubProviders(/fence/i);
    const dry = await api("/api/library/suggest", { method: "POST", body: "{}" });
    expect(dry.status).toBe(200);
    const byId = Object.fromEntries(dry.body.data.suggestions.map((s: Json) => [s.id, s]));
    expect(byId[fence]).toMatchObject({ project_id: home, project_name: "Home", confident: true, current_project_id: null });
    expect(byId[fence].tag).toMatchObject({ name: "plan" });
    expect(byId[loose]).toMatchObject({ project_id: null, confident: false });
    expect(dry.body.data.applied).toBeNull();
    expect(calls.jev).toBe(2);
    // The calibrated question shape: title, description, and the agent label hint.
    expect(calls.bodies[0].state).toHaveProperty("agent_label");
    expect((await api("/api/library")).body.data.library.unfiled).toEqual({ documents: 1, artifacts: 1 });

    const applied = await api("/api/library/suggest", { method: "POST", body: JSON.stringify({ apply: true }) });
    expect(applied.body.data.applied).toEqual({ filed: 1, tagged: 2 });
    expect((await api("/api/library")).body.data.library.unfiled).toEqual({ documents: 0, artifacts: 1 });

    const bad = await api("/api/library/suggest", { method: "POST", body: JSON.stringify({ min_confidence: 2 }) });
    expect(bad.status).toBe(400);
    const tools = (await api("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).body.result.tools;
    expect(tools.map((t: Json) => t.name)).toContain("pidgin_suggest_filing");
  });

  it("stops a search that finds nothing after 48 passages, even on the thorough budget", async () => {
    const { id: user, api } = await makeUser("jev-stop");
    for (let d = 0; d < 6; d++) {
      const sections = Array.from({ length: 12 }, (_, i) => `## Topic ${d}-${i}\n\nNotes about subject ${d}-${i} and nothing else.`).join("\n\n");
      await addDoc(user, `Notebook ${d}`, "notes", `# Notebook ${d}\n\n${sections}`);
    }
    const calls = stubProviders(/zzz-never-matches/);
    const rpc = async (name: string, args: Json) =>
      (await api("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).body.result;
    const thorough = await rpc("pidgin_search_library", { query: "What is the boiling point of tungsten?" });
    expect(thorough.structuredContent.results).toEqual([]);
    expect(thorough.structuredContent.scored_passages).toBe(48);
    const standard = await api("/api/library/search", { method: "POST", body: JSON.stringify({ query: "What is the boiling point of tungsten?" }) });
    expect(standard.body.data.scored_passages).toBeLessThanOrEqual(48);
    // Routing requests carry today's date for recency judgments.
    const today = new Date().toISOString().slice(0, 10);
    const routing = calls.bodies.filter((b: Json) => Object.keys(b.questions ?? {}).some((k) => k.startsWith("route_")));
    expect(routing.length).toBeGreaterThan(0);
    expect(routing.every((b: Json) => b.state.today === today)).toBe(true);
    expect((await api("/api/library/search", { method: "POST", body: JSON.stringify({ query: "x", budget: "huge" }) })).status).toBe(400);
  });

  it("prefers the more recent of two equally useful passages and shows dates to the answer model", async () => {
    const { id: user, api } = await makeUser("jev-recent");
    const older = await addDoc(user, "Fence plan v1", "home", "# Fence plan\n\nThe fence uses cedar boards.");
    const newer = await addDoc(user, "Fence plan v2", "home", "# Fence plan\n\nThe fence uses cedar boards and steel posts.");
    await baseEnv.DB.prepare("UPDATE messages SET created_at = '2026-01-02 10:00:00' WHERE id = ?").bind(older).run();
    await baseEnv.DB.prepare("UPDATE messages SET created_at = '2026-09-30 10:00:00' WHERE id = ?").bind(newer).run();
    const calls = stubProviders(/cedar/i);
    const ask = await api("/api/library/ask", { method: "POST", body: JSON.stringify({ question: "What does the fence use?", items: [{ type: "document", id: older }, { type: "document", id: newer }] }) });
    expect(ask.status).toBe(200);
    expect(ask.body.data.results.map((r: Json) => r.id)).toEqual([newer, older]);
    expect(ask.body.data.results[0].created_at).toBe("2026-09-30 10:00:00");
    const prompt = calls.bodies.at(-1).messages[0].content;
    expect(prompt).toContain('sent="2026-09-30"');
    expect(prompt).toContain('sent="2026-01-02"');
    // Scoring keeps the Jevbox rubric: no dates in the scored evidence.
    const scoring = calls.bodies.find((b: Json) => Object.values<Json>(b.questions ?? {}).some((q) => q.type === "score"));
    expect(JSON.stringify(scoring)).not.toContain("2026-09-30");
  });
});

describe("Jevbox ranking", () => {
  it("treats scores within a quarter point as equal and then prefers recent items", () => {
    const p = (id: string, score: number, created_at: string, route_score = 0.5) => ({ id, score, created_at, route_score });
    const ranked = rank([
      p("old-high", 2.9, "2026-01-01 00:00:00"),
      p("new-high", 2.8, "2026-09-01 00:00:00"),
      p("new-low", 2.0, "2026-10-01 00:00:00"),
    ]);
    expect(ranked.map((x) => x.id)).toEqual(["new-high", "old-high", "new-low"]);
    expect(buildAnswerPrompt("q", [{ ...p("a", 3, "2026-02-03 01:02:03"), type: "document", title: "T", project_id: null, section_id: "s1", section_path: ["T"], passage_id: "p1", content: "c" }]))
      .toContain('sent="2026-02-03"');
  });
});
