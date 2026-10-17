import { randomUUID } from "node:crypto";

import {
  CLAUSE_RELIES_ON_MAX_COUNT,
  type ClauseReference,
  DRAFT_SPECS_MAX_COUNT,
  type DirectedVersion,
  type DraftSpecsRequest,
  type DraftTicketSetRequest,
  type EarlierFindings,
  type LengthLimit,
  type MapRound,
  type ModelLimits,
  type TicketsEarlierFindings,
  type ReviewSpecRequest,
  type ReviewTicketSetRequest,
  type ReviseSpecRequest,
  type SpecFeedback,
  type SpecRevisionContent,
  type SpecRevisionRef,
  type TicketSetContent,
} from "@zenorm/contracts";

import {
  agentDecidedLines,
  block,
  BUSY_READER_RULE,
  INSTANCE_CONFIG_RULE,
  lengthWords,
  limitsLine,
  mapRoundLines,
  preamble,
  renderCodeSurvey,
  WAYPOINT_QUESTION_RULE,
} from "./prompt-parts.ts";
import {
  earlierTicketLines,
  firstTicketNumberLine,
  openWaitLines,
  projectSpecLines,
  readingLines,
  retiredLine,
  textDeltaLines,
  touchingWaypointLines,
  touchLines,
} from "./revision-prompt-parts.ts";

// The prompts of the five spec and ticket calls (spec D3, slice 7c D2). The rules live in the product skills the
// appended system prompt names (L115, spec D4); a prompt carries the records and the plain lines the
// e2e stand-in keys on (L107).

/** The SKILL.md a skill-following call reads, and the name its system prompt gives it. */
export interface PlanningSkill {
  readonly name: string;
  readonly path: string;
}

/** The system prompt appended to a skill-following call: read the SKILL.md at the skill's path and follow it. */
export function buildSkillSystemPrompt(skill: PlanningSkill): string {
  return [
    `Before anything else, read the ${skill.name} skill at ${skill.path} with the Read tool, and follow it.`,
    "It is ZeNorm's product skill for this run: it states the documents you write and the rules they meet.",
    "",
    "Answer only through the structured output. Its JSON Schema is authoritative over any format the",
    "skill or the prompt describes.",
    "",
  ].join("\n");
}

/** The plain line naming the revision a spec review reviews; the stand-in keys on it (L107). */
export function reviewOfLine(ref: SpecRevisionRef): string {
  return `Review of: spec ${String(ref.specNumber)} revision ${String(ref.revision)}`;
}

/** The plain line naming the ticket set version a tickets review reviews; the stand-in keys on it (L107). */
export function reviewOfTicketsLine(specNumber: number, version: number): string {
  return `Review of: tickets ${String(specNumber)} version ${String(version)}`;
}

/** The plain line listing a ticket set version's ticket ids, in order. */
export function ticketIdsLine(prefix: string, ticketIds: readonly string[]): string {
  return `${prefix} ticket ids: ${ticketIds.join(", ")}`;
}

/**
 * The plain line giving a ticket set's shape, computed from its tickets (RC5): each ticket's share
 * of the criteria the set covers, and the tickets with fewer than three criteria. It informs; core
 * refuses no shape.
 */
export function ticketSetShapeLine(
  tickets: readonly TicketSetContent["tickets"][number][],
): string {
  const covered = new Set(tickets.flatMap((ticket) => ticket.criteria)).size;
  const shares = tickets.map(
    (ticket) =>
      `${ticket.id} ${String(ticket.criteria.length)}/${String(covered)} (${String(
        Math.round((ticket.criteria.length / covered) * 100),
      )}%)`,
  );
  const thin = tickets.filter((ticket) => ticket.criteria.length < 3).map((ticket) => ticket.id);
  return `Shape: criteria per ticket ${shares.join(", ")}; tickets with fewer than three criteria: ${
    thin.length === 0 ? "none" : thin.join(", ")
  }.`;
}

/** The plain line counting the review findings a To Tickets rewrite repairs (slice 7c D4). */
export function rewriteFindingsLine(count: number): string {
  return `Review findings to repair: ${String(count)}`;
}

/** The plain line naming the revision a repair revises. */
export function revisingLine(ref: SpecRevisionRef): string {
  return `Revising: spec ${String(ref.specNumber)} revision ${String(ref.revision)}`;
}

/** The plain line naming the approved revision To Tickets writes tickets for. */
export function ticketsForLine(ref: SpecRevisionRef): string {
  return `Tickets for: spec ${String(ref.specNumber)} revision ${String(ref.revision)}`;
}

/** The plain line listing the map's resolved waypoint numbers, the only waypoints a clause may name. */
export function resolvedWaypointsLine(numbers: readonly number[]): string {
  return `Resolved waypoints: ${numbers.length === 0 ? "none" : numbers.join(", ")}`;
}

/** Said under `Resolved waypoints: none`: a map with no waypoints has none to cite. */
export const NO_WAYPOINTS_TO_CITE_LINE =
  'This map has no waypoints, so no clause cites one: cite { "kind": "destination" }.';

/** The plain line counting the map's specs on a To Spec run (0 on the map's first clear). */
export function specsOnMapLine(count: number): string {
  return `Specs on this map: ${String(count)}`;
}

/** The plain line counting the other specs a review reads. */
export function otherSpecsLine(count: number): string {
  return `Other specs on this map: ${String(count)}`;
}

/**
 * The plain line giving why a revision is repaired: a failed review's finding count, a rejection, or
 * the person's note (S7b-11).
 */
export function feedbackLine(feedback: SpecFeedback): string {
  switch (feedback.kind) {
    case "review":
      return `Revise because: review findings ${String(feedback.findings.length)}`;
    case "rejection":
      return "Revise because: rejection";
    case "note":
      return "Revise because: note";
    case "wait":
      return "Revise because: wait";
  }
}

/**
 * The plain line telling a release run where its wait came from (S8b-16, N-1): a note through the
 * escape hatch, whose revision may cite the note, or this map's decisions, whose may not.
 */
export function waitSourceLine(noteDirected: boolean): string {
  return `Wait from: ${noteDirected ? "a note" : "this map's decisions"}`;
}

/** The plain line listing a reviewed spec's note-directed revisions (S7b-11). */
export function noteDirectedRevisionsLine(revisions: readonly number[]): string {
  return `Note-directed revisions: ${revisions.length === 0 ? "none" : revisions.join(", ")}`;
}

/** The plain line giving the merged run that delivered the previous revision's set, or none. */
export function previousDeliveryLine(delivery: { run: number; commit: string } | null): string {
  return delivery === null
    ? "Previous revision delivered: no"
    : `Previous revision delivered: run ${String(delivery.run)}, commit ${delivery.commit}`;
}

