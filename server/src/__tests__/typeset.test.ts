import { describe, expect, it } from "vitest";
import { typesetDocument } from "../core/documents/typeset";
import { compileDesignSystem } from "../core/documents/design-system";

const base = {
  title: "Q3 Infrastructure Review",
  project: "pidgin",
  createdAt: "2026-06-09T18:00:00.000Z",
};

describe("typesetDocument", () => {
  it("renders markdown into a complete self-contained document", () => {
    const html = typesetDocument({
      ...base,
      markdown: [
        "# Overview",
        "",
        "The migration is **on track**. Three items need attention.",
        "",
        "## Costs",
        "",
        "| Service | Monthly |",
        "| --- | --- |",
        "| Workers | $5 |",
        "| D1 | $1 |",
        "",
        "- keep R2 lifecycle rules",
        "- prune stale device tokens",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "> Durability lives in D1; delivery is best-effort.",
      ].join("\n"),
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Q3 Infrastructure Review");
    // markdown structures actually rendered
    expect(html).toMatch(/<h2[^>]*>Overview<\/h2>/);
    expect(html).toMatch(/<strong>on track<\/strong>/);
    expect(html).toContain("<table");
    expect(html).toContain("<blockquote");
    expect(html).toMatch(/<pre><code[^>]*>const x = 1;/);
    // chrome
    expect(html).toContain("pidgin"); // project in the dateline
    expect(html).toContain("June 9, 2026");
  });

  it("is fully self-contained: no external fetches of any kind", () => {
    const html = typesetDocument({ ...base, markdown: "plain *text*." });
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it("ships a dark-mode variant", () => {
    const html = typesetDocument({ ...base, markdown: "hello" });
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("escapes the title", () => {
    const html = typesetDocument({
      ...base,
      title: `<script>alert("x")</script>`,
      markdown: "safe",
    });
    expect(html).not.toContain(`<script>alert("x")</script>`);
    expect(html).toContain("&lt;script&gt;");
  });

  it("typesets plain text bodies as readable paragraphs", () => {
    const html = typesetDocument({
      ...base,
      body: "First paragraph.\n\nSecond paragraph with <angle> brackets.",
    });
    expect(html).toContain("First paragraph.");
    expect(html).toContain("&lt;angle&gt; brackets");
    expect(html).not.toContain("<angle>");
  });

  it("drops a leading markdown h1 that duplicates the title", () => {
    const html = typesetDocument({
      ...base,
      markdown: "# Q3 Infrastructure Review\n\nBody text here.",
    });
    expect(html).not.toMatch(/<h2[^>]*>Q3 Infrastructure Review<\/h2>/);
    expect(html).toContain("Body text here.");
    // the chrome h1 still carries the title exactly once
    expect(html.match(/Q3 Infrastructure Review/g)?.length).toBe(2); // <title> + h1
  });

  it("omits the dateline project gracefully when absent", () => {
    const html = typesetDocument({
      title: "No project",
      markdown: "x",
      createdAt: "2026-06-09T18:00:00.000Z",
    });
    expect(html).toContain("No project");
  });

  it("renders with --ds-* variables from the default editorial design system", () => {
    const html = typesetDocument({ ...base, markdown: "hello" });
    expect(html).toContain("--ds-bg: #F6EEDF");
    expect(html).toContain("--ds-accent: #B4552D");
    // legacy variable names are gone
    expect(html).not.toContain("--paper");
    expect(html).not.toContain("--band");
  });

  it("applies a custom design system's tokens and css partial", () => {
    const ds = compileDesignSystem({
      tokens: {
        color: {
          background: { $value: "#101820" },
          text: { $value: "#F2F2F2" },
        },
        font: {
          body: { $value: ["Georgia", "serif"] },
          heading: { $value: ["Futura", "sans-serif"] },
        },
      },
      css: "article blockquote { border-radius: 8px; }",
    });
    const html = typesetDocument({ ...base, markdown: "> quoted" }, ds);
    expect(html).toContain("--ds-bg: #101820");
    expect(html).toContain("border-radius: 8px");
    expect(html).not.toContain("#F6EEDF");
  });
});
