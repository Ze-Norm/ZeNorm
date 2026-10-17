import { randomUUID } from "node:crypto";

import {
  type HatchStage,
  type ModelLimits,
  type ReplyThroughHatchRequest,
} from "@zenorm/contracts";

import {
  agentDecidedLines,
  block,
  lengthWords,
  mapRoundLines,
  preamble,
  READER_ADDRESS_RULE,
  renderCodeSurvey,
  WAYPOINT_QUESTION_RULE,
} from "./prompt-parts.ts";
import { openWaitLines } from "./revision-prompt-parts.ts";
import {
  mapTitleRule,
  NO_REPEAT_SUGGESTION_RULE,
  projectSuggestionLines,
  PROPOSAL_IDEA_RULE,
  SALIENT_SUGGESTION_RULE,
} from "./wayfinding-prompt.ts";

type HatchWaypoint = ReplyThroughHatchRequest["waypoints"][number];
type HatchSpec = ReplyThroughHatchRequest["specs"][number];

/** The plain line before the message the agent replies to; the e2e stand-in keys its role on it (L107). */
export const MESSAGE_LINE = "Message from the person:";

/** The plain line naming the stage on screen when the message was sent. */
export function stageOnScreenLine(stage: HatchStage): string {
  return `Stage on screen: ${stage}`;
}

/** The plain line naming the spec on screen by number, or none. */
export function specOnScreenLine(specNumber: number | null): string {
  return `Spec on screen: ${specNumber === null ? "none" : String(specNumber)}`;
}

/**
 * The plain line giving one waypoint's number and status, `, stopped` when its scope stopped after a
 * failed retry (L164); the stand-in reads the map from these.
 */
export function waypointStatusLine(waypoint: HatchWaypoint): string {
  const waiting = waypoint.waiting === null ? "" : `, waiting: ${waypoint.waiting}`;
  const stopped = waypoint.stopped ? ", stopped" : "";
  return `Waypoint ${String(waypoint.number)} status: ${waypoint.status}${waiting}${stopped}`;
}

/** The plain line listing the map's fog positions, or none. */
export function fogPositionsLine(positions: readonly number[]): string {
  return `Fog positions: ${positions.length === 0 ? "none" : positions.join(", ")}`;
}

/** The plain line giving one spec's latest revision, ticket set with its review, and what runs on it. */
export function specStateLine(spec: HatchSpec): string {
  const ticketSet =
    spec.ticketSet === null
      ? "none"
      : `version ${String(spec.ticketSet.version)} ${spec.ticketSet.state}, review ${spec.ticketSet.review}`;
  const inFlight = spec.inFlight.length === 0 ? "none" : spec.inFlight.join(", ");
  return `Spec ${String(spec.latest.specNumber)}: revision ${String(spec.latest.revision)} ${spec.state}; ticket set: ${ticketSet}; in flight: ${inFlight}`;
}

/** The plain line before a held ticket set's escalated findings (slice 7c D8). */
export function heldFindingsLine(specNumber: number, count: number): string {
  return `Spec ${String(specNumber)} ticket set held, findings: ${String(count)}`;
}

/** The plain line counting the earlier messages the request carries. */
export function earlierMessagesLine(count: number): string {
  return `Earlier messages: ${String(count)}`;
}

/** The plain line saying whether core refused this reply's previous attempt; always sent. */
export function refusedAttemptLine(refused: boolean): string {
  return `Previous attempt refused: ${refused ? "yes" : "no"}`;
}

/** Which message is which: the stage it came from and the spec on screen. */
function sentFrom(stage: HatchStage, specNumber: number | null): string {
  return specNumber === null
    ? `sent from ${stage}`
    : `sent from ${stage}, spec ${String(specNumber)}`;
}

