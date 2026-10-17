import { randomUUID } from "node:crypto";

import {
  fogSettlementOutcome,
  MAP_PROPOSALS_MAX_COUNT,
  type ModelLimits,
  type PlanningRunConfig,
  type SettleFog,
  type SettleFogRequest,
} from "@zenorm/contracts";

import { READ_ONLY_TOOLS, runStructured, structuredOutput } from "./claude.ts";
import {
  block,
  BUSY_READER_RULE,
  DECISION_PROSE_RULE,
  lengthWords,
  mapRoundLines,
  preamble,
  renderCodeSurvey,
  WAYPOINT_QUESTION_RULE,
} from "./prompt-parts.ts";
import {
  FOG_HOLDS_RULE,
  PROPOSAL_IDEA_RULE,
  PROPOSE_OR_RULE_OUT_RULE,
  mapTitleRule,
  projectSuggestionLines,
  SALIENCE_GATE,
} from "./wayfinding-prompt.ts";
import { decidedByLine } from "./waypoint-run-prompt.ts";

/**
 * The `--json-schema` of a fog run; root properties `fogSettledBy, fogDecided, fogOutOfScope,
 * fogForPerson, fogProposed`.
 */
export function fogJsonSchema(limits: ModelLimits): string {
  return structuredOutput(fogSettlementOutcome(limits)).jsonSchema;
}

/** The plain line carrying how many fog items the run settles; the e2e stand-in keys on it. */
export function fogCountLine(count: number): string {
  return `Fog items to settle: ${String(count)}`;
}

/**
 * The prompt of a map's fog run (harness change #4): the map, its code survey, every resolved
 * waypoint with who stands behind it, and its fog, each item to be settled exactly once. Every text
 * the person or an earlier run wrote sits in a block under one fresh nonce per call (L63). The
 * lengths are the run's model's (`limits`).
 */
export function buildFogPrompt(request: SettleFogRequest, limits: ModelLimits): string {
  const nonce = randomUUID();
  const waypoints =
    request.waypoints.length === 0
      ? ["No waypoint is resolved.", ""]
      : request.waypoints.flatMap((waypoint) => [
          `Resolved waypoint ${String(waypoint.number)}:`,
          ...block(
            `WAYPOINT-${String(waypoint.number)}`,
            nonce,
            [
              `Kind: ${waypoint.kind}`,
              `Title: ${waypoint.title}`,
              `Question: ${waypoint.question}`,
              decidedByLine(waypoint.decidedByPerson),
              "Resolution:",
              waypoint.resolution,
            ].join("\n"),
          ),
          "",
        ]);
  const fog = request.fog.flatMap((item) => [
    `Fog item at position ${String(item.position)}:`,
    ...block(`FOG-${String(item.position)}`, nonce, item.text),
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
    ...mapRoundLines(request.mapRounds, nonce),
    "The map's Out of scope lines:",
    ...outOfScope,
    ...projectSuggestionLines(request, nonce),
    ...renderCodeSurvey(request.survey, nonce),
    "Every waypoint of this map is resolved or out of scope, and fog remains: in-scope uncertainty",
    "noted while the waypoints were worked. You are running the map's fog run: settle every fog item.",
    "",
    "The resolved waypoints, by number:",
    ...waypoints,
    fogCountLine(request.fog.length),
    "",
    ...fog,
    "Your task: settle each fog item exactly once, by position, in one of five lists:",
    "- fogSettledBy: a resolution above already settles it; name that waypoint's number.",
    "- fogDecided: it needs no answer from the person (implementation mechanics, proof, or a choice",
    `  the project's rules settle): decide it, with a short title (${lengthWords(limits.waypointTitle)}), the resolution`,
    `  (your decision and what it rests on, ${lengthWords(limits.resolution)}) and a gist (${lengthWords(limits.gist)}).`,
    ...DECISION_PROSE_RULE,
    "  It is saved as a resolved waypoint, which the page shows as decided by you without asking.",
    "- fogOutOfScope: it falls outside the destination; give the Out of scope line that says why",
    `  (${lengthWords(limits.mapLine)}).`,
    "- fogForPerson: only the person can settle it, because its answer passes the salience gate below",
    "  and neither the resolutions, the destination nor the project's rules settle it. Give a short",
    `  title (${lengthWords(limits.waypointTitle)}) and the question to ask (${lengthWords(limits.waypointQuestion)}); it opens`,
    "  as a Grilling waypoint that asks the person. Most fog needs no person.",
    ...WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`),
    "- fogProposed: it falls outside the destination and is concrete work worth doing on its own:",
    "  propose it as a new map, with its title, its idea and its Out of scope line",
    `  (${lengthWords(limits.mapLine)}). It leaves the fog, and its line is saved once the person decides`,
    `  the proposal. At most ${String(MAP_PROPOSALS_MAX_COUNT)}. fogProposed is required: send an empty list`,
    "  when there is none.",
    "",
    ...PROPOSE_OR_RULE_OUT_RULE,
    ...mapTitleRule(limits),
    ...PROPOSAL_IDEA_RULE,
    "",
    ...FOG_HOLDS_RULE,
    "",
    ...SALIENCE_GATE,
    "",
    ...BUSY_READER_RULE,
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}

/**
 * The planning agent's fog run (harness change #4) through the Claude Code CLI at
 * `config.claudePath`: it may read the repository and changes nothing, under the configured turns
 * and timeout.
 */
export function claudeCodeSettleFog(config: PlanningRunConfig): SettleFog {
  const output = structuredOutput(fogSettlementOutcome(config.limits));
  return (request, session) =>
    runStructured(
      config,
      session,
      request.projectFolder,
      buildFogPrompt(request, config.limits),
      output,
      READ_ONLY_TOOLS,
    );
}
