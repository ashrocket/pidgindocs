import { removeRawTextElements } from "../html-text";

const COMMON_ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g,
    (match) => COMMON_ENTITY_MAP[match] || match
  );
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripMarkdown(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "• ")
      .replace(/^\s*\d+\.\s+/gm, "• ")
      .replace(/<[^>]+>/g, " ")
  );
}

export function htmlToText(html: string): string {
  const withoutScripts = removeRawTextElements(html);
  const withBreaks = withoutScripts
    .replace(/<(br|\/p|\/div|\/li|\/h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<p[^>]*>|<div[^>]*>|<h\d[^>]*>/gi, "\n");
  const text = withBreaks.replace(/<[^>]+>/g, " ");
  return normalizeWhitespace(decodeHtmlEntities(text));
}

function splitParagraphs(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 25);
}

function pickHighlights(paragraphs: string[], sentenceBudget: number): string[] {
  const scored: Array<{ sentence: string; score: number }> = [];
  const keywords = [
    "important",
    "need",
    "want",
    "next",
    "tomorrow",
    "problem",
    "goal",
    "share",
    "commute",
    "private",
    "secure",
    "read",
    "listen",
  ];

  for (const paragraph of paragraphs) {
    for (const sentence of splitSentences(paragraph)) {
      let score = 0;
      const lowered = sentence.toLowerCase();
      for (const keyword of keywords) {
        if (lowered.includes(keyword)) score += 2;
      }
      if (sentence.startsWith("I ")) score += 1;
      if (sentence.includes(":")) score += 1;
      if (sentence.length > 220) score -= 2;
      scored.push({ sentence, score });
    }
  }

  scored.sort(
    (a, b) => b.score - a.score || a.sentence.length - b.sentence.length
  );

  const selected: string[] = [];
  for (const candidate of scored) {
    if (selected.length >= sentenceBudget) break;
    if (
      selected.some(
        (sentence) => sentence.toLowerCase() === candidate.sentence.toLowerCase()
      )
    ) {
      continue;
    }
    selected.push(candidate.sentence);
  }
  return selected;
}

function pickBulletLines(body: string): string[] {
  const bannedPhrases = [
    "wait until",
    "dragging content into chat windows",
    "email drafts",
    "random docs",
  ];

  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("- ") ||
        line.startsWith("* ") ||
        /^\d+\.\s/.test(line)
    )
    .map((line) => line.replace(/^(- |\* |\d+\.\s)/, "").trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !bannedPhrases.some((phrase) => line.toLowerCase().includes(phrase))
    )
    .slice(0, 5);
}

export interface CommuteTranscriptInput {
  title: string;
  body: string;
  minutes?: number;
  description?: string;
}

export interface CommuteResearchInput extends CommuteTranscriptInput {
  researchNotes?: string;
}

export const DEFAULT_COMMUTE_SCRIPT_MODEL = "gpt-4.1-mini";
export const DEFAULT_COMMUTE_SPEECH_INSTRUCTIONS =
  "Speak like a warm, thoughtful podcast host. Use natural pacing, small pauses, understated emphasis, and a calm reflective tone. Avoid sounding like a customer support agent, announcer, or screen reader.";

function truncateForModel(value: string, maxChars = 12000): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trim()}\n\n[Source truncated for briefing generation.]`;
}

export function buildCommuteScriptPrompt({
  title,
  body,
  minutes = 3,
  description,
  researchNotes,
}: CommuteResearchInput): string {
  const targetWords = Math.max(180, Math.min(minutes * 150, 900));
  const source = truncateForModel(stripMarkdown(body));

  return [
    "Write a private commute briefing as a spoken script.",
    "The script will be narrated aloud, so optimize for the ear instead of the eye.",
    "Use plain text only. No markdown. No bullet points. No section headers.",
    "Sound thoughtful, concrete, and slightly intimate, like a smart human host recapping the workday.",
    "Keep nuance, uncertainty, and tradeoffs when they matter. Do not overstate confidence.",
    "Focus on what happened, what matters, and what to remember tomorrow.",
    `Target length: about ${minutes} minutes, roughly ${targetWords} words.`,
    "Use short-to-medium sentences, natural transitions, and contractions.",
    "Include a brief opening and a satisfying ending.",
    "If the evidence is mixed or incomplete, say so plainly.",
    "",
    `Title: ${title}`,
    description ? `Description: ${description}` : "",
    researchNotes ? `Research notes:\n${researchNotes}` : "",
    "",
    "Source material:",
    source,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCommuteResearchPrompt({
  title,
  body,
  description,
}: CommuteTranscriptInput): string {
  const source = truncateForModel(stripMarkdown(body));

  return [
    "Analyze the source material for a commute briefing.",
    "Return plain text only.",
    "Do not write the final narrated script yet.",
    "Extract concrete evidence under these exact headings:",
    "Core idea:",
    "What happened:",
    "What matters:",
    "Open questions:",
    "Risks or bullshit checks:",
    "What to remember tomorrow:",
    "Under 'Risks or bullshit checks', call out weak claims, missing evidence, contradictions, hype, or places where the source sounds more confident than justified.",
    "",
    `Title: ${title}`,
    description ? `Description: ${description}` : "",
    "",
    "Source material:",
    source,
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizeGeneratedTranscript(
  transcript: string,
  fallbackTitle: string
): string {
  const cleaned = normalizeWhitespace(
    stripMarkdown(transcript)
      .replace(/^["']+|["']+$/g, "")
      .replace(/\n•\s+/g, "\n")
  );

  if (!cleaned) {
    return `PidginDocs commute briefing for ${fallbackTitle}.`;
  }

  return cleaned;
}

export function buildCommuteTranscript({
  title,
  body,
  minutes = 3,
  description,
}: CommuteTranscriptInput): string {
  const cleanBody = stripMarkdown(body);
  const paragraphs = splitParagraphs(cleanBody);
  const bullets = pickBulletLines(body);
  const sentenceBudget = minutes <= 2 ? 3 : minutes <= 4 ? 5 : 7;
  const highlights = pickHighlights(paragraphs, sentenceBudget);
  const opening = [
    `PidginDocs commute briefing for ${title}.`,
    "Here is your short private briefing for the ride home.",
  ];
  const middle: string[] = [];

  if (description) {
    middle.push(`The main idea is this: ${description}`);
  }

  if (highlights.length > 0) {
    middle.push("What matters most:");
    middle.push(...highlights);
  }

  if (bullets.length > 0) {
    middle.push("Things to remember:");
    middle.push(...bullets);
  }

  if (middle.length === 0) {
    middle.push("There was not much source detail, so this briefing is intentionally short.");
  }

  const closing = [
    "That is the end of your commute briefing.",
    "If this still feels important when you get home, it is probably tomorrow's hard work.",
  ];

  return [...opening, ...middle, ...closing].join("\n\n");
}