/** D5's rules: when a message gets a change and which one (slice 7b spec D5, L145 (3), (4)). */
export const HATCH_JUDGMENT_RULES = [
  "How to judge the message:",
  "- A question, or anything asking what the records say, gets a reply and no change (change null), even",
  "  when the answer suggests a change. Your reply may say what the person could send to make that change;",
  "  an open round is answered on its stage page, never here.",
  "- A statement or instruction of what should be different gets the one change it names.",
  "- Without a named target, the stage on screen decides: on spec, revise_spec; on tickets,",
  "  rewrite_tickets; on wayfinding or idea, the change to the waypoint the message names.",
  "- A message saying a decision itself was wrong reopens that waypoint (reopen). A message changing only",
  "  the spec's text revises the spec (revise_spec).",
  "- A message asking for several changes gets the first change only, and your reply names what to send",
  "  next for the rest. One change per message.",
  "- A message you cannot map to exactly one change gets a question back in the reply and no change.",
  "- There is no confirm step: the reply that states the change is the confirmation. Say plainly what you",
  "  changed, in the past tense, and where it lands (a new round, revision or ticket set on its stage).",
  "- A message about a spec this map waits on (listed under Open waits) gets a reply and no change (change",
  "  null), and the message itself is not saved anywhere. Your reply says another map holds the spec's",
  "  unapproved revision, one unapproved revision at a time; when that revision is approved there, the change",
  "  this map waits with (its note shown under Open waits) is written as the spec's next revision. Never say",
  "  this message was saved, recorded or added to the wait; say the person can send it again once the spec is free.",
];

/**
 * The plain line naming the specs whose latest revision is approved (S7b-8, L156 (2)): the re-clear
 * after a reopen writes no revision of those, and none at all when every spec is approved.
 */
export function approvedSpecsLine(specs: readonly HatchSpec[]): string {
  const approved = specs
    .filter((spec) => spec.state === "approved")
    .map((spec) => String(spec.latest.specNumber));
  return `Approved specs: ${approved.length === 0 ? "none" : approved.join(", ")}`;
}

/**
 * After a reopen the map's re-clear writes the next revision of each spec that is not approved by
 * itself (S7b-8, L149 (a)), so the reply never asks the person to send a revision or a note for it; an
 * approved spec stands and gets no revision (L125 (3), L156 (2)), so the reply promises none for it.
 */
export const REOPEN_RECLEAR_RULE = [
  "  Once it is decided again, the map clears again, and its re-clear writes the next revision of each spec",
  "  whose latest revision is not approved, by itself: after a reopen, never tell the person to send a spec",
  "  revision or a note for the spec. Only such a spec (one not listed under Approved specs above) follows",
  "  the new decision; say so only of it, by its number.",
  "  An approved spec (listed under Approved specs above) stands: the re-clear writes no revision of it and",
  "  no new tickets for it. When every spec is",
  "  approved, say only that the waypoint is open to be decided again and the approved spec stands as it",
  "  is; never say a spec, its revision, its tickets or anything else will follow, reflect or pick up the",
  "  new decision when the map clears again, and promise no other follow-up for it.",
];

/**
 * An approved or delivered spec is changed through `revise_spec` (slice 8b S8b-7, L213 D-3): ZeNorm
 * writes its next revision from this map through a note run, or records a wait when another map
 * holds the spec. Placed before `revise_spec`'s own line, so the rule reads with it.
 */
export const REVISE_APPROVED_SPEC_RULE = [
  "- An approved or delivered spec can be changed from here: when the message asks to change what the",
  "  spec on screen says, and it is approved or already delivered, propose revise_spec. ZeNorm writes its",
  "  next revision from this map with the message as the note, and that revision is reviewed, approved",
  "  and given tickets as any other; or, when another map holds the spec, it records the change as a",
  "  wait and writes it once that map's work ends. Never reply that an approved or delivered spec cannot",
  "  be changed or revised here.",
];

/**
 * A message that reopens, rewords or reruns a waypoint is that waypoint's note (S7b-10, L162 (3)):
 * its next run reads the message's text, so the reply never says the message cannot reach it.
 */
export const WAYPOINT_NOTE_RULE = [
  "- Your message travels with the change: after reopen, reword or run_waypoint, the waypoint's next run",
  "  (its grilling, research or task) reads this message in full as the person's note and follows it. So never",
  "  tell the person that instructions, details or a focus in the message can't be passed on or attached to that",
  "  run, and never ask the person to send them again or another way; say the run will follow them.",
];

/**
 * A stopped waypoint the reply does not rerun (L164, slice 7c D8): the reply points at Try again or a
 * note and never promises a run.
 */
