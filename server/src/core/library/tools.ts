import type { EditionMcpTool } from "../edition-hooks";
import { LIBRARY_COLORS } from "./store";

export const LIBRARY_TOOLS: EditionMcpTool[] = [
  {
    name: "pidgin_get_library",
    description:
      "Read the user's private library: Projects (with the agent project labels that auto-file into each, and document/artifact counts), Tags (with counts), every agent project label in use, and unfiled counts. Library filing is private to the user and never changes who can read a resource.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pidgin_save_library_project",
    description:
      "Create a library project, or update one when id is given. sources lists agent project labels (instance project names, case-insensitive) that auto-file matching documents and artifacts, past and future; a label belongs to one project. Prefer reusing an existing project from pidgin_get_library.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing project id to update; omit to create." },
        name: { type: "string", minLength: 1, maxLength: 60 },
        description: { type: "string", maxLength: 500 },
        color: { type: "string", enum: [...LIBRARY_COLORS] },
        symbol: { type: "string", description: "SF Symbol name, e.g. folder, airplane, scale.3d" },
        pinned: { type: "boolean" },
        archived: { type: "boolean" },
        sources: { type: "array", items: { type: "string" }, maxItems: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pidgin_file_items",
    description:
      'File documents and artifacts in the user\'s private library. project_id is a project id, "unfiled" (explicitly no project), or "auto" (follow the source-label rule). Tags are names or ids; unknown names are created. Use set_tags alone, or add_tags/remove_tags.',
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["document", "artifact"] },
              id: { type: "string", minLength: 1 },
            },
            required: ["type", "id"],
            additionalProperties: false,
          },
        },
        project_id: { type: "string" },
        add_tags: { type: "array", items: { type: "string" }, maxItems: 12 },
        remove_tags: { type: "array", items: { type: "string" } },
        set_tags: { type: "array", items: { type: "string" }, maxItems: 12 },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "pidgin_search_library",
    description:
      "Search the user's private library (their documents and artifacts) by meaning: the search routes the query through projects, items, and sections, then scores each source passage for usefulness from 0 to 3 and keeps passages at 1.5 or more. Returns passages with item type/id, title, section path, and scores. Results can be empty and are not exhaustive. Write a self-contained query. New or changed items are indexed on demand; index.pending counts items not yet searchable.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 2000 },
        project_id: { type: "string", description: 'Library project id, or "unfiled".' },
        tag_id: { type: "string", description: "Library tag id." },
        items: {
          type: "array",
          maxItems: 50,
          description: "Restrict the search to these documents or artifacts.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["document", "artifact"] },
              id: { type: "string", minLength: 1 },
            },
            required: ["type", "id"],
            additionalProperties: false,
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 12 },
        budget: { type: "string", enum: ["standard", "thorough"], description: "thorough (default here) scores up to 96 passages; standard up to 48 and is faster." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "pidgin_ask_library",
    description:
      "Answer a question from the user's private library with citations: library search (as pidgin_search_library), then Claude writes a short answer from the found passages only and cites them as [n], where n is a passage's ref. Returns the answer, the cited refs, and the passages. If no passage helps, answered is false. Uses the workspace AI allowance.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 4000 },
        project_id: { type: "string", description: 'Library project id, or "unfiled".' },
        tag_id: { type: "string", description: "Library tag id." },
        items: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["document", "artifact"] },
              id: { type: "string", minLength: 1 },
            },
            required: ["type", "id"],
            additionalProperties: false,
          },
        },
        budget: { type: "string", enum: ["standard", "thorough"], description: "thorough (default here) scores up to 96 passages; standard up to 48 and is faster." },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "pidgin_suggest_filing",
    description:
      "Suggest a library project (and a type tag for untagged items) for the given documents/artifacts, or for every unfiled item when items is omitted. A suggestion is confident when the search's confidence reaches min_confidence (default 0.85; a heuristic, not a guarantee). With apply: true, confident suggestions are filed (explicit filing) and type tags are added; others are only listed. Filing is private and never shares an item.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["document", "artifact"] },
              id: { type: "string", minLength: 1 },
            },
            required: ["type", "id"],
            additionalProperties: false,
          },
        },
        apply: { type: "boolean" },
        min_confidence: { type: "number", minimum: 0.5, maximum: 1 },
      },
      additionalProperties: false,
    },
  },
];
