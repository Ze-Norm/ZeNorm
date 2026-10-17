import { randomUUID } from "node:crypto";

import {
  CONSISTENCY_FINDINGS_MAX_COUNT,
  type CheckConsistencyRequest,
  type ModelLimits,
  type ResearchReport,
  type ResearchWaypointRequest,
  TASK_ROUND_QUESTIONS_MAX_COUNT,
  WAYPOINT_AGENT_DECIDED_MAX_COUNT,
  type WorkTaskRequest,
} from "@zenorm/contracts";

import {
  AGENT_ALONE_DECIDED_RULE,
  agentDecidedRule,
  block,
  DECISION_PROSE_RULE,
  BUSY_READER_RULE,
  INSTANCE_CONFIG_RULE,
  lengthWords,
  mapRoundLines,
  preamble,
  renderCodeSurvey,
  renderRound,
  WAYPOINT_QUESTION_RULE,
} from "./prompt-parts.ts";
import {
  answeredRoundsLine,
  fogAndOutOfScope,
  mapChangesRules,
  outOfScopeRule,
  projectSuggestionLines,
  proposalsRules,
  questionShapeRules,
  renderOtherWaypoints,
  touchedSpecLines,
  waypointNoteLines,
  waypointNumberLine,
} from "./wayfinding-prompt.ts";

/** The plain line carrying how many earlier reports the waypoint has; the e2e stand-in keys on it. */
export function earlierReportsLine(count: number): string {
  return `Earlier reports on this waypoint: ${String(count)}`;
}

/** The plain line carrying how many earlier outcomes the task has; the e2e stand-in keys on it. */
export function earlierOutcomesLine(count: number): string {
  return `Earlier outcomes on this task: ${String(count)}`;
}

/** The plain line carrying how many resolved waypoints a pass compares; the e2e stand-in keys on it. */
export function comparedLine(count: number): string {
  return `Resolved waypoints compared: ${String(count)}`;
}

/** The plain line saying who stands behind a compared resolution: the person, or the agent alone. */
export function decidedByLine(decidedByPerson: boolean): string {
  return `Decided by: ${decidedByPerson ? "the person" : "the agent alone"}`;
}

/** The plain line carrying how many compared waypoints an earlier pass opened; the stand-in keys on it. */
export function openedByPassLine(count: number): string {
  return `Waypoints opened by an earlier pass: ${String(count)}`;
}

type WaypointRunRequest = ResearchWaypointRequest | WorkTaskRequest;

/** The map's context and the waypoint being worked, each person-written text in a nonce block. */
function mapContext(request: WaypointRunRequest, nonce: string): string[] {
  const { waypoint } = request;
  const others = renderOtherWaypoints(request.otherWaypoints, nonce);
  return [
    "The person's idea for the map:",
    ...block("IDEA", nonce, request.idea),
    "",
    "The map's title:",
    ...block("TITLE", nonce, request.title),
    "",
    "The map's confirmed destination:",
    ...block("DESTINATION", nonce, request.destination),
    "",
    ...mapRoundLines(request.mapRounds, nonce),
    ...renderCodeSurvey(request.survey, nonce),
    waypointNumberLine(waypoint.number),
    ...block(
      "THIS-WAYPOINT",
      nonce,
      [`Kind: ${waypoint.kind}`, `Title: ${waypoint.title}`, `Question: ${waypoint.question}`].join(
        "\n",
      ),
    ),
    "",
    ...waypointNoteLines(request.note, nonce),
    "The map's other waypoints, by number:",
    ...others,
    ...fogAndOutOfScope(request, nonce),
    ...projectSuggestionLines(request, nonce),
  ];
}

function renderReport(report: ResearchReport): string {
  return [
    `Answered: ${report.answered ? "yes" : "no"}`,
    `Summary: ${report.summary}`,
    ...(report.gap === null ? [] : [`Gap: ${report.gap}`]),
    ...report.findings.map(
      (finding, index) =>
        `Finding ${String(index + 1)}: ${finding.title}: ${finding.detail} (sources ${finding.sources.join(", ")})`,
    ),
    ...report.sources.map(
      (source, index) =>
        `Source ${String(index + 1)} (${source.kind}): ${source.title}${source.url === null ? "" : ` <${source.url}>`}: ${source.excerpt}`,
    ),
    ...report.limitations.map((limitation) => `Limitation: ${limitation}`),
    ...report.uncertainties.map((uncertainty) => `Uncertainty: ${uncertainty}`),
  ].join("\n");
}

/**
 * When a research run answers and when it leaves a gap (`skills/research`): answered false only for
 * a gap the person can close; what only running something can settle is an assumption and a risk.
 */