export const STOPPED_WAYPOINT_RULE = [
  "- A waypoint marked stopped had its run fail twice, and nothing runs it until the person acts. When your",
  "  reply is about a stopped waypoint and your change is not run_waypoint on it, say the person can press Try",
  "  again on the waypoint, or send a note asking to rerun it; never say it will run, is running, or will",
  "  be retried.",
];

/**
 * A held ticket set (slice 7c D8, issue 21 item 4): a statement of how to fix the tickets is
 * `rewrite_tickets`; a question about the hold gets a reply naming the held findings.
 */
export const HELD_TICKET_SET_RULES = [
  "- A ticket set whose review is held waits on the person: its tickets review found problems only they can",
  "  settle, or its repairs kept failing; its held findings are listed with the spec above. A statement of",
  "  how to fix the tickets is rewrite_tickets: the rewrite follows the message, and its new version gets a",
  "  full review. A question about the hold gets a reply that names the held findings, and no change.",
];

/**
 * Waypoint 8's rule (map proposals): the hatch proposes a new map for outside work with a line of
 * its own, or splits an existing Out of scope line off into one by its position; this map's
 * destination never changes, and a line already split off is refused. Like every suggesting run, it
 * never repeats a listed suggestion or an existing map and suggests only salient, clearly worded maps.
 */
export const PROPOSE_MAP_RULE = [
  "- propose_map {title, idea, line, splitsLine}: a new map for work outside this map's destination, which the person",
  "  confirms or dismisses on Wayfinding, at any stage; this map's destination never changes, and work",
  "  inside it is never proposed. Set exactly one of line and splitsLine, the other null:",
  "  - When the person asks to make an existing Out of scope line its own map, splitsLine is that line's position",
  "    (shown above each Out of scope line) and line is null: the line stays as it is, once.",
  "  - Otherwise line is the new Out of scope line saying what this map leaves to the new map.",
  "  An Out of scope line already split off into a map, or a position with no line, is refused by ZeNorm.",
  ...NO_REPEAT_SUGGESTION_RULE.map((line) => `  ${line}`),
  ...SALIENT_SUGGESTION_RULE.map((line) => `  ${line}`),
  "  When the message asks for a map a listed suggestion or map already covers, make no change: your",
  "  reply names that suggestion or map and its state or stage.",
];

