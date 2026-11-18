import { htmlToText } from "../commute/script";

// Turns a document into plain text that reads well aloud.

export type DocumentFormat = "markdown" | "html" | "text";

const HTML_HINT = /<\/?(?:p|div|h[1-6]|html|body|head|ul|ol|li|br|table|span|section|article|a|strong|em|pre)\b[^>]*>/i;

export function detectDocumentFormat(source: string): DocumentFormat {
  return HTML_HINT.test(source) ? "html" : "markdown";
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function endSentence(line: string): string {
  return /[.!?:;,)"'”’]$/.test(line) ? line : `${line}.`;
}

// Removes Markdown syntax. Images and code blocks are dropped, a link keeps its
// text, a table row becomes a comma list, a heading or list item becomes a sentence.
function markdownToSpeech(source: string): string {
  let text = source.replace(/\r\n?/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, "\n");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/^ {0,3}\[[^\]]+\]:\s+\S+.*$/gm, "");
  text = text.replace(/<https?:\/\/[^>]+>/g, " ");
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, " ");
  text = text.replace(/<[^>\n]+>/g, " ");

  const lines = text.split("\n").map((raw) => {
    let line = raw.trim();
    if (!line) return "";
    if (/^([-*_]\s*){3,}$/.test(line) || /^[=-]{3,}$/.test(line)) return "";
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) return "";
    if (line.includes("|") && /^\|.*\|$/.test(line)) {
      line = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(", ");
      return line ? endSentence(line) : "";
    }
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (heading) return heading[1] ? endSentence(heading[1]) : "";
    line = line.replace(/^(>\s?)+/, "");
    const list = line.match(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (list) return list[1] ? endSentence(list[1]) : "";
    return line;
  });

  return lines
    .join("\n")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "$1")
    .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, "$1");
}

export function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Plain text for speech from a document in any supported format.
export function documentToSpeechText(source: string, format?: DocumentFormat): string {
  const chosen = format ?? detectDocumentFormat(source);
  if (chosen === "html") {
    const body = source
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<(pre|svg|nav|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
      // A heading is a sentence for the voice: end it with a pause.
      .replace(/([^.!?:;,\s>])\s*<\/h([1-6])>/gi, "$1.</h$2>");
    return collapseWhitespace(markdownToSpeech(htmlToText(body)));
  }
  if (chosen === "text") return collapseWhitespace(source.replace(/\r\n?/g, "\n"));
  return collapseWhitespace(markdownToSpeech(source));
}

// Cleans text a model wrote, in case Markdown leaked into it.
export function scriptToSpeechText(text: string): string {
  return collapseWhitespace(markdownToSpeech(text));
}

// Cuts a script to at most maxWords, at the last sentence end inside the limit.
export function trimToSentenceBoundary(text: string, maxWords: number): string {
  if (countWords(text) <= maxWords) return text.trim();
  const words = text.trim().split(/\s+/).slice(0, maxWords);
  const head = words.join(" ");
  const lastEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (lastEnd > head.length * 0.4) return head.slice(0, lastEnd + 1).trim();
  if (/[.!?]$/.test(head)) return head;
  return `${head.replace(/[,;:\s]+$/, "")}.`;
}
