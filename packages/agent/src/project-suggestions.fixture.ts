import type { ProjectMapContext, ProjectProposalContext } from "@zenorm/contracts";

import {
  NO_REPEAT_SUGGESTION_RULE,
  PROJECT_MAPS_HEADING,
  PROJECT_SUGGESTIONS_HEADING,
  projectSuggestionLines,
  SALIENT_SUGGESTION_RULE,
} from "./wayfinding-prompt.ts";

/**
 * Map suggestions from two maps of one project, oldest first, in all three states: a split offer
 * and an outside suggestion, each with its own line, then one attached to a waypoint and one that
 * split off an existing Out of scope line, neither with a line of its own.
 */
export const PROJECT_PROPOSALS: ProjectProposalContext[] = [
  { title: "CSV imports", line: "Importing CSV is left to its own map.", state: "confirmed" },
  {
    title: "Nightly exports",
    line: "Scheduled exports are left to their own map.",
    state: "dismissed",
  },
  { title: "Retire the old exporter", line: null, state: "pending" },
  { title: "Keep an export log", line: null, state: "dismissed" },
];

/** The project's maps, oldest first: one not charted yet, and one on each of three later stages. */
export const PROJECT_MAPS: ProjectMapContext[] = [
  { title: "Data export", stage: "delivery" },
  { title: "CSV imports", stage: "spec" },
  { title: "Export settings", stage: "wayfinding" },
  { title: null, stage: "idea" },
];

/** The two lists a request of a run that can suggest maps carries. */
export const PROJECT_CONTEXT = { projectProposals: PROJECT_PROPOSALS, projectMaps: PROJECT_MAPS };

/** No suggestion and no map: the request fixtures' lists when a test does not look at them. */
export const NO_PROJECT_CONTEXT = { projectProposals: [], projectMaps: [] };

/** The nonce of a prompt's `IDEA` block, which every block of the prompt shares. */
export function promptNonce(prompt: string): string {
  const nonce = /^<<<IDEA ([0-9a-f-]{36})$/m.exec(prompt)?.[1];
  if (nonce === undefined) throw new Error("the prompt has no IDEA start line");
  return nonce;
}

/** The project's suggestions and maps as a prompt carrying `PROJECT_CONTEXT` renders them. */
export function renderedProjectContext(prompt: string): string {
  return projectSuggestionLines(PROJECT_CONTEXT, promptNonce(prompt)).join("\n");
}

/**
 * What a suggesting run's prompt lacks of the suggestion rules (map suggestions that don't repeat):
 * each line of the no-repeat and no-existing-map rule and of the salient-only rule, written after
 * the two lists it refers to, and no propose-when-unsure rule. Empty when it has them all.
 */
export function suggestionRuleProblems(prompt: string): string[] {
  const suggestionsAt = prompt.indexOf(`\n${PROJECT_SUGGESTIONS_HEADING}, on any of its maps`);
  const mapsAt = prompt.indexOf(`\n${PROJECT_MAPS_HEADING}, oldest first`);
  const missing = [...NO_REPEAT_SUGGESTION_RULE, ...SALIENT_SUGGESTION_RULE].filter(
    (line) => !prompt.includes(line, Math.max(suggestionsAt, mapsAt)),
  );
  return [
    ...(suggestionsAt === -1 ? ["no suggestions list"] : []),
    ...(mapsAt === -1 ? ["no maps list"] : []),
    ...missing.map((line) => `missing after the lists: ${line}`),
    ...(/when (unsure|in doubt)[^.]*propose/i.test(prompt) ? ["proposes when unsure"] : []),
  ];
}

/** Lines every prompt carrying `PROJECT_CONTEXT` shows, with `nonce` its call's nonce. */
export function expectedProjectContextLines(nonce: string): string[] {
  return [
    [
      "Suggestion 1, created (it is a map of its own now):",
      `<<<SUGGESTION-1-TITLE ${nonce}`,
      "CSV imports",
      `SUGGESTION-1-TITLE ${nonce}>>>`,
      "Its Out of scope line:",
      `<<<SUGGESTION-1-LINE ${nonce}`,
      "Importing CSV is left to its own map.",
      `SUGGESTION-1-LINE ${nonce}>>>`,
    ].join("\n"),
    [
      "Suggestion 2, dismissed (the person said no):",
      `<<<SUGGESTION-2-TITLE ${nonce}`,
      "Nightly exports",
      `SUGGESTION-2-TITLE ${nonce}>>>`,
      "Its Out of scope line:",
      `<<<SUGGESTION-2-LINE ${nonce}`,
      "Scheduled exports are left to their own map.",
      `SUGGESTION-2-LINE ${nonce}>>>`,
    ].join("\n"),
    [
      "Suggestion 3, pending (the person has not decided it yet):",
      `<<<SUGGESTION-3-TITLE ${nonce}`,
      "Retire the old exporter",
      `SUGGESTION-3-TITLE ${nonce}>>>`,
      "",
    ].join("\n"),
    [
      "Suggestion 4, dismissed (the person said no):",
      `<<<SUGGESTION-4-TITLE ${nonce}`,
      "Keep an export log",
      `SUGGESTION-4-TITLE ${nonce}>>>`,
      "",
    ].join("\n"),
    ["Map 1, stage delivery, titled:", `<<<MAP-1-TITLE ${nonce}`, "Data export"].join("\n"),
    ["Map 2, stage spec, titled:", `<<<MAP-2-TITLE ${nonce}`, "CSV imports"].join("\n"),
    ["Map 3, stage wayfinding, titled:", `<<<MAP-3-TITLE ${nonce}`, "Export settings"].join("\n"),
    "Map 4, untitled (not charted yet), stage idea.",
  ];
}