/**
 * The spec review's rules for a later map's revision (slice 8b S8b-17, D8): the touch rule, the
 * kept-id rule and the research rule, stated in the prompt as in the skill.
 */
export const REVISION_REVIEW_RULES = [
  "Touch rule: a resolved waypoint whose Touches line names a spec counts as carried by that spec's",
  "revision, or by the map's open wait on that spec (the Open waits line); it is never dropped_resolution,",
  "whichever spec's revision is under review.",
  "Kept-id rule: a criterion id the revision keeps from the previous revision keeps its meaning. A kept",
  "id whose meaning changed, not only its wording, is a contradiction: the change needs a new id.",
  "A research waypoint about what delivered code assumes is carried by the revision of the spec it",
  "touches. Its findings reach To Tickets as disposition reasons, not as a clause, so no clause need",
  "state them.",
];

/** The plain line saying a map-scope To Spec run's previous attempt was refused (S7b-15). */
export const DRAFT_SPECS_REFUSED_LINE = "Previous attempt refused: yes";

/** The plain line listing a ticket set's directed versions with their kind (L180 (2)). */
export function directedVersionsLine(directed: readonly DirectedVersion[]): string {
  return `Directed versions: ${
    directed.length === 0
      ? "none"
      : directed.map((entry) => `${String(entry.version)} (${entry.kind})`).join(", ")
  }`;
}

/**
 * Each directed version's ask in its nonce block, oldest first: the person's words, which outrank
 * the review's tracing (L141, issue 21: the most recent information they gave is the most correct).
 */
function directedVersionBlocks(directed: readonly DirectedVersion[], nonce: string): string[] {
  return directed.flatMap((entry) =>
    entry.kind === "rejection"
      ? [
          `The person rejected version ${String(entry.version - 1)} with this reason, and version ${String(entry.version)} was written from it:`,
          ...block(`REJECTION-${String(entry.version - 1)}`, nonce, entry.reason),
        ]
      : [
          `The person sent this note through the escape hatch, and version ${String(entry.version)} was written from it:`,
          ...block(`NOTE-${String(entry.version)}`, nonce, entry.text),
        ],
  );
}

/** The plain line naming the ticket set version a rewrite replaces, or none. */
export function rewriteLine(version: number | null): string {
  return `Rewrite of ticket set version: ${version === null ? "none" : String(version)}`;
}

/** Two plain lines: a revision's clause ids and criterion ids, each in document order. */
export function idLines(prefix: string, content: SpecRevisionContent): string[] {
  const criteria = content.clauses.flatMap((clause) => clause.criteria.map((c) => c.id));
  return [
    `${prefix} clause ids: ${content.clauses.map((clause) => clause.id).join(", ")}`,
    `${prefix} criterion ids: ${criteria.join(", ")}`,
  ];
}

/** A revision's document as JSON in its nonce block: the agent wrote it, so it is material, not orders. */
function revisionBlock(ref: SpecRevisionRef, nonce: string): string[] {
  return block(
    `SPEC-${String(ref.specNumber)}-REVISION-${String(ref.revision)}`,
    nonce,
    JSON.stringify(ref.content, null, 2),
  );
}

function feedbackBlock(feedback: SpecFeedback, nonce: string): string[] {
  switch (feedback.kind) {
    case "rejection":
      return [
        "The person rejected it with this reason:",
        ...block("REJECTION", nonce, feedback.reason),
        "A clause the reason makes or changes cites the resolved waypoints or the destination its subject",
        "traces to. A rejection is not a note: cite no note for it.",
      ];
    case "wait":
      return [
        "This map waited to make this change while another map held the spec. That hold has ended:",
        ...block("WAIT", nonce, feedback.note),
        "Write the change the note states as the spec's next revision, from its latest revision above,",
        "which may be approved and delivered. Keep every other clause, criterion and id as it was; a",
        "changed criterion keeps its id and its meaning's subject, a new one takes the next free id.",
        waitSourceLine(feedback.noteDirected),
        ...(feedback.noteDirected
          ? [
              "The person sent this change as a note through the escape hatch. A clause the change makes or",
              'changes cites { "kind": "note" }.',
            ]
          : [
              "This map's planning recorded the change; it is not a note from the person. A clause the change",
              "makes or changes cites the resolved waypoints listed above that decided it, or, when none did,",
              '{ "kind": "destination" }. Cite no note for it.',
            ]),
      ];
    case "note":
      return [
        "The person sent this note about it through the escape hatch:",
        ...block("NOTE", nonce, feedback.text),
        "The note is the person's most recent word and outranks earlier resolutions, as a rejection",
        'reason does: follow it even where it overrides one. A clause the note settles cites { "kind": "note" }.',
      ];
    case "review":
      return [
        "Its planning review failed with these findings:",
        ...block(
          "REVIEW",
          nonce,
          JSON.stringify({ summary: feedback.summary, findings: feedback.findings }, null, 2),
        ),
      ];
  }
}

/**
 * The spec's earlier failed reviews' findings, grouped by revision, in one nonce block followed by
 * `instruction`; nothing when there are none.
 */
function earlierFindingsBlock(
  earlier: EarlierFindings,
  nonce: string,
  instruction: readonly string[],
): string[] {
  if (earlier.length === 0) {
    return [];
  }
  const text = earlier.flatMap((entry) => [
    `Revision ${String(entry.revision)}:`,
    ...entry.findings.map(
      (finding) => `- ${finding.kind} [${finding.elementIds.join(", ")}]: ${finding.explanation}`,
    ),
  ]);
  return [
    "EARLIER FINDINGS (the spec's earlier failed reviews, by revision):",
    ...block("EARLIER-FINDINGS", nonce, text.join("\n")),
    ...instruction,
    "",
  ];
}

/**
 * The ticket set's earlier failed reviews' findings, grouped by version, in one nonce block followed
 * by `instruction`; nothing when there are none.
 */
function ticketsEarlierFindingsBlock(
  earlier: TicketsEarlierFindings,
  nonce: string,
  instruction: readonly string[],
): string[] {
  if (earlier.length === 0) {
    return [];
  }
  const text = earlier.flatMap((entry) => [
    `Version ${String(entry.version)}:`,
    ...entry.findings.map(
      (finding) =>
        `- ${finding.kind} [${[...finding.ticketNumbers, ...finding.criterionIds].join(", ")}]: ${finding.explanation}`,
    ),
  ]);
  return [
    "EARLIER FINDINGS (the ticket set's earlier failed reviews, by version):",
    ...block("EARLIER-FINDINGS", nonce, text.join("\n")),
    ...instruction,
    "",
  ];
}

