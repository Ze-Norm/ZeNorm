import { Link } from "@tanstack/react-router";
import { parseSpecPagePath } from "@zenorm/contracts";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

/**
 * Agent text as inline markdown (L126 (a)): code spans, emphasis and strong, never raw backticks,
 * and bullet and numbered lists as lists, so a run of decided details reads as one. Every other
 * markdown construct shows its text only (headings, quotes and links are unwrapped, but for a
 * spec page link where the caller allows one), and raw HTML shows as text.
 */
const ALLOWED = ["p", "code", "em", "strong", "ul", "ol", "li"];

/** Text of more than one block: a blank line between paragraphs, or a list after a line. */
const BLOCKS = /\n\s*\n|\n\s*(?:[-*+]|\d+[.)])\s/;

function Code({ children }: { children: ReactNode }) {
  return <code className="bg-secondary px-1 py-px font-mono text-[0.86em]">{children}</code>;
}

/**
 * Inline elements; `p` is set per text, as a block only when the text has several blocks. Lists
 * are spans shown as list items, so agent text stays valid inside the caller's `p`.
 */
const inline: Components = {
  code: ({ children }) => <Code>{children}</Code>,
  em: ({ children }) => <em>{children}</em>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }) => <span className="mt-1 grid list-disc gap-1 pl-5">{children}</span>,
  ol: ({ children }) => <span className="mt-1 grid list-decimal gap-1 pl-5">{children}</span>,
  li: ({ children }) => <span className="list-item">{children}</span>,
};

/**
 * A link in agent text that may carry one: a spec's page opens as a link (a chart names another
 * map's spec by its title, linked there); any other link shows its text only.
 */
function SpecLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const page = href === undefined ? null : parseSpecPagePath(href);
  if (page === null) {
    return children;
  }
  return (
    <Link
      to="/maps/$mapId/$stage/$specNumber"
      params={{ mapId: page.mapId, stage: "spec", specNumber: page.specNumber }}
      search={{}}
      className="text-primary hover:underline"
    >
      {children}
    </Link>
  );
}

/**
 * One piece of agent text (a criterion, a clause, the destination, a ticket's build) with its
 * inline markdown rendered, inside the caller's element, which sets the type. Text of several
 * blocks renders each paragraph as a block span and each list as a list. With `specLinks` (the
 * map's summary and destination, never inside another link) a spec page link opens as a link.
 */
export function AgentText({ text, specLinks }: { text: string; specLinks?: true }) {
  const paragraphs = BLOCKS.test(text.trim());
  const components: Components = {
    ...inline,
    a: ({ href, children }) => <SpecLink href={href}>{children}</SpecLink>,
    p: ({ children }) => (
      <span className={paragraphs ? "block not-first:mt-2" : undefined}>{children}</span>
    ),
  };
  return (
    <ReactMarkdown
      allowedElements={specLinks === true ? [...ALLOWED, "a"] : ALLOWED}
      unwrapDisallowed
      components={components}
    >
      {text.trim()}
    </ReactMarkdown>
  );
}

/**
 * A code span on one line, as CommonMark has it: a whole run of backticks opens it and the next run
 * of the same length closes it, so ``a `b` c`` is one span and an unmatched run stays as text.
 */
const CODE_SPAN = /(?<!`)(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g;

/** A code span's text: one space stripped from each end when both have one (CommonMark). */
function spanText(inner: string): string {
  return inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== ""
    ? inner.slice(1, -1)
    : inner;
}

/**
 * The person's idea as they wrote it: its line breaks and list markers kept (the caller's element
 * sets `whitespace-pre-wrap`), and its code spans rendered without their backticks, as in
 * `AgentText`.
 */
export function IdeaText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    const [whole, , inner] = match;
    if (inner === undefined || inner.trim() === "") {
      continue;
    }
    parts.push(text.slice(from, match.index), <Code key={match.index}>{spanText(inner)}</Code>);
    from = match.index + whole.length;
  }
  parts.push(text.slice(from));
  return parts;
}
