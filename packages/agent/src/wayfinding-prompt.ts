import { randomUUID } from "node:crypto";

import {
  CHART_MAP_LINES_MAX_COUNT,
  CHART_SPLIT_MAX_COUNT,
  type ChartMapRequest,
  chartStep,
  DESTINATION_FOLLOW_UP_QUESTIONS_MAX_COUNT,
  DESTINATION_ROUNDS_MAX_COUNT,
  type FogItem,
  type GrillWaypointRequest,
  type MapProposalState,
  type ModelLimits,
  type ProjectMapContext,
  type ProjectProposalContext,
  type RunTouch,
  MAP_CHANGES_NEW_FOG_MAX_COUNT,
  MAP_CHANGES_NEW_WAYPOINTS_MAX_COUNT,
  MAP_IDEA_MAX_LENGTH,
  MAP_PROPOSALS_MAX_COUNT,
  WAYPOINT_AGENT_DECIDED_MAX_COUNT,
} from "@zenorm/contracts";

import {
  AGENT_ALONE_DECIDED_RULE,
  agentDecidedLines,
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
import { projectSpecLines, touchLines } from "./revision-prompt-parts.ts";

/** The plain line opening the person's note about a waypoint (S7b-10); the e2e stand-in keys on it. */
export function waypointNoteLine(sentAt: string): string {
  return `Note from the person: sent ${sentAt}`;
}

/**
 * The person's note about the waypoint a run works (S7b-10), rendered as an escalated finding is
 * (L136 (a)); nothing when there is none.
 */
export function waypointNoteLines(note: GrillWaypointRequest["note"], nonce: string): string[] {
  return note === null
    ? []
    : [
        waypointNoteLine(note.sentAt),
        "The person sent this note about this waypoint through the escape hatch:",
        ...block("NOTE", nonce, note.text),
        "It is the person's direction about this waypoint and their most recent word: follow it, and",
        "where it differs from an earlier answer or resolution, the note wins.",
        "",
      ];
}

/** The plain line saying whether the waypoint was resolved and then reopened (L156 (1)). */
export function reopenedLine(reopened: boolean): string {
  return `Reopened after a resolution: ${reopened ? "yes" : "no"}`;
}

/**
 * The rule for a reopened waypoint with no round asked since the reopen (S7b-7, L156 (1)): its
 * earlier decision no longer stands, so the run asks a new round rather than re-settling it.
 */
export const REOPENED_ASK_RULE = [
  "This waypoint was resolved, and the person reopened it: its earlier decision no longer stands, and",
  "the rounds answered before the reopen are superseded. No round has been asked since the reopen, so",
  "ask a new round now: set kind round. Do not resolve it again from the superseded",
  "rounds, the earlier decision or the note alone; ZeNorm refuses a resolution with no round asked since",
  "the reopen. Ask what the note and the reopen leave open, building on the note where it gives",
  "direction. Rule it out of scope only when the note says the decision is no longer needed.",
];

/**
 * The rule for a waypoint a planning review routed to the person (`personDecides`) with no answered
 * round: core refuses a resolution or out-of-scope ruling before the person answers one.
 */
export const PERSON_DECIDES_RULE =
  "The planning review left this decision to the person: ask at least one round before resolving it or ruling it out of scope; never settle it yourself, whatever the salience gate says.";

/** The plain line carrying the waypoint's number; the e2e stand-in keys on it. */
export function waypointNumberLine(number: number): string {
  return `Waypoint number: ${String(number)}`;
}

/** The plain line carrying how many rounds on the waypoint are answered; the e2e stand-in keys on it. */
export function answeredRoundsLine(count: number): string {
  return `Answered rounds on this waypoint: ${String(count)}`;
}

/**
 * How a change is proven (`skills/wayfinder`): the repository's convention, never a question about
 * test method; a guarantee is asked only when salient, as what must hold.
 */
export const PROOF_RULE = [
  "How the change is tested or proven follows the repository's conventions and is yours to decide:",
  "never ask it in the destination round, and never offer test methods as an either/or. Ask about a",
  'guarantee only when it passes this gate, as what must hold in plain language ("Should a failed run',
  'leave the branch untouched?"), never about how it is tested.',
];

/**
 * How a chart links another map's spec it names in the map's summary or destination: by its title,
 * to the page its prompt gives, which the Idea and Wayfinding pages open.
 */
export const SPEC_LINK_RULE = [
  "When the summary or destination names one of the project's specs listed above, write its title as a",
  "markdown link to its page, the path its `page:` line gives: [the spec's title](that path).",
  "Link nowhere else, and link no other page.",
];

/**
 * How a first chart reads the idea (`skills/wayfinder`): in the project's own vocabulary and
 * structure, at the unit the project itself treats as the thing named.
 */
export const PROJECT_READING_RULE = [
  "Read the idea in the project's own vocabulary and structure: its glossary (CONTEXT.md or the like)",
  "and how the code groups the thing the idea names. Propose, and recommend, the reading a user of this",
  "project most plausibly means: neither wider nor narrower than the unit the project itself treats as",
  "that thing. When a word in the idea maps to a group in the project (a family of sessions, a pipeline",
  "stage, a module), the recommended option covers the whole group; offer narrower and wider readings as",
  "alternatives, never as the recommendation. State the destination in the idea's terms and the",
  "project's.",
];

/**
 * What a confirming chart never charts (`skills/wayfinder`): a question the confirmed destination or
 * the map-level answers already settle.
 */
export const SETTLED_CHART_RULE = [
  "Chart no waypoint, and ask no question, whose answer the confirmed destination or the map-level",
  "answers already settle. Check each waypoint against them before charting it; what they settle is",
  "settled, not a choice to reopen.",
];

/**
 * What a recommendation may do (`skills/grilling`, `skills/wayfinder`): follow the project's rules,
 * keep the destination achievable, never re-ask what is settled.
 */
export const RECOMMENDATION_RULE = [
  "- The recommended option complies with the rules the project's instruction files state (AGENTS.md,",
  "  CLAUDE.md and the like). A choice such a rule settles is no question (with silent defaults ruled",
  "  out, old configs missing a new key fail with a coded error): decide it per the rule and cite the rule",
  "  where you state the decision. In a question open for other reasons, an option that breaks a rule may",
  "  be offered only if its detail names the rule it breaks, and is never the recommendation.",
  "- The recommended option keeps the destination (in the destination round, the idea) achievable. An",
  "  option that makes the requested capability unusable (refusing or blocking it) may be offered with its",
  "  cost stated, but is never the recommendation unless the risk is severe and named concretely (data",
  "  loss, credential exposure, an irreversible remote action); then its detail says so.",
  "- Frame a guardrail or safety question as a trade-off with a workable mitigation as the",
  '  recommendation, not as "same limits or refuse".',
  "- Never ask what the destination, a map-level answer or another resolution already settles.",
];

/**
 * The salience gate (`skills/grilling`, `skills/wayfinder`): what the person is asked, and what the
 * agent decides itself. Every rule that can put a question to the person or chart a Grilling
 * waypoint carries it.
 */
export const SALIENCE_GATE = [
  "The salience gate. A question goes to the person only when its answer changes one of these:",
  "- scope: what the effort delivers or leaves out;",
  "- behaviour the person or their users can observe;",
  "- cost: time, money or effort the person would weigh;",
  "- risk or irreversibility: a rewrite, a major migration, data loss, or a breaking change to",
  "  configuration or stored data people rely on.",
  "Implementation mechanics are yours to decide from the repository and research, never the person's:",
  "where a configuration key lives, internal API and record shapes, how errors map to codes, parser",
  "details, command-line flags, test seams. Decide them and state each as an assumption. Likewise",
  "decide any choice a rule in the project's instruction files settles, per that rule, citing the rule;",
  "never ask it. A general rule the person stated in an answer settles every case it covers the same",
  "way: decide each, and say the decision is derived from that answer.",
  "Ask about observable behavior and meaningful tradeoffs; derive routine record structures and mechanics",
  "from those answers.",
  "Ask about an assumption only if it changes scope or creates a prerequisite; otherwise leave",
  "implementation flexibility in the answer.",
  "A decision that removes or weakens an existing safety guarantee, permission boundary or enforced",
  "guardrail, or accepts a new security risk, always passes the gate: ask, stating what is lost.",
  "Never decide one alone. Nor decide alone a refusal or block on the ordinary path of the capability",
  "the destination asks for (the main way a user uses it): that always passes the gate. A refusal in an",
  "edge state off that path is yours: decide it and state it as an assumption.",
  "A decision that adds required setup, configuration or steps for users who do not use the new",
  "capability is a cost to everyone and passes the gate: choose the option that adds no burden to them",
  "when the project's rules allow it, otherwise ask.",
  ...INSTANCE_CONFIG_RULE,
  ...PROOF_RULE,
];

/** What fog may hold: never implementation mechanics or proof, which the agent settles itself. */
export const FOG_HOLDS_RULE = [
  "Fog holds only uncertainty that could need the person or change scope or observable behaviour.",
  "Implementation mechanics never go into fog: settle them in the output you are writing, or leave them",
  "to the spec and tickets. How the change is tested or proven (test coverage, stand-in or live tests)",
  "is decided from the repository's conventions: never fog and never a waypoint.",
];

/** What research may chart: a fact sources can answer, never one only running something can. */
export const RESEARCH_KIND_RULE = [
  "Research is only for a fact that documentation, source code or the repository can answer. A fact",
  "that only running something can settle (a live experiment or spike) is not a waypoint: fold it into",
  "the decision that needs it as an assumption and a risk, verified during delivery (the live test, an",
  "early spike ticket).",
];

/** How a run that asks no round changes the map (spec D3). */
export function mapChangesRules(limits: ModelLimits): string[] {
  return [
    "Map changes. Besides your outcome, set mapChanges; leave each list empty when nothing changes:",
    `- newWaypoints (0 to ${String(MAP_CHANGES_NEW_WAYPOINTS_MAX_COUNT)}): a question your work made precise that the destination needs`,
    `  settled and no waypoint asks yet. Each has a kind, a short title (${lengthWords(limits.waypointTitle)}), the question it`,
    `  settles (${lengthWords(limits.waypointQuestion)}), blockedBy`,
    "  (numbers of existing waypoints listed above whose answer would change its options; an empty list when",
    "  none) and fromFog (the position of the fog item it graduates, or null). kind is research only for a",
    "  named unknown fact that could change a decision and that sources can answer, never one only running",
    "  something can settle (fold that into your decision as an assumption and a risk); task only for",
    "  mechanical work a decision needs,",
    "  grilling only for a decision the person must make because its answer changes scope, behaviour the",
    "  person can observe, cost, or risk (a rewrite, a major migration, data loss, a breaking change).",
    "  Ordinary implementation choices are not waypoints: decide them in your own work. Most runs chart no",
    "  new waypoint.",
    ...WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`),
    "- fogSettledHere: positions of fog items your own resolution, answered report or done task already",
    "  settles. Say the decision in that resolution; no waypoint is created. Only when your outcome resolves",
    "  this waypoint.",
    "- fogDecided and fogOutOfScope: leave empty. Fog your own work does not settle stays: once every",
    "  waypoint is settled, the map's fog run settles it.",
    `- newFog (0 to ${String(MAP_CHANGES_NEW_FOG_MAX_COUNT)}, each ${lengthWords(limits.mapLine)}): in-scope uncertainty your work`,
    "  uncovered that is not yet sharp enough to ask. Settled decisions and existing waypoints never belong in fog.",
    ...FOG_HOLDS_RULE.map((line) => `  ${line}`),
    "- Use each fog position at most once.",
  ];
}

/** How `projectSuggestionLines` opens its heading of the project's map suggestions. */
export const PROJECT_SUGGESTIONS_HEADING = "Every map suggestion made in this project so far";

/** How `projectSuggestionLines` opens its heading of the project's maps. */
export const PROJECT_MAPS_HEADING = "Every map of this project, this one included";

/**
 * The no-repeat, no-existing-map rule (map suggestions that don't repeat): a listed suggestion is
 * never suggested again in any words, whatever its state; work already a map at any stage is never
 * suggested.
 */
export const NO_REPEAT_SUGGESTION_RULE = [
  `Never suggest again any map suggestion listed above under "${PROJECT_SUGGESTIONS_HEADING}",`,
  "even reworded, retitled or narrowed: the same work in new words is a repeat. A dismissed one means",
  "the person said no to it; a created one is its own map now. A pending one waits on the person.",
  `Never suggest work that is already a map of this project, listed above under "${PROJECT_MAPS_HEADING}",`,
  "at any stage, from idea to delivery: that map owns it.",
];

/**
 * The salient-only rule (map suggestions that don't repeat): only salient, high-signal, clearly
 * worded maps are suggested, few and distinct.
 */
export const SALIENT_SUGGESTION_RULE = [
  "Suggest a map only for salient, high-signal work: an outcome the person would plainly want planned",
  "on its own, named in a clear title and idea. Suggestions are few and distinct; none is better than a",
  "weak one.",
];

/**
 * Waypoint 6's propose-or-rule-out rule (map proposals), shared by every Wayfinding run: work
 * outside the destination never widens it; salient outside work no suggestion or map in the project
 * covers yet is suggested as a new map, the rest ruled out with a plain Out of scope line.
 */
export const PROPOSE_OR_RULE_OUT_RULE = [
  "Work outside the destination never widens this map's destination. When you find outside work that",
  "is concrete and worth doing on its own, propose it as a new map; rule the rest out with a plain Out",
  "of scope line.",
  ...NO_REPEAT_SUGGESTION_RULE,
  ...SALIENT_SUGGESTION_RULE,
  "Outside work that is not salient, or that a listed suggestion or map already covers, is never a",
  "suggestion: rule it out with a plain Out of scope line, unless this map's Out of scope lines already",
  "say it.",
];

/**
 * How a map's title is written, by a first chart and by every proposal or split offer: the name the
 * person scans in the list of maps, one line there, never the map's reading.
 */
export function mapTitleRule(limits: ModelLimits): string[] {
  return [
    `A map's title is its name in the list of maps, in a few words (${lengthWords(limits.mapTitle)}): a`,
    "noun phrase naming the outcome, not a sentence. No colon and subtitle, no list of its parts, no",
    "how it is built and no project name; the summary and destination carry the detail. Write",
    "“Stdin and JSON output for wc-lite”, not “wc-lite for scripts: stdin input, --json output and a",
    "total row”.",
  ];
}

/** How a proposal's draft idea is written (map proposals); its bound is the stored idea's. */
export const PROPOSAL_IDEA_RULE = [
  `The draft idea is the new map's idea, 1 to ${String(MAP_IDEA_MAX_LENGTH)} characters: what to build and`,
  "why, written as the person would write a new map's idea, standing on its own without this map. Its",
  "chart sees only the idea. Never propose work this map's destination covers.",
];

/**
 * The proposals list of a chart, fog run or consistency pass (map proposals): each a draft idea and
 * its own Out of scope line, which is saved when the person decides the proposal.
 */
export function proposalsRules(limits: ModelLimits): string[] {
  return [
    `proposals (0 to ${String(MAP_PROPOSALS_MAX_COUNT)}): each proposes a new map for outside work, with title, idea and line.`,
    ...PROPOSE_OR_RULE_OUT_RULE,
    ...mapTitleRule(limits),
    ...PROPOSAL_IDEA_RULE,
    `Its line (${lengthWords(limits.mapLine)}) is the Out of scope line saying what this map leaves to it;`,
    "do not repeat it among the Out of scope lines. proposals is required: send an empty list when",
    "there is none.",
  ];
}

/** The out-of-scope ruling's rule, shared by every waypoint run (S6b-5), with its proposal. */
export function outOfScopeRule(limits: ModelLimits): string[] {
  return [
    `If this waypoint's question falls outside the destination, set outOfScope with the reason (${lengthWords(limits.mapLine)})`,
    "instead of working it; the reason becomes the map's Out of scope line for this waypoint.",
    ...PROPOSE_OR_RULE_OUT_RULE,
    "To propose the ruled-out work as a new map, set outOfScope.proposal with its title and idea: the",
    "reason is its line. Leave proposal out for a plain ruling.",
    ...mapTitleRule(limits),
    ...PROPOSAL_IDEA_RULE,
  ];
}

/** How a map suggestion's state reads to a run: `confirmed` reads as created, a map of its own now. */
const PROPOSAL_STATE_WORDS: Record<MapProposalState, string> = {
  pending: "pending (the person has not decided it yet)",
  dismissed: "dismissed (the person said no)",
  confirmed: "created (it is a map of its own now)",
};

/** The plain line opening one map suggestion of the project, with its state. */
function projectProposalLine(number: number, state: MapProposalState): string {
  return `Suggestion ${String(number)}, ${PROPOSAL_STATE_WORDS[state]}:`;
}

/** The plain line naming one map of the project with its stage; an uncharted one reads as untitled. */
function projectMapLine(number: number, map: ProjectMapContext): string {
  return map.title === null
    ? `Map ${String(number)}, untitled (not charted yet), stage ${map.stage}.`
    : `Map ${String(number)}, stage ${map.stage}, titled:`;
}

/**
 * The project's map suggestions and maps, as every run that can suggest maps reads them (the chart,
 * fog run, consistency pass, hatch, and grilling, research and task runs): each suggestion, oldest
 * first, with its state, its title and its line (when it has one of its own) in nonce blocks; then
 * each map of the project, this one included, with its title in a nonce block (untitled before its
 * first chart) and the latest stage it has reached. Nothing else about other maps is given.
 */
export function projectSuggestionLines(
  request: {
    readonly projectProposals: readonly ProjectProposalContext[];
    readonly projectMaps: readonly ProjectMapContext[];
  },
  nonce: string,
): string[] {
  const proposals =
    request.projectProposals.length === 0
      ? ["No map has been suggested in this project yet.", ""]
      : request.projectProposals.flatMap((proposal, index) => {
          const name = `SUGGESTION-${String(index + 1)}`;
          return [
            projectProposalLine(index + 1, proposal.state),
            ...block(`${name}-TITLE`, nonce, proposal.title),
            ...(proposal.line === null
              ? []
              : ["Its Out of scope line:", ...block(`${name}-LINE`, nonce, proposal.line)]),
            "",
          ];
        });
  const maps =
    request.projectMaps.length === 0
      ? ["The project has no map yet.", ""]
      : request.projectMaps.flatMap((map, index) => [
          projectMapLine(index + 1, map),
          ...(map.title === null ? [] : block(`MAP-${String(index + 1)}-TITLE`, nonce, map.title)),
          "",
        ]);
  return [
    `${PROJECT_SUGGESTIONS_HEADING}, on any of its maps, oldest first:`,
    "",
    ...proposals,
    `${PROJECT_MAPS_HEADING}, oldest first, with the latest of its stages (idea,`,
    "wayfinding, spec, tickets, delivery) it has reached:",
    "",
    ...maps,
  ];
}

/** One other waypoint as a waypoint-run prompt reads it. */
interface OtherWaypoint {
  readonly number: number;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly gist: string | null;
  readonly agentDecided: readonly string[] | null;
  readonly resolution: string | null;
}

/** The map's other waypoints by number, each in its own nonce block. */
export function renderOtherWaypoints(
  otherWaypoints: readonly OtherWaypoint[],
  nonce: string,
): string[] {
  return otherWaypoints.length === 0
    ? ["The map has no other waypoints.", ""]
    : otherWaypoints.flatMap((other) => {
        const text = [
          `Number: ${String(other.number)}`,
          `Kind: ${other.kind}`,
          `Title: ${other.title}`,
          `Status: ${other.status}`,
          ...(other.gist === null ? [] : [`Gist: ${other.gist}`]),
          ...(other.agentDecided === null ? [] : agentDecidedLines(other.agentDecided)),
          ...(other.resolution === null ? [] : ["Resolution:", other.resolution]),
        ].join("\n");
        return [...block(`WAYPOINT-${String(other.number)}`, nonce, text), ""];
      });
}

/** The map's fog by position and its Out of scope lines, each person-written text in a nonce block. */
export function fogAndOutOfScope(
  request: {
    readonly fog: readonly FogItem[];
    readonly outOfScope: readonly string[];
  },
  nonce: string,
): string[] {
  const fog =
    request.fog.length === 0
      ? ["The map has no fog.", ""]
      : request.fog.flatMap((item) => [
          `Fog item at position ${String(item.position)}:`,
          ...block(`FOG-${String(item.position)}`, nonce, item.text),
          "",
        ]);
  const outOfScope =
    request.outOfScope.length === 0
      ? ["Nothing is ruled out of scope yet.", ""]
      : request.outOfScope.flatMap((line, index) => [
          ...block(`OUT-OF-SCOPE-${String(index + 1)}`, nonce, line),
          "",
        ]);
  return [
    "The map's fog (Not yet specified): in-scope uncertainty not yet sharp enough to be a waypoint.",
    ...fog,
    "The map's Out of scope lines:",
    ...outOfScope,
  ];
}

/**
 * Options rest on facts (`skills/grilling`): an option whose feasibility is unverified says so, and
 * is not recommended over a known-feasible one.
 */
export const FEASIBILITY_RULE = [
  "- Check each option's feasibility against the map's research and the repository. An option whose",
  "  feasibility rests on an unverified fact says so in its detail, and is never the recommendation when",
  "  a known-feasible option exists. An option a research finding shows blocked is not offered.",
  "- Every premise in a question and every option agrees with the map's research and resolutions shown",
  "  above: cite the waypoint a premise rests on, and never state an absence or limit they contradict.",
];

/** The round-asking rules both prompts share: the shape of a question and its options. */
/** The plain line opening the text of a revision a waypoint touches (L213 D-7). */
export function touchedTextLine(touch: RunTouch): string {
  return `Touched spec ${String(touch.specNumber)} revision ${String(touch.revision)}, its approved text:`;
}

/**
 * A waypoint's touches as its runs read them (slice 8b D6): the specs it changes, the touched
 * criteria and the delivered ticket and commit that built each, so the run reads the delivered code,
 * and each touched revision's approved text, since specs live in ZeNorm, not the repository (L213
 * D-7).
 */
export function touchedSpecLines(touches: readonly RunTouch[], nonce: string): string[] {
  if (touches.length === 0) return [...touchLines(touches, "WAYPOINT", nonce), ""];
  return [
    "This waypoint changes specs other maps wrote. Each touched spec, the touched criteria as its",
    "revision states them, and the delivered ticket, run and commit that built each (or never delivered):",
    ...touchLines(touches, "WAYPOINT", nonce),
    "Read the code those commits delivered before you ask or answer: the decision changes what it does.",
    "",
    ...touches.flatMap((touch) => [
      touchedTextLine(touch),
      ...block(
        `TOUCHED-SPEC-${String(touch.specNumber)}-REVISION-${String(touch.revision)}`,
        nonce,
        JSON.stringify(touch.content, null, 2),
      ),
    ]),
    "The spec text is here, not in the repository: read it from these blocks, never ask the person for it.",
    "",
  ];
}

/**
 * The chart's touch rules (slice 8b S8b-2, L202 (1)): a waypoint names the project specs it changes,
 * only at charting.
 */
export const TOUCHES_RULES = [
  "- touches: when a waypoint decides a change to a spec listed above, name it there: { specNumber,",
  '  revision, criteria } with that spec\'s latest approved revision (its "latest approved revision" line)',
  "  and the ids of the criteria of that revision the decision changes or removes (0 to 3 touches per",
  "  waypoint). A spec another map holds is touched all the same, at its latest approved revision, never",
  "  at the held draft. Never touch a spec with no approved revision, or a criterion id that revision does",
  "  not list. A waypoint that changes no listed spec has an empty list. Touches are named only now, when",
  "  the map is charted.",
];

/**
 * How a round's questions and options are shaped, their lengths the run's model's (`agent.models`):
 * every round asks this way, Task rounds included.
 */
export function questionShapeRules(limits: ModelLimits): string[] {
  return [
    `- Each question has a short topic (${lengthWords(limits.questionTopic)}), the question itself (${lengthWords(limits.questionText)}),`,
    "  and 2 to 4 options.",
    `- Each option has a short label (${lengthWords(limits.optionLabel)}) and a detail (${lengthWords(limits.optionDetail)})`,
    "  saying what choosing it gives and what it costs.",
    "- Recommendation first: put the option you recommend first in every question.",
    ...RECOMMENDATION_RULE,
  ];
}

/**
 * The first chart's split rule (idea-phase split): an idea too big for one map keeps one part here
 * and offers the rest as maps of their own, decided by the person before the destination round.
 */
function splitRules(limits: ModelLimits): string[] {
  return [
    "Is this idea one map or several? Split it only when it names separate outcomes that could each be",
    "planned, specified and shipped on their own, and that together are too big for one map. Then keep",
    "the core one in this map and offer each other part as a map of its own in split (0 to",
    `${String(CHART_SPLIT_MAX_COUNT)}). Each has a title, a draft idea, and its line (${lengthWords(limits.mapLine)}): the Out of scope`,
    "line saying what this map leaves to it. The destination, the intro and the questions cover only",
    "what stays in this map. The person creates or dismisses each offer before answering the round; a",
    "dismissed one stays in this map. Never split one coherent piece of work, and never split off how it",
    "is built. split is required: send an empty list when the idea fits one map, as most do.",
    "A split offer is a map suggestion too:",
    ...NO_REPEAT_SUGGESTION_RULE,
    ...SALIENT_SUGGESTION_RULE,
    ...mapTitleRule(limits),
    ...PROPOSAL_IDEA_RULE,
  ];
}

/**
 * The person's decisions on the first chart's split offers, for the confirming chart: what was
 * created as its own map stays out of this one, what was dismissed stays in. Empty with no offer.
 */
function splitDecisionLines(split: ChartMapRequest["split"], nonce: string): string[] {
  if (split.length === 0) {
    return [];
  }
  return [
    "You also offered to split maps off this idea. The person decided each before answering:",
    "",
    ...split.flatMap((offer, index) => {
      const decided =
        offer.state === "confirmed"
          ? "created as its own map: leave its work out of this map. Its Out of scope line is saved already; do not repeat it."
          : offer.state === "dismissed"
            ? "dismissed: its work stays in this map, inside the destination."
            : null;
      if (decided === null) {
        throw new Error(
          `Split offer ${String(index + 1)} is still pending at the confirming chart`,
        );
      }
      return [
        `Split offer ${String(index + 1)}, ${decided}`,
        ...block(`SPLIT-${String(index + 1)}`, nonce, `${offer.title}\n\n${offer.idea}`),
        "",
      ];
    }),
  ];
}

/** The plain line carrying how many destination rounds are answered; the e2e stand-in keys on it. */
export function answeredDestinationRoundsLine(count: number): string {
  return `Answered destination rounds: ${String(count)}`;
}

/**
 * When a chart after an answered round that is not the last asks a follow-up instead of confirming
 * (DR-12, P1, P2, P4): only for what an answer moved, leaning hard towards confirming.
 */
export const DESTINATION_FOLLOW_UP_RULE = [
  "Confirm when the person's words say to wrap up, and otherwise unless an answer changed or left open",
  "what is in scope or what the outcome is. Lean hard towards confirming: a follow-up costs a round.",
  `- A follow-up asks only what moved: one question for each answer that moved the destination (1 to ${String(DESTINATION_FOLLOW_UP_QUESTIONS_MAX_COUNT)}),`,
  "  opening with that answer's own words and asking what they leave open. Ask nothing else, such as a",
  "  safety prompt or an edge case of the change: decide it, or leave it to the waypoints. Never ask how",
  "  the work is built, and never re-ask what an answer settled; an accepted recommendation settles too.",
  "- Set final when you expect the follow-up's answers to settle the destination.",
  `- A map has at most ${String(DESTINATION_ROUNDS_MAX_COUNT)} destination rounds: with k answered, the round you ask now is round k+1 of at most ${String(DESTINATION_ROUNDS_MAX_COUNT)}.`,
  "- A follow-up's intro states the revised destination, so the person reads what they are confirming.",
];

/**
 * What a confirming chart writes (D2): the destination as the answers fix it, the waypoints with
 * their kinds, blockers and touches, the fog, the Out of scope lines and the proposals.
 */
function confirmationRules(limits: ModelLimits): string[] {
  return [
    `Destination first. Write the destination as the submitted answers fix it, in one or two lines (${lengthWords(limits.destination)}).`,
    ...SPEC_LINK_RULE,
    "",
    ...SETTLED_CHART_RULE,
    "",
    "Then chart 0 to 12 waypoints. A waypoint is one bounded question that must be settled before the way",
    "to the destination is clear; the agent works it as soon as nothing blocks it. Each waypoint has a kind:",
    "",
    "- grilling: a decision only the person can make, put to them as question rounds: a preference, a",
    "  priority or a trade-off whose answer changes scope, behaviour the person can observe, cost, or risk",
    "  (the salience gate below).",
    "- research: a named unknown fact that could change a decision and that reading the repository or the",
    "  web answers (what a library, an API, a standard or a platform actually does). The agent researches it",
    "  from primary sources; the person is not asked.",
    ...RESEARCH_KIND_RULE.map((line) => `  ${line}`),
    "- task: mechanical work a decision needs and that the agent can do itself, read-only (listing every",
    "  usage of something across the repository, counting, collecting configuration values). It asks the",
    "  person, with options, only for what only they have (access, credentials, accounts, facts about",
    "  their environment or data); never for engineering work such as an experiment to run.",
    "",
    "Choose the kind by who can settle the question. Never put to the person a fact that reading the",
    "repository or the web settles: chart it as research. Never ask the person to collect or count what is",
    "in the repository: chart it as task. Chart grilling only when the answer is the person's choice and",
    "passes the salience gate. A fact you have already read while charting needs no waypoint; one you have",
    "not read, or that needs the web, is research.",
    "",
    ...SALIENCE_GATE,
    "",
    "Chart few waypoints: a small idea needs none or a handful. A choice of implementation mechanics is",
    "never a Grilling waypoint; the run that writes the spec and tickets settles it from the repository.",
    "",
    "- Keep each waypoint bounded: one decision, or a few closely related choices grouped into one.",
    "  Ordinary implementation choices and verification details come after planning; they are not waypoints.",
    "- Give each waypoint a scope that does not overlap its neighbours. Assign a case that touches several",
    "  waypoints to one of them and name that boundary in the others' questions: every unblocked waypoint is",
    "  asked at the same time, so overlapping scopes reach the person as the same question asked twice.",
    "- Block a waypoint on every waypoint whose answer would change its options. How something is verified",
    "  depends on what it does; how it is presented depends on what it does; edge cases depend on the rule",
    "  that creates them. Blocking only costs latency. Block a grilling waypoint on the research that settles",
    "  whether its options are feasible, so it is never asked before that is known.",
    "- When the destination adds, changes or constrains stored data, chart a waypoint that asks what happens",
    "  to the records that already exist when the change ships, blocked on the waypoint that settles the",
    "  data's shape.",
    "- If the destination needs no decision from the person, chart no waypoints.",
    `- Each waypoint has a short title (${lengthWords(limits.waypointTitle)}) and the question it settles`,
    `  (${lengthWords(limits.waypointQuestion)}), written for a busy reader.`,
    ...WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`),
    "- Waypoints are numbered by position from 1. blockedBy lists the positions of the waypoints that block",
    "  this one; an empty list when none. No waypoint blocks itself and blockers form no cycle.",
    "",
    ...TOUCHES_RULES,
    "",
    `Then the fog (0 to ${String(CHART_MAP_LINES_MAX_COUNT)} lines), each line ${lengthWords(limits.mapLine)}: in-scope uncertainty`,
    "you can name but not yet ask as a precise question. A later waypoint graduates each item into a waypoint, decides it, or moves it out of scope.",
    "Settled decisions and the waypoints you chart never belong in fog.",
    "With no waypoint charted, chart no fog.",
    ...FOG_HOLDS_RULE,
    "",
    `Then the Out of scope lines (0 to ${String(CHART_MAP_LINES_MAX_COUNT)}), each line ${lengthWords(limits.mapLine)}: each names`,
    "what this effort will not do, with its reason, as the submitted answers and the destination rule it out. Leave the list empty when nothing is ruled",
    "out.",
    "",
    `Then the ${proposalsRules(limits).join("\n")}`,
  ];
}

/**
 * The map's title and summary beside its destination at `choose` and `confirm` (DR-5, DR-13, L253):
 * always set, refined by a confirmation as it refines the destination; `followUp` names the
 * follow-up's revision too.
 */
function chartReadingRules(limits: ModelLimits, followUp: boolean): string[] {
  return [
    "title, summary and destination are always set: the map's, as the answers fix them. A confirmation",
    followUp
      ? "may refine the proposed ones; a follow-up revises them, and its destination is the revised one."
      : "may refine the proposed ones.",
    ...mapTitleRule(limits),
    `The summary is your reading of the idea in one to three sentences (${lengthWords(limits.mapSummary)}).`,
  ];
}

/**
 * The planning agent's prompt for charting a map (spec D2), by the chart's step (`chartStep`): at
 * `propose` it proposes the reading and destination and asks the first map-level round; at `choose`
 * it confirms the destination and charts the waypoints, or revises the destination and asks a
 * follow-up round (DR-12); at `confirm` it can only confirm (DR-13). A refused previous attempt's
 * problem is rendered at every step (DR-8, L253). The idea and every earlier text sit in blocks under
 * one fresh nonce per call (L63); the rules are `skills/wayfinder`'s, written here.
 */
export function buildChartPrompt(request: ChartMapRequest, limits: ModelLimits): string {
  const step = chartStep(request.mapRounds);
  const nonce = randomUUID();
  const head = [
    ...preamble(request.projectName, request.baseBranch),
    "",
    "The person's idea for the map:",
    ...block("IDEA", nonce, request.idea),
    "",
    "The project's specs that other maps wrote, each with its latest revision:",
    ...projectSpecLines(request.projectSpecs, nonce),
    ...projectSuggestionLines(request, nonce),
  ];
  const refused =
    request.refusedAttempt === null
      ? []
      : [
          "Your previous attempt at this chart was refused for this problem; correct it:",
          ...block("REFUSED", nonce, request.refusedAttempt.problem),
          "",
        ];
  const tail = [
    ...BUSY_READER_RULE,
    "",
    "Answer only through the structured output. Write nothing else.",
  ];
  if (step === "propose") {
    return [
      ...head,
      ...refused,
      "Your task: chart this new map. Read the repository first, so that you only ask what the repository",
      "cannot answer.",
      "",
      "Destination first. Before any waypoint, the map needs its destination: the outcome this effort must",
      "reach, in one or two lines, which fixes what is in and out of its scope. Propose it, and ask one",
      "question round whose answers confirm or correct it.",
      "",
      ...splitRules(limits),
      "",
      ...PROJECT_READING_RULE,
      "",
      "- A title for the map, its name as the title rule above sets out, and a summary of one to three",
      `  sentences (${lengthWords(limits.mapSummary)}): your reading of the idea.`,
      `- The proposed destination, in one or two lines (${lengthWords(limits.destination)}).`,
      ...SPEC_LINK_RULE.map((line) => `  ${line}`),
      "- intro: one or two sentences that state the proposed destination, so the person",
      `  reads what they are confirming; ${lengthWords(limits.roundIntro)}.`,
      "- questions: 1 to 5 whose answers fix the destination: scope, what is in and out, and the outcome.",
      "  Fewer is better: ask only what the idea and the repository leave open.",
      ...questionShapeRules(limits),
      "- Ask no question about how the work is built: the ones that pass the salience gate below become",
      "  waypoints once the destination is confirmed, and the rest are yours to decide.",
      "",
      ...SALIENCE_GATE,
      "",
      ...tail,
    ].join("\n");
  }
  const proposed = request.proposed;
  if (proposed === null) {
    throw new Error("A chart after a map-level round carries no proposed destination");
  }
  const answered = [
    ...head,
    "You proposed a reading and a destination for this map and asked the person one or more question",
    "rounds about it. The map's title, summary and proposed destination, as the last round asked them:",
    ...block("TITLE", nonce, proposed.title),
    ...block("SUMMARY", nonce, proposed.summary),
    ...block("DESTINATION", nonce, proposed.destination),
    "",
    ...mapRoundLines(request.mapRounds, nonce),
    ...splitDecisionLines(request.split, nonce),
    answeredDestinationRoundsLine(request.mapRounds.length),
    "",
  ];
  if (step === "confirm") {
    return [
      ...answered,
      ...refused,
      "Your task: confirm the destination and chart the map's waypoints. No further round can be asked",
      "on the destination: confirm it from the answers above. Read the repository first.",
      "",
      ...chartReadingRules(limits, false),
      "",
      ...confirmationRules(limits),
      "",
      ...tail,
    ].join("\n");
  }
  return [
    ...answered,
    ...refused,
    "Your task: either confirm the destination and chart the map's waypoints, or, when an answer moved",
    "the destination, revise it and ask the person a short follow-up round on it. Read the repository",
    "first.",
    "",
    ...DESTINATION_FOLLOW_UP_RULE,
    "",
    "kind names your choice.",
    ...chartReadingRules(limits, true),
    "",
    "- confirmation: set waypoints, fog, outOfScope and proposals as below, and set intro, final and",
    "  questions to null.",
    "- followUp: set intro, final and questions, and set waypoints, fog, outOfScope and proposals to null.",
    `  The revised destination is one or two lines (${lengthWords(limits.destination)}); the intro is one or two`,
    `  sentences that state it (${lengthWords(limits.roundIntro)}).`,
    ...questionShapeRules(limits).map((line) => `  ${line}`),
    "",
    "For a confirmation:",
    "",
    ...confirmationRules(limits),
    "",
    ...tail,
  ].join("\n");
}

/**
 * The planning agent's prompt for grilling one waypoint (spec D2): ask its next round or resolve it,
 * or, after a `final` round (`afterFinal`), only resolve it. The idea and every earlier text sit in
 * blocks under one fresh nonce per call (L63); the rules are `skills/grilling`'s, written here. Two
 * plain lines carry the waypoint's number and its answered round count.
 */
export function buildGrillPrompt(request: GrillWaypointRequest, limits: ModelLimits): string {
  const nonce = randomUUID();
  const { waypoint } = request;
  const answered = waypoint.rounds.flatMap((round, index) => {
    const number = String(index + 1);
    return [
      `Round ${number}${round.final ? " (asked as final)" : ""}:`,
      "",
      ...renderRound(`ROUND-${number}`, nonce, round.questions, round.answers),
    ];
  });
  const superseded = waypoint.supersededRounds.flatMap((round, index) => {
    const number = String(index + 1);
    return [
      `Superseded round ${number}${round.final ? " (asked as final)" : ""}:`,
      "",
      ...renderRound(`SUPERSEDED-ROUND-${number}`, nonce, round.questions, round.answers),
    ];
  });
  const mustAsk = waypoint.reopened && waypoint.rounds.length === 0;
  const personMustAnswer = waypoint.personDecides && waypoint.rounds.length === 0;
  const refused =
    request.refusedAttempt === null
      ? []
      : [
          "Your previous attempt at this waypoint was refused for this problem; correct it:",
          ...block("REFUSED", nonce, request.refusedAttempt.problem),
          "",
        ];
  const others = renderOtherWaypoints(request.otherWaypoints, nonce);
  const finding =
    request.finding === null
      ? []
      : [
          "A consistency check over the map's resolved waypoints opened this waypoint. Its finding, and the",
          "resolutions it names:",
          ...block(
            "FINDING",
            nonce,
            [
              `Kind: ${request.finding.kind}`,
              `Explanation: ${request.finding.explanation}`,
              ...request.finding.waypoints.map(
                (named) =>
                  `Waypoint ${String(named.number)} (${named.title}) resolved: ${named.resolution}`,
              ),
            ].join("\n"),
          ),
          "Settle the conflict it names. Ask the person only when the answer passes the salience gate below;",
          "otherwise decide it yourself and resolve. A conflict",
          "over implementation mechanics (configuration shape, which keys apply when, internal structure) is",
          "yours: follow the project's rules and conventions.",
          "",
        ];
  const reviewFindings =
    request.reviewFindings.length === 0
      ? []
      : [
          request.reviewFindings.length === 1
            ? "A planning review found a problem and opened this waypoint for it. Its finding:"
            : `Planning reviews found ${String(request.reviewFindings.length)} findings this waypoint settles, the one that opened it first:`,
          ...request.reviewFindings.flatMap((finding) =>
            block(
              "REVIEW-FINDING",
              nonce,
              [
                `Spec: ${String(finding.spec.number)} (${finding.spec.title})`,
                `Kind: ${finding.kind}`,
                `Explanation: ${finding.explanation}`,
                `Clauses and criteria named: ${
                  finding.elementIds.length === 0 ? "none" : finding.elementIds.join(", ")
                }`,
              ].join("\n"),
            ),
          ),
          ...(waypoint.personDecides
            ? [
                "Settle what it asks with the person. The spec is revised from the decision once the map clears.",
              ]
            : [
                "Settle what it asks. Ask the person only when the answer passes the salience gate below and the",
                "repository's conventions do not settle it; otherwise decide it yourself and resolve with no round.",
                "The spec is revised from the decision once the map clears.",
              ]),
          "",
        ];
  const pending =
    request.otherPendingRounds.length === 0
      ? ["No other round is waiting on the person.", ""]
      : request.otherPendingRounds.flatMap((round, index) => {
          const text = [
            `Waypoint: ${round.waypointTitle}`,
            ...round.questions.map(
              (question, questionIndex) =>
                `${String(questionIndex + 1)}. ${question.topic}: ${question.text}`,
            ),
          ].join("\n");
          return [...block(`PENDING-ROUND-${String(index + 1)}`, nonce, text), ""];
        });
  const resolveRules = [
    "To resolve, set kind resolution with:",
    `- decision: the settled decision in prose, ${lengthWords(limits.resolution)}, covering only this waypoint;`,
    "  do not restate other waypoints' decisions.",
    ...DECISION_PROSE_RULE,
    `- gist: one line for the map's Decisions so far, ${lengthWords(limits.gist)}.`,
    ...(waypoint.rounds.length === 0
      ? AGENT_ALONE_DECIDED_RULE
      : agentDecidedRule(limits.agentDecided, WAYPOINT_AGENT_DECIDED_MAX_COUNT)),
    "",
    ...outOfScopeRule(limits),
    "",
    ...mapChangesRules(limits),
    "",
    ...BUSY_READER_RULE,
  ];
  const selfResolve =
    mustAsk || personMustAnswer
      ? []
      : [
          "Resolve without asking when no open question passes the salience gate: decide every open choice",
          "yourself from the repository and the map, and resolve now with no round. Ask only the questions",
          "that pass the gate, and nothing that a fact or your own judgment of mechanics settles.",
          "",
        ];
  const task = request.afterFinal
    ? [
        "The person has answered this waypoint's final round. ZeNorm could not write the resolution from",
        "their chosen options alone: either they added their own words, or the chosen labels make a line too",
        "long for the map. Do not ask another round: resolve the waypoint from the submitted answers. If",
        "their words leave a question open, settle it with your recommendation and state it in the resolution.",
        "Set kind to resolution or outOfScope and fill that outcome's fields; the other's are null. Always",
        "set mapChanges.",
        "",
        ...SALIENCE_GATE,
        "",
        ...resolveRules,
      ]
    : [
        ...(mustAsk ? [...REOPENED_ASK_RULE, ""] : []),
        ...(personMustAnswer ? [PERSON_DECIDES_RULE, ""] : []),
        "Your task: grill this waypoint. Either ask its next question round, or, when the submitted answers",
        "settle every relevant branch, resolve it, or rule it out of scope. Set kind to round, resolution or",
        "outOfScope and fill that outcome's fields; the others' are null. Set mapChanges exactly when you ask",
        "no round.",
        "Read the repository first: finding facts is your job, never the person's. The person decides what",
        "passes the salience gate; every other choice is yours.",
        "",
        ...SALIENCE_GATE,
        "",
        ...selfResolve,
        "To ask, set kind round with intro, final and questions, and leave mapChanges null. Ask every",
        "question that passes the gate and whose prerequisites are settled now:",
        `- Ask 1 to 5 questions, with a one- or two-sentence intro of ${lengthWords(limits.roundIntro)}.`,
        ...questionShapeRules(limits),
        "- Every option is a real choice a reasonable person could pick for this project. Two real options",
        "  beat three with a straw man.",
        ...FEASIBILITY_RULE,
        "- Options are parallel: labels similar in length and form, with the detail in the option's detail,",
        "  not in the recommended label. Each detail states fairly what the person gets and gives up.",
        "- Questions in the round are independent: no answer to one would change another's options or",
        "  recommendation. A question that depends on another still open waits for a later round.",
        "- Ask only about your own waypoint. The other waypoints and the rounds pending on them, listed above,",
        "  own their questions; never ask what they ask, and respect what their gists settle.",
        "- When a question builds on a submitted answer, quote its label or words exactly.",
        "- Mark the round final only when its answers will settle the waypoint's question: it asks every",
        "  remaining question for this waypoint, and no answer to it could open another question or change",
        "  what the resolution must decide. If the person then chooses options without adding words, ZeNorm",
        "  resolves the waypoint from those choices and you get no further turn. Leave it not final whenever",
        "  an answer may call for a follow-up question, which on a first round is usual: a later question",
        "  that depends on these answers waits for the next round. When in doubt, leave it not final.",
        '- If the person\'s words end the interview (for example "wrap up" or "accept the rest"), ask no',
        "  further round: resolve from their answers plus your recommendations for every question still open.",
        "",
        ...resolveRules,
      ];
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
    ...renderCodeSurvey(request.survey, nonce),
    "You are working one waypoint of this map: one bounded decision, put to the person in question rounds",
    "where it passes the salience gate.",
    waypointNumberLine(waypoint.number),
    answeredRoundsLine(waypoint.rounds.length),
    ...block(
      "WAYPOINT",
      nonce,
      [`Kind: ${waypoint.kind}`, `Title: ${waypoint.title}`, `Question: ${waypoint.question}`].join(
        "\n",
      ),
    ),
    "",
    ...touchedSpecLines(waypoint.touches, nonce),
    ...finding,
    ...reviewFindings,
    ...waypointNoteLines(request.note, nonce),
    reopenedLine(waypoint.reopened),
    ...(superseded.length === 0
      ? []
      : [
          "The rounds answered before the person reopened this waypoint, oldest first. They are superseded:",
          "context for what was decided before, not live answers. Where they differ from the note, the note wins.",
          "",
          ...superseded,
        ]),
    ...(answered.length === 0
      ? [
          waypoint.reopened
            ? "No round on this waypoint has been asked since it was reopened."
            : "No round on this waypoint has been asked yet.",
          "",
        ]
      : [
          waypoint.reopened
            ? "The rounds answered since the reopen, oldest first:"
            : "The rounds answered on this waypoint, oldest first:",
          "",
          ...answered,
        ]),
    ...refused,
    "The map's other waypoints, by number:",
    ...others,
    ...fogAndOutOfScope(request, nonce),
    ...projectSuggestionLines(request, nonce),
    "The rounds waiting on the person on other waypoints, which they answer beside yours:",
    ...pending,
    ...task,
    "",
    "Answer only through the structured output. Write nothing else.",
  ].join("\n");
}
