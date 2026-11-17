// Help article text as this edition shows it. The articles are bundled once, with neutral
// marks: `__PRODUCT__`, `{{tool}}` for tool names and `{{...}}` wire names. Edition hooks can
// be installed after this module loads, so every read goes through the functions below.
import { editionProductName, editionTicketHelpText, editionWireFormat } from "../edition-hooks";
import { clientToolText } from "../wire-names";
import { HELP_ARTICLES, HELP_LEAD_ANCHOR, helpArticleChunks, slugifyHeading, type HelpArticle, type HelpChunk, type HelpSection } from "./corpus";

// The shell client's script is named after the product's lowercase slug, as the
// edition ships it (for example scripts/<slug>.sh).
const shellNames = (slug: string): { file: string; check: string; cli: string } => ({
  file: ` (\`scripts/${slug}.sh\`)`,
  check: `\`scripts/${slug}.sh check\` `,
  cli: `${slug}.sh `,
});

/** Article text with this edition's names. Read at each call, so a later hook install takes effect. */
export function helpText(source: string): string {
  const wire = editionWireFormat();
  const productSlug = editionProductName().toLowerCase();
  const shell = shellNames(productSlug);
  return clientToolText(source)
    .split("{{productSlug}}").join(productSlug)
    .split("{{shellFile}}").join(shell.file)
    .split("{{shellCheck}}").join(shell.check)
    .split("{{shellCli}}").join(shell.cli)
    .split("{{ticketHelp}}").join(editionTicketHelpText())
    .split("{{tool}}").join(wire.mcpToolPrefix)
    .split("{{agentEnvPrefix}}").join(wire.agentEnvPrefix)
    .split("{{mcpServerName}}").join(wire.mcpServerName)
    .split("{{eventsSubprotocol}}").join(wire.eventsSubprotocol);
}

/** Sections with anchors slugified from the rendered heading, so each edition's anchors match its own text. */
function viewSections(sections: readonly HelpSection[]): HelpSection[] {
  const used = new Set([HELP_LEAD_ANCHOR]);
  return sections.map((section) => {
    const heading = helpText(section.heading);
    const base = slugifyHeading(heading);
    let anchor = base;
    for (let n = 2; used.has(anchor); n += 1) anchor = `${base}-${n}`;
    used.add(anchor);
    return Object.freeze({ anchor, heading, markdown: helpText(section.markdown) });
  });
}

function viewArticle(article: HelpArticle): HelpArticle {
  return Object.freeze({
    ...article,
    title: helpText(article.title),
    summary: helpText(article.summary),
    tags: Object.freeze(article.tags.map((tag) => helpText(tag))),
    markdown: helpText(article.markdown),
    lead: helpText(article.lead),
    sections: Object.freeze(viewSections(article.sections)),
  });
}

interface EditionView {
  key: string;
  articles: readonly HelpArticle[];
  chunks: readonly HelpChunk[];
  bySlug: ReadonlyMap<string, HelpArticle>;
}

let current: EditionView | undefined;

/** The articles and chunks for the edition in force now; rebuilt only when its names change. */
function view(): EditionView {
  const key = JSON.stringify([editionProductName(), editionWireFormat(), editionTicketHelpText()]);
  if (current?.key !== key) {
    const articles = Object.freeze(HELP_ARTICLES.map(viewArticle));
    current = {
      key,
      articles,
      chunks: Object.freeze(articles.flatMap(helpArticleChunks)),
      bySlug: new Map(articles.map((article) => [article.slug, article])),
    };
  }
  return current;
}

/** Every article with this edition's names, in file-name order. */
export function editionArticles(): readonly HelpArticle[] {
  return view().articles;
}

/** One chunk per section of every article, with this edition's names. */
export function editionChunks(): readonly HelpChunk[] {
  return view().chunks;
}

/** The article with this slug, with this edition's names. */
export function editionArticle(slug: string): HelpArticle | undefined {
  return view().bySlug.get(slug);
}