/** The previous attempt's refused problem, which this attempt corrects; nothing when there is none. */
function refusedBlock(refused: { problem: string } | null, nonce: string): string[] {
  return refused === null
    ? []
    : [
        "Your previous attempt at this revision was refused for this problem; correct it:",
        ...block("REFUSED", nonce, refused.problem),
        "",
      ];
}

type MapRequest = DraftSpecsRequest | ReviseSpecRequest | ReviewSpecRequest | DraftTicketSetRequest;
type ResearchBasis = Extract<MapRequest["waypoints"][number], { kind: "research" }>["research"];

/** A research waypoint's findings and sources: the facts behind its resolution. */
function researchLines(research: ResearchBasis): string[] {
  return [
    ...(research.findings.length === 0
      ? []
      : [
          "Research findings (the facts behind the resolution):",
          ...research.findings.map((finding) => `- ${finding.title}: ${finding.detail}`),
        ]),
    ...(research.sources.length === 0
      ? []
      : [
          "Research sources:",
          ...research.sources.map((source) =>
            source.url === null ? `- ${source.title}` : `- ${source.title} (${source.url})`,
          ),
        ]),
  ];
}

/** The map a spec or To Tickets run reads: idea, title, destination, resolved waypoints and Out of scope lines. */
function mapContext(request: MapRequest, mapRounds: readonly MapRound[], nonce: string): string[] {
  const waypoints = request.waypoints.flatMap((waypoint) => [
    `Resolved waypoint ${String(waypoint.number)}:`,
    ...block(
      `WAYPOINT-${String(waypoint.number)}`,
      nonce,
      [
        `Kind: ${waypoint.kind}`,
        `Title: ${waypoint.title}`,
        `Question: ${waypoint.question}`,
        `Gist: ${waypoint.gist}`,
        ...agentDecidedLines(waypoint.agentDecided),
        "Resolution:",
        waypoint.resolution,
        ...(waypoint.kind === "research" ? researchLines(waypoint.research) : []),
      ].join("\n"),
    ),
    ...touchLines(waypoint.touches, `WAYPOINT-${String(waypoint.number)}`, nonce),
    "",
  ]);
  const outOfScope =
    request.outOfScope.length === 0
      ? ["Nothing is ruled out of scope.", ""]
      : request.outOfScope.flatMap((line, index) => [
          ...block(`OUT-OF-SCOPE-${String(index + 1)}`, nonce, line),
          "",
        ]);
  return [
    ...preamble(request.projectName, request.baseBranch),
    "",
    "The person's idea for the map:",
    ...block("IDEA", nonce, request.idea),
    "",
    "The map's title:",
    ...block("TITLE", nonce, request.title),
    "",
    "The map's confirmed destination:",
    ...block("DESTINATION", nonce, request.destination),
    "",
    ...mapRoundLines(mapRounds, nonce),
    "The map's Out of scope lines:",
    ...outOfScope,
    ...renderCodeSurvey(request.survey, nonce),
    resolvedWaypointsLine(request.waypoints.map((waypoint) => waypoint.number)),
    ...(request.waypoints.length === 0 ? [NO_WAYPOINTS_TO_CITE_LINE] : []),
    "",
    ...waypoints,
    "The specs this map waits to change, while another map holds them:",
    ...openWaitLines(request.waits, nonce),
  ];
}

/**
 * How many specs a map-scope To Spec run writes (`skills/product-to-spec`): one by default.
 */
export const SPEC_COUNT_RULE = [
  "Write one spec by default. Split only when the destination names parts the person could approve or",
  "deliver separately. Tests and verification are never a spec of their own, and layers (configuration,",
  `storage, sessions, interface) are never separate specs. At most ${String(DRAFT_SPECS_MAX_COUNT)} specs.`,
];

/** What a spec states where no source settles a value or a behaviour (`skills/product-to-spec`). */
export const SPEC_LITERAL_RULE = [
  "A concrete value or unverified behaviour not traced to a source is stated as an assumption with a",
  "live-test criterion. A clause decides any research finding or assumption it bears on (which",
  "folders are writable, what if false), not a test.",
];

/**
 * What a spec's clauses trace to (`skills/product-to-spec`, `skills/product-planning-review`):
 * intent, not every detail.
 */
export const SPEC_TRACING_RULE = [
  "Tracing is about intent. Every behaviour and outcome a clause states traces to a resolution,",
  'the destination and the person\'s answers to its rounds (cited as { "kind": "destination" }), or,',
  "only where this prompt gives one, a note. Implementation detail the agent settled in research, task",
  "or agent-decided waypoints may appear where it helps; precision is not invented scope. A resolution",
  "that is purely implementation detail need not be carried by a spec: it informs the tickets.",
];

/**
 * Behaviour against mechanism (`skills/product-to-spec`, `skills/product-planning-review`): behaviour
 * needs a source, a mechanism the writer chose does not, and a spec states one only where it matters.
 */
export const SPEC_MECHANISM_RULE = [
  "Behaviour is what the person observes: a surface, a refusal, a step they take, the scope. Mechanism",
  "is how a settled behaviour is carried out: how something is detected, internal checks, ordering.",
  "Behaviour traces to a source; a mechanism the writer chose to carry out a settled behaviour does not",
  "need one and is never invented scope. A clause states a mechanism only where it decides what the",
  "person observes or where the clause could not be checked without it; otherwise it states the",
  "behaviour and leaves the mechanism to the tickets. Never add a safety net, fallback or notice no",
  "resolution asks for: if one seems needed and it changes behaviour, that is a gap in the person's",
  "intent for the review to raise, not one for the spec to fill.",
];

/**
 * What a spec must carry (`skills/product-to-spec`): assumptions, the repository's testing convention
 * as the proof, and no instance-specific value.
 */
export const SPEC_GROUNDING_RULE = [
  ...SPEC_LITERAL_RULE,
  "Always carry the repository's testing convention as the proof, in plain-language criteria (for",
  "example stand-in tests for an external tool in the normal check, plus the opt-in live test where the",
  "repository has one). Never put the repository's standard testing practice out of scope.",
  ...INSTANCE_CONFIG_RULE,
];

/** To Spec's pre-submit self-check (`skills/product-to-spec`): the few things a review fails on. */
export const SPEC_SELF_CHECK = [
  "Before you answer, check every clause and fix what fails:",
  "- nothing contradicts a resolution; each new config key, stored field and failure path keeps the",
  "  project instruction files' rules (in your context, else open AGENTS.md or CLAUDE.md at the root);",
  "- every new configurable value names its config key and its section in a criterion;",
  "- every criterion that mentions a coded error, an error code or a config key names it in backticks",
  "  there (`map_archived`, `delivery.agent`): an existing one or the new one being added, and no",
  "  clause's text names one;",
  "- every new stored field, state or column says what happens to records that already exist.",
];