/** The shape of each change and when it fits (slice 7b spec D3, D4), its lengths the model's. */
function changeRules(limits: ModelLimits): string[] {
  return [
    "The changes (set change to exactly one of these, or null):",
    "- reopen {waypoint}: a resolved waypoint whose decision was wrong goes back to open; the waypoints it",
    "  blocks reopen with it and the map is no longer cleared.",
    ...REOPEN_RECLEAR_RULE,
    "- open_waypoint {waypointKind, title, question, blockedBy, fog}: a new waypoint. waypointKind is research",
    "  only for a named unknown fact that could change a decision, task only for mechanical work a decision",
    "  needs, grilling for a decision the person makes. blockedBy lists numbers of existing waypoints only.",
    `  The title is ${lengthWords(limits.waypointTitle)}, the question ${lengthWords(limits.waypointQuestion)}.`,
    ...WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`),
    "- reword {waypoint, title, question}: an open or claimed waypoint asks the wrong question; its new title",
    "  and question replace the old, with open_waypoint's lengths.",
    "- rule_out_of_scope {waypoint, reason, fog}: an open or claimed waypoint falls outside the destination;",
    `  the reason becomes its Out of scope line (${lengthWords(limits.mapLine)}).`,
    "- run_waypoint {waypoint}: a waypoint waiting on the person or stopped, of any kind, runs again: an unanswered",
    "  report, a failed task, or a waypoint marked stopped after its run failed twice.",
    ...STOPPED_WAYPOINT_RULE,
    `- accept_report {waypoint, gist, fog}: a waypoint waiting on an unanswered report is resolved from that`,
    `  report; gist is its line for Decisions so far, ${lengthWords(limits.gist)}.`,
    "  Write the gist from the report's summary shown with the waypoint above (what the research found, as",
    "  accepted), not from the message alone.",
    ...WAYPOINT_NOTE_RULE,
    ...REVISE_APPROVED_SPEC_RULE,
    "- revise_spec {}: the spec on screen gets its next revision with the message as the note. Write no",
    "  spec text: the spec is written by its own run.",
    "- rewrite_tickets {}: the spec on screen's ticket set is rewritten with the message as the reason. Write",
    "  no tickets: they are written by their own run.",
    ...HELD_TICKET_SET_RULES,
    ...PROPOSE_MAP_RULE,
    `  Its line is ${lengthWords(limits.mapLine)}.`,
    ...mapTitleRule(limits).map((line) => `  ${line}`),
    ...PROPOSAL_IDEA_RULE.map((line) => `  ${line}`),
    "fog uses the map changes shape (newWaypoints, fogOutOfScope, fogDecided, fogSettledHere, newFog):",
    "leave every list empty. Fog left once no waypoint is open or claimed is settled by the map's own fog",
    "run. Name only waypoint numbers listed above.",
    "Name a change only when it fits the records: a spec in flight, an approved ticket set, or a",
    "waypoint whose status no longer fits is refused by ZeNorm, and the person sees why.",
  ];
}

function renderWaypoint(waypoint: HatchWaypoint, nonce: string): string[] {
  const text = [
    `Number: ${String(waypoint.number)}`,
    `Kind: ${waypoint.kind}`,
    `Title: ${waypoint.title}`,
    `Question: ${waypoint.question}`,
    `Status: ${waypoint.status}`,
    `Blocked by: ${waypoint.blockedBy.length === 0 ? "none" : waypoint.blockedBy.join(", ")}`,
    ...(waypoint.waiting === null ? [] : [`Waiting on the person: ${waypoint.waiting}`]),
    ...(waypoint.stopped
      ? ["Stopped: its run failed twice; Try again or run_waypoint runs it again."]
      : []),
    ...(waypoint.report === null
      ? []
      : [
          `Unanswered report summary: ${waypoint.report.summary}`,
          `Unanswered report gap: ${waypoint.report.gap}`,
        ]),
    ...(waypoint.gist === null ? [] : [`Gist: ${waypoint.gist}`]),
    ...(waypoint.agentDecided === null ? [] : agentDecidedLines(waypoint.agentDecided)),
    ...(waypoint.resolution === null ? [] : [`Resolution: ${waypoint.resolution}`]),
  ].join("\n");
  return [
    waypointStatusLine(waypoint),
    ...block(`WAYPOINT-${String(waypoint.number)}`, nonce, text),
    "",
  ];
}

/** A held ticket set's escalated findings, each title and question in its block; none otherwise. */
function renderHeldFindings(spec: HatchSpec, nonce: string): string[] {
  const findings = spec.ticketSet?.heldFindings;
  if (findings === undefined || findings === null) {
    return [];
  }
  const specNumber = String(spec.latest.specNumber);
  return [
    heldFindingsLine(spec.latest.specNumber, findings.length),
    ...findings.flatMap((finding, index) =>
      block(
        `SPEC-${specNumber}-HELD-FINDING-${String(index + 1)}`,
        nonce,
        [`Title: ${finding.title}`, `Question: ${finding.question}`].join("\n"),
      ),
    ),
  ];
}

function renderSpec(spec: HatchSpec, nonce: string): string[] {
  const { latest } = spec;
  return [
    specStateLine(spec),
    ...block(
      `SPEC-${String(latest.specNumber)}-REVISION-${String(latest.revision)}`,
      nonce,
      JSON.stringify(latest.content, null, 2),
    ),
    ...renderHeldFindings(spec, nonce),
    "",
  ];
}

/**
 * The planning agent's prompt for replying to one message through the escape hatch (spec D2, D5).
 * The idea, every record and every message sit in blocks under one fresh nonce per call (L63); plain
 * lines carry what the e2e stand-in keys on: `Message from the person:`, the stage and spec on screen, each
 * waypoint's status, the fog positions, each spec's state and whether a previous attempt was refused.
 * The lengths are the run's model's (`limits`).
 */
export function buildHatchPrompt(request: ReplyThroughHatchRequest, limits: ModelLimits): string {
  const nonce = randomUUID();
  const { message } = request;
  const waypoints =
    request.waypoints.length === 0
      ? ["The map has no waypoints yet."]
      : request.waypoints.flatMap((waypoint) => renderWaypoint(waypoint, nonce));
  const fog =
    request.fog.length === 0
      ? ["The map has no fog."]
      : request.fog.flatMap((item) => [
          `Fog item at position ${String(item.position)}:`,
          ...block(`FOG-${String(item.position)}`, nonce, item.text),
        ]);
  const outOfScope =
    request.outOfScope.length === 0
      ? ["Nothing is ruled out of scope yet."]
      : request.outOfScope.flatMap((line, index) => [
          `Out of scope line at position ${String(index + 1)}:`,
          ...block(`OUT-OF-SCOPE-${String(index + 1)}`, nonce, line),
        ]);
  const specs =
    request.specs.length === 0
      ? ["The map has no specs yet."]
      : request.specs.flatMap((spec) => renderSpec(spec, nonce));
  const earlier =
    request.earlierMessages.length === 0
      ? ["No earlier messages on this map."]
      : request.earlierMessages.flatMap((earlierMessage, index) => {
          const number = String(index + 1);
          return [
            `Earlier message ${number}, ${sentFrom(earlierMessage.stage, earlierMessage.specNumber)}:`,
            ...block(`EARLIER-MESSAGE-${number}`, nonce, earlierMessage.text),
            `Your reply to it:`,
            ...block(`EARLIER-REPLY-${number}`, nonce, earlierMessage.reply),
            "",
          ];
        });
  return [
    ...preamble(request.projectName, request.baseBranch),
    "",
    "The person wrote to you through the escape hatch below the map's activity log: for anything the stages",
    "don't offer. You reply to their message in the stream and make at most one change to the map's records.",
    "Read the records below and the repository as you need to answer from them.",
    "",
    "The person's idea for the map:",
    ...block("IDEA", nonce, request.idea),
    "",
    ...(request.title === null
      ? ["The map is not charted yet: it has no title."]
      : ["The map's title:", ...block("TITLE", nonce, request.title)]),
    "",
    ...(request.destination === null
      ? ["The map has no destination yet."]
      : ["The map's destination:", ...block("DESTINATION", nonce, request.destination)]),
    "",
    ...mapRoundLines(request.mapRounds, nonce),
    ...renderCodeSurvey(request.survey, nonce),
    "The map's waypoints, by number:",
    ...waypoints,
    "",
    fogPositionsLine(request.fog.map((item) => item.position)),
    "The map's fog (Not yet specified): in-scope uncertainty not yet sharp enough to be a waypoint.",
    ...fog,
    "",
    "The map's Out of scope lines:",
    ...outOfScope,
    "",
    ...projectSuggestionLines(request, nonce),
    "The map's specs, each with its latest revision, its current ticket set and what runs on it:",
    ...specs,
    approvedSpecsLine(request.specs),
    "",
    "The specs this map waits on to change, each with its note:",
    ...openWaitLines(request.waits, nonce),
    earlierMessagesLine(request.earlierMessages.length),
    "The map's earlier messages and your replies, oldest first:",
    ...earlier,
    "",
    stageOnScreenLine(message.stage),
    specOnScreenLine(message.specNumber),
    MESSAGE_LINE,
    ...block("MESSAGE", nonce, message.text),
    "",
    refusedAttemptLine(request.refusedAttempt !== null),
    ...(request.refusedAttempt === null
      ? []
      : [
          "Your previous attempt at this reply was refused for this problem; correct it:",
          ...block("REFUSED", nonce, request.refusedAttempt.problem),
        ]),
    "",
    ...HATCH_JUDGMENT_RULES,
    "",
    ...changeRules(limits),
    "",
    ...READER_ADDRESS_RULE,
    "",
    "Your output:",
    `- reply: your answer to the person, plain and short, ${lengthWords(limits.hatchReply)}. Answer from the`,
    "  records and the repository; when you make a change, say what you changed; when you make none and one",
    "  could follow, say what to send.",
    "- change: the one change, or null.",
    "",
  ].join("\n");
}
