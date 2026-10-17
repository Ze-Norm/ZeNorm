import type { SpecRevisionContent } from "@zenorm/contracts";

/** Where a lint pattern looks: a clause's text and its criteria's, or criteria only. */
export type SpecLintScope = "clause_and_criterion" | "criterion";

export interface SpecLintPattern {
  kind: "conditional" | "unnamed_identifier";
  scope: SpecLintScope;
  pattern: RegExp;
}

/**
 * The phrasing core refuses in a revision's clause and criterion text (harness review change 2),
 * project-agnostic and deliberately small: every false positive costs the writer a retry.
 * `conditional` is a clause or criterion that leaves the design itself for a test, spike or
 * follow-up to choose, instead of deciding one; behaviour chosen by a condition checked at run time
 * ("When X, Y", "otherwise", "if not,") is a decided design and passes. Defaults and fallbacks are
 * not linted: whether a project allows them is its own rule, which the prompts and the review apply
 * from its instruction files, and a stated default ("defaults to `and`") is a decided design. The
 * content schema has no assumption marker, so no text is exempt: an
 * assumption a clause rests on is proved by a live-test criterion, not by leaving the design open
 * until it is known. `unnamed_identifier` is a sentence that mentions a coded error, an error code
 * or a config key without a backticked identifier in that same sentence, leaving the name for the
 * implementer to choose; it is checked per sentence, and plural "error codes" (how tests assert) and
 * negations ("raises no coded error") pass.
 */
export const SPEC_LINT_PATTERNS: readonly SpecLintPattern[] = [
  { kind: "conditional", scope: "clause_and_criterion", pattern: /\bapplies only if\b/i },
  { kind: "conditional", scope: "clause_and_criterion", pattern: /\buntil a follow-up\b/i },
  { kind: "conditional", scope: "clause_and_criterion", pattern: /\bsettled once by\b/i },
  { kind: "conditional", scope: "clause_and_criterion", pattern: /\beither (?:outcome|result)\b/i },
  {
    kind: "conditional",
    scope: "clause_and_criterion",
    pattern: /\bselects the (?:matching )?behaviou?r\b/i,
  },
  { kind: "conditional", scope: "criterion", pattern: /\beither\b[^.;:]*?\bor\b/i },
  {
    kind: "unnamed_identifier",
    scope: "clause_and_criterion",
    pattern: /(?<!\b(?:no|never|nor|without)\s(?:[\w-]+\s){0,2})\bcoded(?: [\w-]+)? error\b/i,
  },
  {
    kind: "unnamed_identifier",
    scope: "clause_and_criterion",
    pattern: /(?<!\b(?:no|never|nor|without)\s(?:[\w-]+\s){0,2})\b(?:new )?error code\b(?!s)/i,
  },
  {
    kind: "unnamed_identifier",
    scope: "clause_and_criterion",
    pattern: /(?<!\b(?:no|never|nor|without)\s(?:[\w-]+\s){0,2})\bnew code\b/i,
  },
  {
    kind: "unnamed_identifier",
    scope: "clause_and_criterion",
    pattern:
      /(?<!\b(?:no|never|nor|without)\s(?:[\w-]+\s){0,2})\b(?:(?:instance[- ])?config(?:uration)?|settings?) key\b(?!s)/i,
  },
];

const KIND_REASON: Record<SpecLintPattern["kind"], string> = {
  conditional:
    'leaves the design for a test, spike or follow-up to choose; decide it here. Behaviour chosen by a condition checked at run time is fine, written as "When X, Y" with its own criterion. A fallback or branch a resolved waypoint settled must be kept: reword it, never remove it. An assumption the design rests on gets a live-test criterion that proves it, not a second design for when it fails',
  unnamed_identifier:
    "leaves the name to the implementer; name the code or key in backticks in the same sentence, an existing one from FACTS or the contracts or the new one being added",
};

/** The sentences of `text`, split after `.`, `!` or `?` and whitespace, never inside a code span. */
function sentencesOf(text: string): string[] {
  const masked = text.replace(/`[^`]*`/g, (span) => "x".repeat(span.length));
  const sentences: string[] = [];
  let start = 0;
  for (const match of masked.matchAll(/[.!?]\s+/g)) {
    const end = match.index + match[0].length;
    sentences.push(text.slice(start, end));
    start = end;
  }
  sentences.push(text.slice(start));
  return sentences;
}

/**
 * Whether `text` nests backticks: an odd count, a doubled backtick, or a code span opening or
 * closing on a space, which is what a span written inside another parses to.
 */
function nestsBackticks(text: string): boolean {
  const ticks = [...text.matchAll(/`/g)].length;
  const spans = [...text.matchAll(/`[^`]*`/g)].map((match) => match[0]);
  return ticks % 2 === 1 || text.includes("``") || spans.some((span) => /^` |\s`$/.test(span));
}

/**
 * Every lint problem of a revision's clause and criterion text (harness review change 2), joined
 * into one message so one retry fixes them all, or null: criterion ids ascending within their
 * clause (gaps stay, they are retired ids), no conditional or silent-default phrasing and no
 * unnamed error code or config key (`SPEC_LINT_PATTERNS`), no nested backticks. Each problem names the clause or criterion and quotes
 * the phrase.
 */
export function specLintProblem(content: SpecRevisionContent): string | null {
  const problems: string[] = [];
  for (const clause of content.clauses) {
    const numbers = clause.criteria.map((criterion) => Number(criterion.id.split(".")[1]));
    if (numbers.some((n, index) => index > 0 && n <= Number(numbers[index - 1]))) {
      problems.push(
        `Clause ${clause.id}'s criteria are not in ascending id order (${clause.criteria
          .map((criterion) => criterion.id)
          .join(", ")}): list them by id and keep the gaps, they are retired ids`,
      );
    }
    const elements = [
      { label: `Clause ${clause.id}`, text: clause.text, isCriterion: false },
      ...clause.criteria.map((criterion) => ({
        label: `Criterion ${criterion.id}`,
        text: criterion.text,
        isCriterion: true,
      })),
    ];
    for (const element of elements) {
      for (const lint of SPEC_LINT_PATTERNS) {
        if (lint.scope === "criterion" && !element.isCriterion) {
          continue;
        }
        if (lint.kind === "unnamed_identifier") {
          const unnamed = sentencesOf(element.text)
            .filter((sentence) => !/`[^`]+`/.test(sentence))
            .map((sentence) => lint.pattern.exec(sentence))
            .find((found) => found !== null);
          if (unnamed !== undefined) {
            problems.push(`${element.label} says "${unnamed[0]}": it ${KIND_REASON[lint.kind]}`);
          }
          continue;
        }
        const match = lint.pattern.exec(element.text);
        if (match !== null) {
          problems.push(`${element.label} says "${match[0]}": it ${KIND_REASON[lint.kind]}`);
        }
      }
      if (nestsBackticks(element.text)) {
        problems.push(
          `${element.label} nests or leaves open a backtick: write each code span once, never one inside another`,
        );
      }
    }
  }
  return problems.length === 0 ? null : problems.join(". ");
}