/**
 * What each clause declares (RC1): the existing names it relies on and the new names it adds. Core
 * resolves every reliance and refuses a clause with neither; the review reads the code around each.
 */
export const SPEC_DECLARATION_RULE = [
  "Each clause declares what it builds on and what it introduces, in reliesOn and adds; ZeNorm refuses",
  "a clause with neither and checks every name:",
  "- reliesOn: each existing operation, state, record, procedure, code or file whose behaviour the",
  "  clause depends on or changes, spelled exactly as FACTS or the code spells it, with path null:",
  "  ZeNorm finds it in FACTS or where the source defines it, and refuses a name it cannot find. A",
  "  file is named by its path from the repository root (src/cli.js). Give the file as path only to",
  "  point at one definition among several. When a clause says a step happens (a re-check, a restart,",
  "  a reconciliation), rely on the operation that performs it, or add it as new behaviour. A state a",
  "  clause moves a record into or out of is relied on: FACTS' lifecycle says what can leave it.",
  "- adds: each new name the clause introduces (a code, state, cancel reason, procedure, field). A name",
  "  FACTS already defines is relied on, never added. A new thing that only shares a FACTS name (a new",
  "  JSON key files beside the existing files list) is added with its kind: JSON key files.",
  `At most ${String(CLAUSE_RELIES_ON_MAX_COUNT)} of each per clause: the names the behaviour turns on, not every name the text mentions.`,
];

/**
 * What the clauses of a revision rely on, with the code around each (RC1), as a repair and a
 * review read them; nothing when no clause declared a reliance.
 */
export function referenceLines(
  references: readonly ClauseReference[],
  nonce: string,
  heading: string,
): string[] {
  if (references.length === 0) {
    return [];
  }
  const text = references
    .map((reference) => {
      const where =
        reference.line === null
          ? `no longer found${reference.path === null ? "" : ` in ${reference.path}`}`
          : `${String(reference.path)}:${String(reference.line)}`;
      return [
        `${reference.clauseId} relies on ${reference.name} (${where})${
          reference.meaning === null ? "" : `: ${reference.meaning}`
        }`,
        ...(reference.excerpt === null ? [] : [reference.excerpt]),
      ].join("\n");
    })
    .join("\n\n");
  return [heading, ...block("REFERENCES", nonce, text), ""];
}

/**
 * The spec review's repository step (RC1): each clause against the code it relies on, shown with
 * the code around it; the code opened for any other claim FACTS does not cover.
 */
export const SPEC_REVIEW_REPOSITORY_RULE = [
  "Before judging, check each clause against what it relies on, listed with the code around each:",
  "does the clause use it as that code and FACTS say it works (the states it can leave, what it",
  "offers, what it refuses)? A step a clause relies on that the code does not perform, or a state change",
  "FACTS' lifecycles do not allow, is a contradiction: revise. For each name a clause adds, check the",
  "clause says what happens to records that already exist and how a record leaves any new state. Open",
  "the code for any other claim about the code that neither FACTS nor the excerpts cover. A requirement",
  "that cannot be built as written, or that conflicts with how the code works, is a contradiction:",
  "revise. Then check",
  "each new config key, stored field and failure path against the project instruction files' rules",
  "(in your context, else open AGENTS.md or CLAUDE.md at the repository root). A breach is a",
  "contradiction: revise, or decision only when the destination truly requires it. An element that",
  "reverses an answer the person gave is dropped_resolution.",
];

/**
 * The survey's unverifiable items in a review (RC2): each one a clause depends on is settled from the
 * code (`verified`, path and line checked by core) or reported; nothing when the survey has none.
 */
export function surveyItemsRule(survey: ReviewSpecRequest["survey"]): string[] {
  if (survey === null || survey.unverifiable.length === 0) {
    return ["The survey lists no unverifiable item: verified is empty."];
  }
  return [
    `FACTS' unverifiable items (U1 to U${String(survey.unverifiable.length)}) are questions the survey could not settle. For each`,
    "one a clause depends on, open the code and settle it: list it in verified with its number, the",
    "answer and the path and line that show it. When the code does not settle it, report an unverifiable",
    "finding naming the clause. Leave items no clause depends on alone; verified is empty when you settle",
    "none.",
  ];
}

/**
 * How concise a spec is (`skills/product-to-spec`): a clause's text is what the person reads first,
 * so it says the behaviour in plain words and the detail a build needs sits in its criteria and
 * declarations; no criterion restates its clause.
 */
export const SPEC_CONCISION_RULE = [
  "Write the fewest clauses that cover the destination. A clause's text is the behaviour the person",
  "gets, in one to three short plain sentences someone who has not read the code follows at a glance.",
  "It names no error code, config key, field, column, heading or test, and lists no inputs or cases:",
  "that detail goes in the clause's criteria, or its reliesOn and adds. A criterion is one checkable",
  "outcome the clause text does not already state, in one or two plain sentences; never restate the",
  "clause. A criterion names an error code, config key or stored field it checks, but never a function,",
  "type, component, command or flag: how it is built is mechanism, left to the tickets. The spec names",
  "every config key and error code it adds, so never write that one is not added.",
  "Aim for at most six clauses and at most three criteria per clause; merge clauses that serve one",
  "behaviour.",
];

/** The id rule on a revision (`skills/product-to-spec`), with the `was` check core enforces. */
export const WAS_RULE = [
  "Ids: never split, move or renumber criteria. To change a criterion's meaning, drop it and add a new",
  "criterion with an id no revision of this spec used. Leave `was` out unless a criterion truly moved",
  "to another clause; then `was` names its old id, which this revision no longer uses. Never name an id",
  "this revision still uses, or one the previous revision never had; ZeNorm refuses either.",
];

/**
 * The repair's `removed` (RC4): core refuses a revision whose declared removals are not exactly
 * the ids it drops, and the review reads each reason.
 */
export const REMOVED_RULE = [
  "In `removed`, list every clause and criterion id of the latest revision that your revision no longer",
  "has, each with its reason: the finding, reason or note that drops it, or the id it merged into or",
  "moved to. A dropped clause's criteria are listed too. List nothing you keep; `removed` is empty when",
  "nothing is dropped. ZeNorm refuses a revision whose `removed` differs from what it drops.",
];

/** The length rule a To Spec run writes to, from its model's limits (`agent.models`). */
export function specLengthRule(limits: ModelLimits): string[] {
  return [
    `Keep the problem and the solution to ${lengthWords(limits.specProse)} each and each clause's text`,
    `to ${lengthWords(limits.clauseText)}; longer output is refused.`,
    limitsLine([
      `the spec's title ${lengthWords(limits.specTitle)}`,
      `each clause's title ${lengthWords(limits.clauseTitle)}`,
      `each criterion's text ${lengthWords(limits.criterionText)}`,
      `each reliesOn name and adds entry ${lengthWords(limits.clauseName)}`,
      `each Out of scope line ${lengthWords(limits.contentLine)}`,
    ]),
  ];
}

