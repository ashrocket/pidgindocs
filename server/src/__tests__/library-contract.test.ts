import { describe, expect, it } from "vitest";
import * as library from "../core/library";

describe("Library assembly", () => {
  it("exports the personal route and MCP adapters from core", async () => {
    expect(typeof library.handleLibrary).toBe("function");
    expect(typeof library.callLibraryTool).toBe("function");
    expect(Array.isArray(library.LIBRARY_TOOLS)).toBe(true);
  });
});