export const RESEARCH_ANSWER_RULE = [
  "- Set answered false only for a gap the person can close: a preference, scope, access, or a fact about",
  "  their environment or data. A recommendation cannot answer a human preference. Then name the gap and",
  "  leave gist null.",
  "- When what remains can only be settled by running something (a live experiment or spike), not by",
  "  documentation or source, do not leave it as a gap: answer with what primary sources establish, and",
  '  record each unverified part as an uncertainty starting "Assumption:" that names the risk and how',
  "  delivery verifies it (the opt-in live test, an early spike ticket). Say each assumption in the",
  "  summary too: the summary is the resolution the spec reads.",
];

/**
 * The planning agent's prompt for researching one waypoint (spec D2): the rules are
 * `skills/research`'s, written here. The idea and every earlier text sit in blocks under one fresh
 * nonce per call (L63). Plain lines carry the waypoint's number and its earlier report count; one
 * line states the run's turn budget, `maxTurns`; the report's lengths are the run's model's (`limits`).
 */
export function buildResearchPrompt(
  request: ResearchWaypointRequest,
  limits: ModelLimits,
  maxTurns: number,
): string {
  const nonce = randomUUID();
  const reports =
    request.earlierReports.length === 0
      ? ["No earlier research on this waypoint.", ""]
      : [
          "Earlier research on this waypoint could not answer it. Its reports, oldest first:",
          "",
          ...request.earlierReports.flatMap((report, index) => [
            ...block(`EARLIER-REPORT-${String(index + 1)}`, nonce, renderReport(report)),
            "",
          ]),
          "Do not repeat their work: start from their gaps. A gap only running something can close is not",
          "a gap for the person: answer now, recording it as an assumption and a risk.",
          "",
        ];
  return [
    ...preamble(request.projectName, request.baseBranch),
    "For this research you may also search and read the web with the WebSearch and WebFetch tools.",
    "",
    "You are working one Research waypoint of this map: one named fact a decision depends on.",
    earlierReportsLine(request.earlierReports.length),
    ...mapContext(request, nonce),
    ...touchedSpecLines(request.waypoint.touches, nonce),
    ...reports,
    "Your task: research this waypoint's question and write its report, or rule it out of scope.",
    `You have ${String(maxTurns)} turns: fetch the evidence that settles the decision first, and answer before they run out.`,
    "",
    "- For each piece of code that depends on what the change replaces or extends, state as a finding",
    "  whether the new option supports it as the code uses it today, citing its file as a repository_file",
    "  source; record one you cannot verify as an assumption. Then identify the decision this fact changes",
    "  and the smallest primary evidence that can settle it.",
    "- For a command-line tool or service, check its own reference (its documented --help text, command",
    "  and flag reference, configuration and event or output schema docs, and its source where published)",
    "  for each specific capability the decision needs, such as a login status command, structured output,",
    "  or subprocess and subagent events, before concluding it is absent. State an absence only with the",
    "  source you checked.",
    "- Use primary sources: official documentation, source code, specifications, first-party APIs, and this",
    "  repository; never a secondary write-up of them. Follow every claim back to the source that owns it.",
    "- Stop once the question is answered with its material limitations. Broaden to implementation sources",
    "  only when primary documentation leaves a decision-changing contradiction or gap.",
    ...RESEARCH_ANSWER_RULE,
    "- A choice of implementation mechanics (where a configuration key lives, internal API shapes, error",
    "  codes, parser details, flags, test seams) is not a preference only the person can confirm: settle it",
    "  from the evidence, state it as an assumption, and answer.",
    "",
    "The report:",
    "- answered: true when the question is answered. Then gap is null, and findings has at least one finding.",
    `- summary: the concise answer, or what was established when unanswered; ${lengthWords(limits.researchSummary)}.`,
    `- gap: what could not be established, only when unanswered; ${lengthWords(limits.researchNote)}.`,
    `- gist: one line for the map's Decisions so far, ${lengthWords(limits.gist)}, only when answered.`,
    `- findings: each a title (${lengthWords(limits.researchFindingTitle)}), the detail (${lengthWords(limits.researchFindingDetail)};`,
    "  distinguish established fact, inference and recommendation, and give source versions or dates where",
    "  they affect the answer), and the 1-based positions in sources it rests on.",
    "- sources: each a kind (map, waypoint, specification, repository_file or external), a title (a",
    `  repository_file's is its path; ${lengthWords(limits.researchSourceTitle)}), a url only for external (null`,
    `  otherwise) and the excerpt the findings rest on (${lengthWords(limits.researchExcerpt)}).`,
    "- limitations and uncertainties: what the report does not cover and what stays uncertain, each",
    `  ${lengthWords(limits.researchNote)}.`,
    "",
    ...outOfScopeRule(limits),
    "Set exactly one of report and outOfScope; the other is null.",
    "",
    ...mapChangesRules(limits),
    "",
    ...BUSY_READER_RULE,
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}

/**
 * What a Task run may ask the person (L115): only what only they have, never engineering work. A
 * fact delivery will verify is recorded as an assumption, not asked.
 */
export const TASK_ASK_RULE = [
  "- You can only read the repository. Ask the person only for what only they have: access, credentials,",
  "  accounts, facts about their environment or data the plan depends on, or a preference.",
  "  Never hand them engineering work: no experiment to run, command to try, code to write or behaviour",
  "  to test for you.",
  ...INSTANCE_CONFIG_RULE.map((line, index) => `${index === 0 ? "- " : "  "}${line}`),
  "- A fact you cannot verify read-only that delivery will verify (its tests, a live test) is not asked:",
  "  record it in facts as an assumption and a risk for the spec, and finish done.",
  "- Offer the likely answers as options and recommend the one the repository points to; a name or value",
  "  only the person can type (an account, an org) goes in their words beside the option they choose.",
];

/**
 * The planning agent's prompt for working one Task waypoint (spec D2). Task runs are read-only
 * (L115): anything else is asked of the person in a round with options, the recommendation first.
 * The idea and every earlier text sit in blocks under one fresh nonce per call (L63). Plain lines
 * carry the waypoint's number, its answered round count and its earlier outcome count; one line
 * states the run's turn budget, `maxTurns`; the question lengths are the run's model's (`limits`).
 */
export function buildTaskPrompt(
  request: WorkTaskRequest,
  limits: ModelLimits,
  maxTurns: number,
): string {
  const nonce = randomUUID();
  const rounds = request.waypoint.rounds.flatMap((round, index) => {
    const number = String(index + 1);
    return [
      `Round ${number}:`,
      "",
      ...renderRound(`ROUND-${number}`, nonce, round.questions, round.answers),
    ];
  });
  const outcomes = request.earlierOutcomes.flatMap((outcome, index) => [
    ...block(
      `EARLIER-OUTCOME-${String(index + 1)}`,
      nonce,
      [`Outcome: ${outcome.outcome}`, `Action: ${outcome.action}`, `Facts: ${outcome.facts}`].join(
        "\n",
      ),
    ),
    "",
  ]);
  return [
    ...preamble(request.projectName, request.baseBranch),
    "",
    "You are working one Task waypoint of this map: mechanical work a decision needs, recorded as the work",
    "done and the facts it produced.",
    answeredRoundsLine(request.waypoint.rounds.length),
    earlierOutcomesLine(request.earlierOutcomes.length),
    ...mapContext(request, nonce),
    ...touchedSpecLines(request.waypoint.touches, nonce),
    ...(rounds.length === 0
      ? ["No round on this task has been asked yet.", ""]
      : ["The rounds answered on this task, oldest first:", "", ...rounds]),
    ...(outcomes.length === 0
      ? ["No earlier attempt at this task.", ""]
      : [
          "Earlier attempts at this task, oldest first; do not repeat what stopped them:",
          "",
          ...outcomes,
        ]),
    "Your task: do this waypoint's work and record it, ask the person for what only they can give, or rule",
    "it out of scope.",
    `You have ${String(maxTurns)} turns: read what settles the work first, and answer before they run out.`,
    "",
    ...TASK_ASK_RULE,
    "- kind round: to ask, set intro and questions and leave mapChanges null: a one- or",
    `  two-sentence intro (${lengthWords(limits.roundIntro)}) and 1 to ${String(TASK_ROUND_QUESTIONS_MAX_COUNT)} questions.`,
    ...questionShapeRules(limits),
    `- done: when the work is done. action says what was done (${lengthWords(limits.taskAction)}); facts are the`,
    `  resulting facts the decision needs, which resolve the waypoint (${lengthWords(limits.taskFacts)}); gist is one`,
    `  line for the map's Decisions so far, ${lengthWords(limits.gist)}. The facts:`,
    ...DECISION_PROSE_RULE.map((line) => `  ${line}`),
    "  With them:",
    ...(request.waypoint.rounds.length === 0
      ? AGENT_ALONE_DECIDED_RULE
      : agentDecidedRule(limits.agentDecided, WAYPOINT_AGENT_DECIDED_MAX_COUNT)
    ).map((line) => `  ${line}`),
    "- failed: when the work cannot be done and no answer from the person would change that. action says",
    "  what was tried; facts say what stopped it; the same lengths as done's.",
    ...outOfScopeRule(limits),
    "Set kind to round, done, failed or outOfScope and fill that outcome's fields; the others' are null.",
    "Set mapChanges exactly when you ask no round.",
    "",
    ...mapChangesRules(limits),
    "",
    ...BUSY_READER_RULE,
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}

/**
 * The planning agent's prompt for a consistency pass (spec D2): the rules are `skills/wayfinder`'s
 * pass rules, written here. The idea and every earlier text sit in blocks under one fresh nonce per
 * call (L63). Plain lines carry the compared count and how many compared waypoints a pass opened;
 * the findings' lengths are the run's model's (`limits`).
 */
export function buildConsistencyPrompt(
  request: CheckConsistencyRequest,
  limits: ModelLimits,
): string {
  const nonce = randomUUID();
  const opened = request.waypoints.filter((waypoint) => waypoint.finding !== null).length;
  const waypoints = request.waypoints.flatMap((waypoint) => {
    const finding =
      waypoint.finding === null
        ? []
        : [
            `Opened by an earlier pass's ${waypoint.finding.kind} finding on waypoints ${waypoint.finding.waypointNumbers.join(", ")}`,
          ];
    return [
      `Resolved waypoint ${String(waypoint.number)}:`,
      ...block(
        `WAYPOINT-${String(waypoint.number)}`,
        nonce,
        [
          `Kind: ${waypoint.kind}`,
          `Title: ${waypoint.title}`,
          `Question: ${waypoint.question}`,
          decidedByLine(waypoint.decidedByPerson),
          `New since the last pass: ${waypoint.newSinceLastPass ? "yes" : "no"}`,
          ...finding,
          "Resolution:",
          waypoint.resolution,
        ].join("\n"),
      ),
      "",
    ];
  });
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
    ...mapRoundLines(request.mapRounds, nonce),
    "The map's Out of scope lines:",
    ...outOfScope,
    ...projectSuggestionLines(request, nonce),
    ...renderCodeSurvey(request.survey, nonce),
    "Every waypoint of this map is resolved or out of scope. You are running its consistency pass: the",
    "waypoints were resolved one at a time, so two resolutions can each be sound and still contradict each",
    "other.",
    comparedLine(request.waypoints.length),
    openedByPassLine(opened),
    "",
    ...waypoints,
    "Your task: read every resolution in full and compare each with every other. Report only a conflict",
    "the person would care about: one whose answer changes scope, behaviour the person can observe, cost,",
    "or risk. Three kinds:",
    "- conflicting_surfaces: two resolutions that cannot both hold.",
    "- undefined_term: a resolution relies on a term, record or surface that no resolution defines and",
    "  whose meaning changes what the person gets.",
    "- deferred_case_assumed: a resolution depends on a case that another waypoint or an Out of scope line",
    "  deferred, excluded or left to later work.",
    "",
    "Bookkeeping is never a finding: a reference to a waypoint number that does not exist or names the",
    "wrong one, different wording for one thing, a missing Out of scope line, a term whose meaning is",
    "plain from context, or a difference in implementation mechanics the spec and tickets can settle.",
    "When in doubt, report no finding.",
    "",
    "Report a finding only when settling it needs the person: at least one resolution it involves was",
    "decided by the person, or it conflicts with the destination, or settling it changes scope, behaviour",
    "the person observes, cost or risk. A conflict between resolutions the agent decided alone, over",
    "details the person would not notice, is not a finding: the spec reconciles it.",
    "",
    "- A later resolution that explicitly reconciles two earlier ones settles their conflict: report no",
    "  finding for it. A conflict an earlier pass opened and its waypoint resolved is settled: do not",
    "  report it again in other words.",
    "- Report only a conflict involving at least one waypoint marked New since the last pass: yes; a",
    "  finding naming only waypoints marked no is dropped.",
    "- Decide nothing: recommend no fix, do not redesign the destination, and do not re-ask what a",
    "  resolution already answers.",
    `- Return 0 to ${String(CONSISTENCY_FINDINGS_MAX_COUNT)} findings; none when the resolutions agree on what the person would notice.`,
    "  Each becomes a new Grilling waypoint; its run asks the person only when the answer changes scope,",
    "  observable behaviour, cost or risk, and otherwise settles it itself.",
    "- Each finding: its kind; waypointNumbers, the numbers of every resolved waypoint it involves (at least",
    `  one); a short title (${lengthWords(limits.waypointTitle)}) and the question to settle`,
    `  (${lengthWords(limits.waypointQuestion)}), as that new waypoint's; and an explanation`,
    `  (${lengthWords(limits.findingExplanation)}) that quotes the wording each finding rests on.`,
    ...WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`),
    "",
    "A conflict between resolutions is always a finding, never a proposal. Besides the findings, set",
    `the ${proposalsRules(limits).join("\n")}`,
    "",
    ...BUSY_READER_RULE,
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}
