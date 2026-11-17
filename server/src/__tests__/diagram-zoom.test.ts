import { describe, expect, it } from "vitest";
import { DIAGRAM_ZOOM, hasDiagram } from "../core/documents/diagram-zoom";
import { typesetDocument } from "../core/documents/typeset";

describe("diagram zoom", () => {
  it("detects the diagram blocks the typesetter writes", () => {
    const html = typesetDocument({ title: "T", markdown: "```mermaid\ngraph TD; A-->B;\n```" });
    expect(hasDiagram(html)).toBe(true);
    expect(hasDiagram(typesetDocument({ title: "T", markdown: "Just text with the word mermaid." }))).toBe(false);
    expect(hasDiagram("<pre class='mermaid'>graph TD; A-->B;</pre>")).toBe(true);
  });

  it("zooms the diagram, not the page: ctrl/⌘ wheel and Safari gestures are taken, plain scrolling is not", () => {
    expect(DIAGRAM_ZOOM).toContain("passive: false");
    expect(DIAGRAM_ZOOM).toContain("e.ctrlKey || e.metaKey");
    expect(DIAGRAM_ZOOM).toContain("gesturestart");
    expect(DIAGRAM_ZOOM).toContain("touch-action: pan-x pan-y");
  });

  it("works offline under the sandbox: no fetches, storage or Fullscreen API", () => {
    expect(DIAGRAM_ZOOM).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|requestFullscreen|https?:\/\//);
  });
});