/** The length line a To Tickets run writes to, from its model's limits (`agent.models`). */
export function ticketLengthLine(limits: ModelLimits): string {
  return limitsLine([
    `each ticket's title ${lengthWords(limits.ticketTitle)}`,
    `its build ${lengthWords(limits.ticketBuild)}`,
    `each blocker's supplies, testing line and Out of scope line ${lengthWords(limits.contentLine)}`,
    `each disposition's reason or evidence ${lengthWords(limits.dispositionText)}`,
    `the slicing ${lengthWords(limits.ticketSetSlicing)}`,
    `the execution ${lengthWords(limits.ticketSetExecution)}`,
  ]);
}

/** The length line a review's summary is written to, from its model's limits (`agent.models`). */
export function summaryLengthLine(limit: LengthLimit): string {
  return limitsLine([`the summary ${lengthWords(limit)}`]);
}

/** The length line a spec review's findings and answers are written to (`agent.models`). */
export function specReviewLengthLine(limits: ModelLimits): string {
  return limitsLine([
    `each finding's title ${lengthWords(limits.waypointTitle)}`,
    `its explanation ${lengthWords(limits.findingExplanation)}`,
    `its question ${lengthWords(limits.waypointQuestion)}`,
    `each verified answer ${lengthWords(limits.surveyText)}`,
  ]);
}

/** The length line a tickets review's findings are written to (`agent.models`). */
export function ticketsReviewLengthLine(limits: ModelLimits): string {
  return limitsLine([
    `each finding's title ${lengthWords(limits.ticketsReviewFindingTitle)}`,
    `its explanation ${lengthWords(limits.ticketsReviewFindingExplanation)}`,
    `its question ${lengthWords(limits.ticketsReviewFindingQuestion)}`,
  ]);
}

/** The prompt of a map-scope To Spec run (spec D3): the cleared map, and its specs on a re-clear. */
export function buildDraftSpecsPrompt(request: DraftSpecsRequest, limits: ModelLimits): string {
  const nonce = randomUUID();
  const specs = request.specs.flatMap((spec) => [
    `Spec ${String(spec.latest.specNumber)}, latest revision ${String(spec.latest.revision)}, ${spec.approved ? "approved" : "not approved"}:`,
    ...idLines("Previous revision", spec.latest.content),
    retiredLine("Previous revision", spec.retiredIds),
    ...revisionBlock(spec.latest, nonce),
    ...(spec.feedback === null
      ? []
      : [feedbackLine(spec.feedback), ...feedbackBlock(spec.feedback, nonce)]),
    "",
  ]);
  const task =
    request.specs.length === 0
      ? [
          "The map is cleared and has no spec yet. Write its specs, giving every spec `specNumber` null.",
          ...SPEC_COUNT_RULE,
        ]
      : [
          "The map is cleared again after new decisions. For each spec that is not approved, write its next",
          "revision with its `specNumber`; leave approved specs alone. Write a new spec, with `specNumber`",
          "null, for any part of the destination no spec covers. When every spec listed is approved and the",
          "decisions leave no part of the destination uncovered, write no spec: `specs` is empty.",
        ];
  const revise = [
    "Revise rather than add. When a resolved waypoint touches a project spec listed above, or the",
    "decisions change what one says, write that spec's next revision with its `specNumber` instead of a",
    "new spec, as the skill says: start from its latest revision, keep every clause and criterion it",
    "keeps word for word with its id, keep a changed criterion's id, give a new criterion the next free",
    "id of its clause, and leave a removed one out. Only a project spec listed as approved and not held",
    "may be revised. For a held project spec the map changes, write no revision: add a wait",
    "{ specNumber, note } whose note states the change, written as its next revision once the hold ends.",
    "An open wait listed above stays open when you leave it out; name it again only to replace its note.",
    "With a wait and no spec to write, `specs` is empty. `waits` is empty when nothing is held.",
    limitsLine([`each wait's note ${lengthWords(limits.waitNote)}`]),
  ];
  const refused =
    request.refusedAttempt === null
      ? []
      : [
          DRAFT_SPECS_REFUSED_LINE,
          "Your previous attempt at these specs was refused for this problem; correct it:",
          ...block("REFUSED", nonce, request.refusedAttempt.problem),
          "",
        ];
  return [
    ...mapContext(request, request.mapRounds, nonce),
    specsOnMapLine(request.specs.length),
    "",
    ...specs,
    "The project's specs that other maps wrote, each with its latest revision:",
    ...projectSpecLines(request.projectSpecs, nonce),
    ...refused,
    ...task,
    "",
    ...revise,
    "Every clause new in a revision names its sources: resolved waypoints by number from the line above,",
    'or the destination and the person\'s answers to its rounds, both cited as { "kind": "destination" };',
    "cite a note only when this prompt gives one.",
    "",
    ...SPEC_DECLARATION_RULE,
    "",
    ...SPEC_TRACING_RULE,
    "",
    ...SPEC_MECHANISM_RULE,
    "",
    ...SPEC_GROUNDING_RULE,
    "",
    ...SPEC_CONCISION_RULE,
    "",
    ...WAS_RULE,
    "",
    ...specLengthRule(limits),
    "",
    ...BUSY_READER_RULE,
    "",
    ...SPEC_SELF_CHECK,
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}

/** The prompt of a spec-scope To Spec run (spec D3): repair one spec after a failed review or a rejection. */
export function buildReviseSpecPrompt(request: ReviseSpecRequest, limits: ModelLimits): string {
  const nonce = randomUUID();
  return [
    ...mapContext(request, request.mapRounds, nonce),
    revisingLine(request.latest),
    ...idLines("Previous revision", request.latest.content),
    retiredLine("Previous revision", request.retiredIds),
    feedbackLine(request.feedback),
    "",
    "The spec's latest revision:",
    ...revisionBlock(request.latest, nonce),
    "",
    ...feedbackBlock(request.feedback, nonce),
    "",
    ...earlierFindingsBlock(request.earlierFindings, nonce, [
      "Close each open earlier finding without reopening one that was already closed.",
    ]),
    "The project's specs that other maps wrote, each with its latest revision:",
    ...projectSpecLines(request.projectSpecs, nonce),
    ...refusedBlock(request.refusedAttempt, nonce),
    ...referenceLines(
      request.references,
      nonce,
      "What the latest revision's clauses rely on, with the code around each:",
    ),
    "Write the spec's next revision. Repair it as the skill says: change only what each finding, the",
    "reason or the note names, and keep every other clause, criterion and id as it was. Settle a finding",
    "about a code, a config key, a mechanism or a test in a criterion or in adds; change a clause's text",
    "only when the behaviour the person gets changes.",
    ...REMOVED_RULE,
    limitsLine([`each removed reason ${lengthWords(limits.removalReason)}`]),
    "",
    ...SPEC_DECLARATION_RULE,
    "",
    ...SPEC_MECHANISM_RULE,
    "",
    ...SPEC_GROUNDING_RULE,
    "",
    ...SPEC_CONCISION_RULE,
    "",
    ...WAS_RULE,
    "",
    ...specLengthRule(limits),
    "",
    ...BUSY_READER_RULE,
    "",
    ...SPEC_SELF_CHECK,
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}

/**
 * When a spec review's finding goes to the person (`skills/product-planning-review`): only a real gap
 * in their intent.
 */
export const SPEC_REVIEW_ROUTE_RULE = [
  "Report a finding only when a competent implementer following the spec would build something the",
  "person did not decide, contradict a resolution or a project rule, drop a settled decision, or be",
  "unable to tell what to build or test. Wording, precision and id bookkeeping that do not change what",
  "gets built are not findings. When in doubt on wording or style alone, no finding.",
  "undefined_term covers any decision left to the implementer that changes what the person or operator",
  "sees (which config key and section hold a new value, when a check runs, what happens on failure),",
  "and a criterion only a stand-in for the real behaviour it claims could prove, or one resting on an",
  "undefined step.",
  "Route a finding decision only when settling it changes scope or behaviour the person observes, and",
  "neither the sources nor the repository's conventions settle it. Everything else routes revise, naming",
  "the convention or source that settles it, including implementation mechanics such as configuration",
  "validation, which follow the repository's conventions (for example, no silent defaults) and are the",
  "writer's call.",
  "An element that removes or weakens an existing safety guarantee, permission boundary or enforced",
  "guardrail with no resolution from the person behind it is a contradiction: decision. When a",
  "resolution the person decided states a general rule that covers the case, it routes revise instead:",
  "the writer applies that rule.",
  "invented_scope is behaviour or scope the person would observe that no resolution, nor",
  "the destination and the person's answers to its rounds, supports: a new surface, a new refusal, a",
  "new step for the person, a widened scope.",
  "A mechanism the writer chose to carry out a settled behaviour (how detection works, internal checks,",
  "ordering) is never invented_scope and never decision: at most revise, when it contradicts a source",
  "or a project rule.",
  "Never ask for a criterion that restates its clause, or for an added clause or criterion unless",
  "something a source settles is missing. dropped_resolution includes a research finding or",
  "assumption a clause bears on but ignores or defers. unverifiable is a clause that depends on",
  "something about the code that neither FACTS, the excerpts nor the code you opened settles.",
  "A clause's text is the behaviour in plain words; its criteria and declarations carry the detail.",
  "Detail a criterion or adds entry states is stated: never ask to move it into the clause's text. A",
  "config key or error code the spec does not name is not added: never ask the spec to say so.",
];

/** The plain line naming the approved revision a reviewed revision changes, and who wrote it. */
export function changesSinceLine(changes: NonNullable<ReviewSpecRequest["changes"]>): string {
  const writer =
    changes.writer.kind === "this-map" ? "this map" : `map “${changes.writer.mapTitle}”`;
  return `Changes since approved revision ${String(changes.since)}, written by ${writer}`;
}

/** The plain line listing clause ids, or none. */
function clauseIdsLine(label: string, ids: readonly string[]): string {
  return `${label}: ${ids.length === 0 ? "none" : ids.join(", ")}`;
}

/**
 * What the reviewed revision changes since the spec's latest approved revision before it (S8b-17,
 * L213 D-6): its changes are checked against this map's destination; the unchanged clauses carry
 * approved decisions, often another map's, and are context.
 */
export function changesLines(changes: ReviewSpecRequest["changes"]): string[] {
  if (changes === null) {
    return [
      "Changes since approved revision: none. No earlier revision is approved: review every clause.",
      "",
    ];
  }
  return [
    changesSinceLine(changes),
    clauseIdsLine("Clauses new or changed since then", changes.changedClauses),
    clauseIdsLine("Clauses unchanged since then", changes.unchangedClauses),
    "Review what this revision changes: check the new and changed clauses against this map's",
    "destination and resolutions. The unchanged clauses carry decisions already approved in earlier",
    "revisions, often another map's: their sources (a destination, a note, a waypoint) are the map's that",
    "wrote them, not this map's. They are context: never report one as a contradiction of this map's",
    "destination or resolutions, as invented scope, or as needing this map's decision; a resolution one",
    "carries counts as carried. Only a change of this revision that breaks an unchanged clause is a",
    "finding, on the changed clause.",
    "",
  ];
}

/**
 * The ids the reviewed revision drops from the previous one, with the repair's reasons (RC4), so
 * the review judges each removal; none listed when a map-scope run or the first draft wrote it.
 */
export function removedLines(removed: ReviewSpecRequest["removed"], nonce: string): string[] {
  if (removed === null) {
    return [];
  }
  if (removed.length === 0) {
    return ["Removed since the previous revision: nothing.", ""];
  }
  return [
    "Removed since the previous revision, each with the reviser's reason:",
    ...block(
      "REMOVED",
      nonce,
      removed.map((removal) => `${removal.id}: ${removal.reason}`).join("\n"),
    ),
    "A removal that drops a settled resolution, the person's answer or a delivered behaviour without a",
    "finding, reason or note behind it is dropped_resolution: name the waypoint it drops in",
    "waypointNumbers (a removed id is not the revision's, so it is not in elementIds).",
    "",
  ];
}

/** The prompt of a spec review (spec D3, D5). */
export function buildReviewSpecPrompt(request: ReviewSpecRequest, limits: ModelLimits): string {
  const nonce = randomUUID();
  const before =
    request.before === null
      ? ["Previous revision: none. This is the spec's first revision.", ""]
      : [
          `Previous revision: ${String(request.before.revision)}`,
          previousDeliveryLine(request.before.delivery),
          ...idLines("Previous revision", request.before.content),
          ...revisionBlock(request.before, nonce),
          "",
        ];
  const others = request.otherSpecs.flatMap((ref) => [
    `Spec ${String(ref.specNumber)}, latest revision ${String(ref.revision)}:`,
    ...revisionBlock(ref, nonce),
    "",
  ]);
  return [
    ...mapContext(request, request.mapRounds, nonce),
    reviewOfLine(request.revision),
    ...idLines("Revision", request.revision.content),
    "",
    "The revision under review:",
    ...revisionBlock(request.revision, nonce),
    "",
    ...referenceLines(
      request.references,
      nonce,
      "What the revision's clauses rely on, with the code around each:",
    ),
    ...before,
    ...removedLines(request.removed, nonce),
    ...changesLines(request.changes),
    ...earlierFindingsBlock(request.earlierFindings, nonce, [
      "First check that the revision under review closes each earlier finding. A closed finding is not",
      "raised again. Text added to close an earlier finding is not new scope.",
    ]),
    ...(request.rejection === null
      ? []
      : [
          `The person rejected revision ${String(request.rejection.revision)} with this reason:`,
          ...block("REJECTION", nonce, request.rejection.reason),
          "The person's most recent word outranks earlier resolutions: where the revision follows this",
          "reason, that is not a contradiction or a dropped resolution.",
          "",
        ]),
    noteDirectedRevisionsLine(request.noteDirectedRevisions.map((entry) => entry.revision)),
    ...request.noteDirectedRevisions.flatMap((entry) => [
      `The person's note behind revision ${String(entry.revision)}:`,
      ...block(`NOTE-${String(entry.revision)}`, nonce, entry.note),
    ]),
    ...(request.noteDirectedRevisions.length === 0
      ? []
      : [
          "Each note is the person's word and outranks earlier resolutions, as a rejection reason does:",
          "where the revision follows a note, that is not a contradiction, a dropped resolution or invented",
          'scope. A clause citing { "kind": "note" } on that revision or a later one traces to its note.',
        ]),
    "",
    otherSpecsLine(request.otherSpecs.length),
    "",
    ...others,
    "Review the revision under review as the skill says. The other specs are context: a resolution one of",
    "them carries counts as carried. Name elements by the revision's clause and criterion ids.",
    "",
    ...SPEC_REVIEW_REPOSITORY_RULE,
    "",
    ...surveyItemsRule(request.survey),
    "",
    ...SPEC_TRACING_RULE,
    "",
    ...SPEC_MECHANISM_RULE,
    "",
    ...SPEC_REVIEW_ROUTE_RULE,
    "A finding that escalates opens a waypoint with its title and question, so its question is written as one:",
    ...WAYPOINT_QUESTION_RULE,
    "",
    ...BUSY_READER_RULE,
    "",
    ...REVISION_REVIEW_RULES,
    "",
    summaryLengthLine(limits.specReviewSummary),
    specReviewLengthLine(limits),
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}

/**
 * The rules core refuses a ticket set for breaking (`ticket_set_content_invalid`), stated once to
 * the writer and, as the one-work-ticket rule, to the reviewer.
 */
export const TICKET_SET_RULES = [
  "Core refuses a set that breaks these rules:",
  "- Each criterion has exactly one work ticket: a work disposition names one ticket of the set, and no",
  "  other ticket lists that criterion.",
  "- A ticket lists exactly the criteria whose work disposition names it.",
  "- The dispositions match the tickets: a ticket listing a criterion without its work disposition, or a",
  "  work disposition naming a ticket that does not list it, is refused.",
];

/**
 * What To Tickets writes beyond the skill's document rules: pointers from the code it read, the
 * build in the code's terms, satisfied for what already exists, and one ticket per visible slice.
 */
export const TICKET_WRITING_RULES = [
  "Before writing, read the code each criterion needs (Grep, Read). Then for each ticket:",
  "- pointers: the files and test files its work touches, as repository paths you opened (for example",
  "  packages/core/src/delivery.ts). Never a guessed path.",
  "- build: name the seams to change and the behaviour at each; never argv, flags, SQL or wire formats,",
  "  and never restate a waypoint's findings: the implementer reads them. The criteria ids link to the",
  "  clause text: never restate it, and a build names no change to code already in the shape its clause",
  "  asks for.",
  "A criterion the code already meets is satisfied, with the file and behaviour as evidence: never a work",
  "ticket.",
  "One person-visible slice is one ticket. Split only at an outcome the person can observe on its own:",
  "never into a chain where each ticket only unblocks the next: that chain is one ticket. A clause is not",
  "a slice. A build that leaves a branch throwing, a stub, or an export nothing uses until a later ticket",
  "is not a slice: it belongs in the ticket that makes it visible. A test a delivery run cannot execute (an",
  "opt-in live test needing a real external CLI or login) is never a ticket on its own: it goes in the",
  "ticket whose slice it verifies.",
];

/**
 * How concise a ticket set is to the person approving it (`skills/product-to-tickets`): the title,
 * slicing and execution are what they read, in plain words; the build, testing and pointers are the
 * implementer's brief and keep every detail.
 */
export const TICKET_CONCISION_RULE = [
  "The person approving the set reads each ticket's title, the slicing and the execution; the",
  "implementer reads the build, testing and pointers. Write each for its reader:",
  "- title: the one outcome the person can see once the ticket lands, in one short plain phrase someone",
  "  who has not read the code follows at a glance. One outcome, never a list of features joined by",
  "  commas or and. It names no package, file, function, type, field, flag or error code; a command the",
  "  person types is allowed.",
  "- slicing: one short plain line per ticket, saying what the person gets from it and which tickets it",
  "  waits on (T1), then at most one sentence on why the work is cut this way when those lines do not",
  "  already show it.",
  "- execution: one to three short plain sentences: whether an agent can verify every ticket, and what",
  "  only the person can check.",
  "The slicing and the execution name no file, package, function, type, field, flag, error code or",
  "criterion id, and restate no build. The build, testing and pointers keep every seam, field, error",
  "code and path the implementer needs: the plain title, slicing and execution never take detail out",
  "of them.",
];

/**
 * The prompt of a To Tickets run (spec D3): the approved revision, and on a rewrite the current
 * version. One line states the run's turn budget, `maxTurns`.
 */
export function buildDraftTicketSetPrompt(
  request: DraftTicketSetRequest,
  maxTurns: number,
  limits: ModelLimits,
): string {
  const nonce = randomUUID();
  const { rewrite } = request;
  const rewriteLines =
    rewrite === null
      ? []
      : [
          `The ticket set's current version ${String(rewrite.version)}:`,
          ...block("TICKET-SET", nonce, JSON.stringify(rewrite.content, null, 2)),
          ticketSetShapeLine(rewrite.content.tickets),
          "",
          rewriteFindingsLine(rewrite.findings.length),
          ...(rewrite.findings.length === 0
            ? []
            : [
                `A fresh tickets review of version ${String(rewrite.version)} failed with these findings:`,
                ...block("FINDINGS", nonce, JSON.stringify(rewrite.findings, null, 2)),
                "Repair every finding: change what each finding names and keep every other ticket, criterion",
                "and disposition as it was.",
                "",
              ]),
          directedVersionsLine(rewrite.directedVersions),
          ...(rewrite.directedVersions.length === 0
            ? []
            : [
                ...directedVersionBlocks(rewrite.directedVersions, nonce),
                "What each of these asks for is the person's word: keep it in the tickets you write, even",
                "where a review finding says no criterion states it. Where a later one changes an earlier",
                "one, follow the later one.",
                "",
              ]),
          ...(rewrite.reason === null
            ? []
            : [
                "The person's reason for rewriting it (a rejection, or a note through the escape hatch):",
                ...block("REASON", nonce, rewrite.reason),
                ...(rewrite.findings.length === 0
                  ? []
                  : [
                      "The person's reason is their most recent word and outranks the review findings: where",
                      "a finding and the reason disagree, follow the reason.",
                    ]),
                "",
              ]),
        ];
  return [
    // To Tickets does not read the destination's rounds (DR-15): its request has none.
    ...mapContext(request, [], nonce),
    "",
    ticketsForLine(request.approved),
    ...idLines("Revision", request.approved.content),
    rewriteLine(rewrite === null ? null : rewrite.version),
    firstTicketNumberLine(request.firstTicketNumber),
    "",
    "The approved revision:",
    ...revisionBlock(request.approved, nonce),
    "",
    ...textDeltaLines(request.delta, request.takenOut, nonce),
    // On a first revision every reading is "added, expected work, baseline none": nothing to read.
    ...(request.delta === null
      ? []
      : [
          "Each criterion read against the text delta and the baseline: its change, the disposition that",
          "suggests and the delivered ticket, run and commit that last built it:",
          ...readingLines(request.readings, false, nonce),
          "",
        ]),
    ...earlierTicketLines(request.earlierTickets),
    "The map's resolved waypoints that touch this spec:",
    ...touchingWaypointLines(request.touchingWaypoints, nonce),
    ...rewriteLines,
    ...ticketsEarlierFindingsBlock(request.earlierFindings, nonce, [
      "Close each open earlier finding without reopening one that was already closed.",
    ]),
    ...(request.refusedAttempt === null
      ? []
      : [
          `Previous attempt refused: ${request.refusedAttempt.code}`,
          "Core refused your previous attempt at this set for this problem; correct it:",
          ...block("REFUSED", nonce, request.refusedAttempt.problem),
          "",
        ]),
    "Write the tickets for the approved revision as the skill says, with one disposition per criterion id",
    "listed above and one per removed criterion. Number the tickets from the first ticket number, in",
    "order. Where a disposition departs from its expected kind, give the reason; a research finding",
    "about the delivered code reaches the tickets as such a reason. Write no ticket when nothing needs",
    "building.",
    `You have ${String(maxTurns)} turns: read, then answer before they run out.`,
    "",
    ...TICKET_WRITING_RULES,
    "",
    ...TICKET_CONCISION_RULE,
    ticketLengthLine(limits),
    "",
    ...TICKET_SET_RULES,
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}

/** The tickets review's repository step, as the spec review's (`SPEC_REVIEW_REPOSITORY_RULE`). */
export const TICKETS_REVIEW_REPOSITORY_RULE = [
  "Before judging, open the existing code each ticket's build changes: open each of its pointers and",
  "Grep for what its build names. Check that each ticket's build and testing fit the code as it is (real",
  "files and seams, the package boundaries in AGENTS.md). Each of these is a contradiction, revise:",
  "- a ticket that does not fit the code;",
  "- a work ticket whose behaviour the code already has: its criterion is satisfied, with that code as",
  "  evidence;",
  "- a ticket whose pointers name no path that exists in the repository;",
  "- a ticket whose outcome the person can't see until a later ticket lands (a throwing branch, an unused",
  "  export): the chain is one ticket.",
  "Pointers are exempt from tracing: a file a pointer names is never untraced_criterion.",
];

/** The tickets review's lines the skill's Tickets review section does not state. */
export const TICKETS_REVIEW_RULES = [
  "A finding whose fix needs a choice the approved revision does not make routes decision, never revise.",
  "Name tickets by id (T1) in ticketNumbers and criteria by id (1.1) in criterionIds, only ids listed",
  "above.",
  "A ticket's title, the slicing and the execution are for the person, in plain words; the build,",
  "testing and pointers carry the detail. Detail a build or testing line states is stated: never ask to",
  "move it into a title, the slicing or the execution.",
];

/** The prompt of a tickets review (slice 7c D2, D3): the approved revision and the version under review. */
export function buildReviewTicketSetPrompt(
  request: ReviewTicketSetRequest,
  skillPath: string,
  limits: ModelLimits,
): string {
  const nonce = randomUUID();
  const { approved, ticketSet } = request;
  return [
    ...preamble(request.projectName, request.baseBranch),
    "",
    reviewOfTicketsLine(approved.specNumber, ticketSet.version),
    `Follow the Tickets review section of the skill at ${skillPath}.`,
    "",
    "The person's idea for the map:",
    ...block("IDEA", nonce, request.idea),
    "",
    ...renderCodeSurvey(request.survey, nonce),
    `Spec ${String(approved.specNumber)}, approved revision ${String(approved.revision)}:`,
    ...block("SPEC-TITLE", nonce, approved.content.title),
    ...idLines("Revision", approved.content),
    ...revisionBlock(approved, nonce),
    "",
    `The ticket set's version ${String(ticketSet.version)}, under review:`,
    ticketIdsLine(
      "Version",
      ticketSet.content.tickets.map((ticket) => ticket.id),
    ),
    ...block(
      `TICKET-SET-VERSION-${String(ticketSet.version)}`,
      nonce,
      JSON.stringify(ticketSet.content, null, 2),
    ),
    ticketSetShapeLine(ticketSet.content.tickets),
    "",
    ...textDeltaLines(request.delta, request.takenOut, nonce),
    "Each criterion read against the text delta and the baseline, with each departing disposition's",
    "question and its reason:",
    ...readingLines(request.readings, true, nonce),
    "",
    "The map's resolved waypoints that touch this spec:",
    ...touchingWaypointLines(request.touchingWaypoints, nonce),
    directedVersionsLine(request.directedVersions),
    ...(request.directedVersions.length === 0
      ? []
      : [
          ...directedVersionBlocks(request.directedVersions, nonce),
          "What each of these asks for is the person's most recent word and counts as traced: a ticket",
          "detail, name or case it asks for is never untraced_criterion and never a revise finding, even",
          "where no criterion states it. Where a later one changes an earlier one, the later one counts.",
          "",
        ]),
    ...ticketsEarlierFindingsBlock(request.earlierFindings, nonce, [
      "First check that the version under review closes each earlier finding. A closed finding is not",
      "raised again. Text added to close an earlier finding is not new scope.",
    ]),
    ...TICKETS_REVIEW_REPOSITORY_RULE,
    "",
    ...TICKETS_REVIEW_RULES,
    "",
    summaryLengthLine(limits.ticketsReviewSummary),
    ticketsReviewLengthLine(limits),
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}
