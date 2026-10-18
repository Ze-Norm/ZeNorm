import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type PlanningRunConfig,
  AgentEffort,
  ChartConfirmation,
  type ChartMapRequest,
  type ChartOutcome,
  chartProposal,
  ConsistencyOutcome,
  draftSpecsOutcome,
  grillOutcome,
  hatchOutcome,
  type HatchStage,
  ImplementEvent,
  type ImplementRequest,
  type ReplyThroughHatchRequest,
  researchOutcome,
  reviseSpecOutcome,
  specReviewOutcome,
  type SpecRevisionContent,
  taskOutcome,
  TicketSetContent,
  ticketsReviewOutcome,
  type PlanningCallSession,
} from "@zenorm/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";

import {
  claudeCodeCaptureScreens,
  claudeCodeImplementTicketSet,
  claudeCodeReviewDelivery,
  claudeCodeWritePullRequest,
  type DeliverySessionConfig,
  orchestratorArgs,
} from "./delivery.ts";
import { readAuthStatus } from "./claude.ts";
import { claudeCodeSettleFog } from "./fog.ts";
import { claudeCodeReplyThroughHatch } from "./hatch.ts";
import {
  claudeCodeDraftSpecs,
  claudeCodeDraftTicketSet,
  claudeCodeReviewSpec,
  claudeCodeReviewTicketSet,
  claudeCodeReviseSpec,
  type SpecRunConfig,
} from "./specs.ts";
import { SKILLS_DIR } from "./skills.ts";
import {
  claudeCodeCheckConsistency,
  claudeCodeResearchWaypoint,
  claudeCodeWorkTask,
} from "./waypoint-runs.ts";
import { LIMITS } from "./limits.fixture.ts";
import {
  chartConfirmationJsonSchema,
  claudeCodeChartMap,
  claudeCodeGrillWaypoint,
} from "./wayfinding.ts";

const ChartProposal = chartProposal(LIMITS);
const DraftSpecsOutcome = draftSpecsOutcome(LIMITS);
const GrillOutcome = grillOutcome(LIMITS);
const HatchOutcome = hatchOutcome(LIMITS);
const ResearchOutcome = researchOutcome(LIMITS);
const ReviseSpecOutcome = reviseSpecOutcome(LIMITS);
const SpecReviewOutcome = specReviewOutcome(LIMITS);
const TaskOutcome = taskOutcome(LIMITS);
const TicketsReviewOutcome = ticketsReviewOutcome(LIMITS);

/** A cold session whose usage the test does not look at. */
const SESSION: PlanningCallSession = {
  resumeSessionId: null,
  onUsage: () => undefined,
  signal: new AbortController().signal,
};

// Opt-in: runs only through `test:live`, against the real, logged-in Claude Code CLI.
const claudePath = process.env.ZENORM_LIVE_CLAUDE_PATH;
if (claudePath === undefined || claudePath === "") {
  throw new Error(
    'ZENORM_LIVE_CLAUDE_PATH must be the absolute path of the claude binary: ZENORM_LIVE_CLAUDE_PATH="$(command -v claude)"',
  );
}

const projectFolder = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-agent-live-")));
/** Every live call's session records. */
const sessionsDir = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-agent-live-sessions-")));

afterAll(() => {
  // Every call removed its session record once its process was gone.
  const left = readdirSync(sessionsDir);
  rmSync(projectFolder, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
  expect(left).toEqual([]);
});

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd: projectFolder,
  });
}

/** How long the live status read may take. */
const AUTH_STATUS_TIMEOUT_MS = 30_000;

test("a Claude Code set up for Bedrock reports loggedIn true with authMethod third_party", async () => {
  // Claude Code's documented Bedrock setup: the switch and a region; the AWS credentials are the
  // person's own, which `auth status` does not check.
  const status = await readAuthStatus(
    claudePath,
    { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" },
    AUTH_STATUS_TIMEOUT_MS,
  );
  if (!status.ok) throw new Error(`${status.error.code}: ${status.error.message}`);
  process.stdout.write(`${JSON.stringify(status.value)}\n`);
  expect(status.value).toEqual({ loggedIn: true, authMethod: "third_party" });
});

const config: SpecRunConfig = {
  claudePath,
  model: "claude-sonnet-5-5",
  limits: LIMITS,
  effort: "medium",
  maxTurns: 12,
  timeoutSeconds: 240,
  sessionsDir,
  skillsDir: SKILLS_DIR,
};

const idea = "Let people choose to count lines or characters instead of words.";

beforeAll(() => {
  git("init", "-b", "main");
  writeFileSync(
    join(projectFolder, "README.md"),
    [
      "# wordcount",
      "",
      "A tiny command-line tool that counts the words in the files it is given and prints one line per file",
      "(`<count> <path>`) followed by a total. It is a single Node.js script, `wordcount.js`, with no dependencies.",
      "",
    ].join("\n"),
  );
  git("add", "README.md");
  git("commit", "-m", "Add README");
});

const destinationRound = {
  questions: [
    {
      topic: "Choosing the unit",
      text: "How should a person choose what to count?",
      options: [
        { label: "Flags", detail: "`-l` for lines, `-c` for characters; familiar from wc." },
        { label: "One --unit option", detail: "`--unit lines|chars|words`; one place to extend." },
      ],
    },
    {
      topic: "Scope",
      text: "Is counting several units at once in scope?",
      options: [
        { label: "One unit per call", detail: "Simple output; several units need several calls." },
        { label: "Several at once", detail: "One column per unit; a wider output format." },
      ],
    },
  ],
  answers: [
    { optionIndex: 0, note: "", accepted: false },
    { optionIndex: 0, note: "", accepted: true },
  ],
  final: false,
};

/** A project whose one map, the one charted, has no title yet and no suggestion. */
const UNCHARTED_PROJECT = {
  projectProposals: [],
  projectMaps: [{ title: null, stage: "idea" as const }],
};

/** A project whose one map, the one worked, is on Wayfinding, with no suggestion. */
const CHARTED_PROJECT = {
  projectProposals: [],
  projectMaps: [{ title: "Count lines or characters", stage: "wayfinding" as const }],
};

/**
 * Runs one chart and prints what the over-asking report needs: the duration, the outcome's kind,
 * the destination and, for a follow-up, its intro, `final` and questions. A failed call throws.
 */
async function chart(
  chartConfig: PlanningRunConfig,
  request: ChartMapRequest,
): Promise<ChartOutcome> {
  const started = Date.now();
  const result = await claudeCodeChartMap(chartConfig)(request, SESSION);
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  const outcome = result.value;
  const report =
    outcome.kind === "proposal"
      ? { seconds, kind: outcome.kind, destination: outcome.proposal.destination }
      : outcome.kind === "confirmation"
        ? { seconds, kind: outcome.kind, destination: outcome.confirmation.destination }
        : {
            seconds,
            kind: outcome.kind,
            destination: outcome.followUp.destination,
            intro: outcome.followUp.round.intro,
            final: outcome.followUp.round.final,
            questions: outcome.followUp.round.questions.map(({ topic, text }) => ({ topic, text })),
          };
  process.stdout.write(`chart: ${JSON.stringify(report, null, 2)}\n`);
  return outcome;
}

/**
 * An over-asking check: the idea is clear and its round answered with the recommendations, so the
 * chart must confirm; a follow-up fails the case.
 */
function confirmed(outcome: ChartOutcome): ChartConfirmation {
  expect(outcome.kind).toBe("confirmation");
  if (outcome.kind !== "confirmation") throw new Error("expected a confirmation");
  expect(ChartConfirmation.safeParse(outcome.confirmation).success).toBe(true);
  return outcome.confirmation;
}

test("ChartMap: the real CLI proposes a reading, a destination and a destination round", async () => {
  const result = await claudeCodeChartMap(config)(
    {
      projectName: "wordcount",
      projectFolder,
      baseBranch: "main",
      idea,
      ...UNCHARTED_PROJECT,
      mapRounds: [],
      proposed: null,
      projectSpecs: [],
      split: [],
      refusedAttempt: null,
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  if (result.value.kind !== "proposal") throw new Error("expected a proposal");
  expect(ChartProposal.safeParse(result.value.proposal).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
});

test("ChartMap: the real CLI confirms the destination and charts waypoints with blockers", async () => {
  const outcome = await chart(config, {
    projectName: "wordcount",
    projectFolder,
    baseBranch: "main",
    idea,
    ...UNCHARTED_PROJECT,
    mapRounds: [destinationRound],
    proposed: {
      title: "Count lines or characters",
      summary: "Let people choose the unit wordcount counts.",
      destination:
        "wordcount counts lines (`-l`) or characters (`-c`) instead of words, one unit per call.",
    },
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  });

  // Over-asking check: a clear idea answered with the recommendations confirms.
  const confirmation = confirmed(outcome);
  process.stdout.write(`${JSON.stringify(confirmation, null, 2)}\n`);
});

// An idea that needs a Research waypoint (a platform fact only the web settles) and a Task waypoint
// (mechanical reading across many files), so the live chart shows whether kinds are used.
const kindsFolder = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-agent-live-kinds-")));

afterAll(() => {
  rmSync(kindsFolder, { recursive: true, force: true });
});

const kindsIdea =
  "Move our scheduled reports off the deprecated `request` library onto Node's built-in fetch, keeping them working behind the office proxy.";

const REPORT_OPTIONS = [
  "{ timeout: 5000, json: true }",
  "{ gzip: true }",
  "{ json: true, agentOptions: { ca: process.env.REPORTS_CA } }",
  "{ timeout: 20000, forever: true }",
  "{ json: true, qs: { since } }",
  "{ encoding: null }",
  "{ json: true, auth: { bearer: process.env.REPORTS_TOKEN } }",
  "{ timeout: 1000, followAllRedirects: true }",
  "{ json: true, pool: { maxSockets: 2 } }",
  "{ jar: true }",
  "{ json: true, strictSSL: false }",
  "{ time: true }",
];

beforeAll(() => {
  const run = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: kindsFolder,
    });
  run("init", "-b", "main");
  writeFileSync(
    join(kindsFolder, "package.json"),
    `${JSON.stringify({ name: "reports", private: true, engines: { node: ">=20" }, dependencies: { request: "^2.88.2" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(kindsFolder, "README.md"),
    [
      "# reports",
      "",
      "Scheduled jobs that fetch figures from internal services and mail a report. They run on the office",
      "servers, which reach the network only through the proxy set in `HTTPS_PROXY`.",
      "",
    ].join("\n"),
  );
  mkdirSync(join(kindsFolder, "src", "reports"), { recursive: true });
  REPORT_OPTIONS.forEach((options, index) => {
    const name = `report-${String(index + 1).padStart(2, "0")}`;
    writeFileSync(
      join(kindsFolder, "src", "reports", `${name}.js`),
      [
        'const request = require("request");',
        "",
        `module.exports = function ${name.replace("-", "")}(since, done) {`,
        `  request.get("https://figures.internal/${name}", ${options}, (error, response, body) => {`,
        "    if (error) return done(error);",
        "    done(null, body);",
        "  });",
        "};",
        "",
      ].join("\n"),
    );
  });
  run("add", ".");
  run("commit", "-m", "Add reports");
});

const kindsRound = {
  questions: [
    {
      topic: "Rollout",
      text: "Should every report move at once or one at a time?",
      options: [
        { label: "All at once", detail: "One change; every report moves together." },
        { label: "One at a time", detail: "Smaller steps; both libraries live side by side." },
      ],
    },
    {
      topic: "Behaviour",
      text: "Must each report behave exactly as it does today?",
      options: [
        { label: "Same behaviour", detail: "Every option a report passes keeps its effect." },
        { label: "Simplify", detail: "Drop options nobody needs; reports may change." },
      ],
    },
  ],
  answers: [
    { optionIndex: 0, note: "", accepted: true },
    { optionIndex: 0, note: "", accepted: true },
  ],
  final: false,
};

test("ChartMap: the real CLI charts a Research waypoint for an idea that needs one", async () => {
  const outcome = await chart(config, {
    projectName: "reports",
    projectFolder: kindsFolder,
    baseBranch: "main",
    idea: kindsIdea,
    ...UNCHARTED_PROJECT,
    mapRounds: [kindsRound],
    proposed: {
      title: "Reports on built-in fetch",
      summary: "Move the scheduled reports off the deprecated request library.",
      destination:
        "The scheduled reports fetch with Node's built-in fetch instead of `request`, still working behind the office proxy.",
    },
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  });

  // Over-asking check: a clear idea answered with the recommendations confirms.
  const confirmation = confirmed(outcome);
  process.stdout.write(
    `${JSON.stringify(
      {
        waypoints: confirmation.waypoints.map(({ kind, title, blockedBy }) => ({
          kind,
          title,
          blockedBy,
        })),
        fog: confirmation.fog,
        outOfScope: confirmation.outOfScope,
      },
      null,
      2,
    )}\n`,
  );
  // No Task waypoint is expected (planning salience): the twelve report files are small enough to
  // read while charting ("A fact you have already read while charting needs no waypoint"), and the
  // chart prompt now charts few waypoints, so the per-option work is what fetch does for each
  // option: a web fact, charted as research. The Task kind's rule stays in the chart prompt.
  const kinds = new Set(confirmation.waypoints.map((waypoint) => waypoint.kind));
  expect(kinds.has("research")).toBe(true);
});

// The chart confirms when it should and follows up only when an answer moves the scope. A tiny
// tasks tool where an own-words answer can widen "delete" into an archive.
const tasksFolder = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-agent-live-tasks-")));
/** Where the argv-recording wrapper of the real CLI writes the last call's argv. */
const argvFolder = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-agent-live-argv-")));

afterAll(() => {
  rmSync(tasksFolder, { recursive: true, force: true });
  rmSync(argvFolder, { recursive: true, force: true });
});

beforeAll(() => {
  const run = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: tasksFolder,
    });
  run("init", "-b", "main");
  writeFileSync(
    join(tasksFolder, "README.md"),
    [
      "# tasks",
      "",
      "A tiny command-line to-do list. `tasks add <text>` adds a task, `tasks list` prints the open tasks",
      "one per line (`<id> <text>`), and `tasks done <id>` marks one done. Tasks live in `tasks.json` in",
      "the current folder. It is a single Node.js script, `tasks.js`, with no dependencies.",
      "",
    ].join("\n"),
  );
  run("add", "README.md");
  run("commit", "-m", "Add README");
});

const tasksIdea = "Let people delete a task they no longer need.";

const tasksProposed = {
  title: "Delete a task",
  summary: "A command that removes a task people no longer need.",
  destination: "`tasks delete <id>` removes the task from `tasks.json`; an unknown id exits 1.",
};

/** The first round on the tasks idea; `notes` are the person's words, one per question. */
function tasksRound(notes: readonly [string, string]) {
  return {
    questions: [
      {
        topic: "What delete does",
        text: "What happens to a deleted task?",
        options: [
          { label: "Removed", detail: "The task is gone from `tasks.json` for good." },
          {
            label: "Kept, hidden",
            detail: "The task stays in the file, hidden from `tasks list`.",
          },
        ],
      },
      {
        topic: "Unknown id",
        text: "What should `tasks delete` do with an id that does not exist?",
        options: [
          { label: "Exit 1", detail: "Print `no task <id>` and exit 1, like `tasks done`." },
          { label: "Do nothing", detail: "Exit 0 silently." },
        ],
      },
    ],
    answers: notes.map((note) =>
      note === ""
        ? { optionIndex: 0, note, accepted: true }
        : { optionIndex: null, note, accepted: false },
    ),
    final: false,
  };
}

/** The distinctive term the widening answer carries. */
const WIDENING_TERM =
  /\b(old(er)?|in one go|at once|bulk|several|multiple|batch|clear\w*|finished|completed)\b/i;

/** Widens the scope to a bulk clear and leaves which tasks are old open. */
const wideningNote =
  "Also, I'd like a way to clear out old tasks I no longer need in one go, not just one at a time.";

test("ChartMap: a clear idea answered with the recommendations confirms after round 1", async () => {
  const outcome = await chart(config, {
    projectName: "tasks",
    projectFolder: tasksFolder,
    baseBranch: "main",
    idea: tasksIdea,
    ...UNCHARTED_PROJECT,
    mapRounds: [tasksRound(["", ""])],
    proposed: tasksProposed,
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  });

  confirmed(outcome);
});

test("ChartMap: an own-words answer that widens the scope gets a follow-up on it, then a confirmation", async () => {
  const first = tasksRound([wideningNote, ""]);
  const asked = await chart(config, {
    projectName: "tasks",
    projectFolder: tasksFolder,
    baseBranch: "main",
    idea: tasksIdea,
    ...UNCHARTED_PROJECT,
    mapRounds: [first],
    proposed: tasksProposed,
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  });

  expect(asked.kind).toBe("followUp");
  if (asked.kind !== "followUp") throw new Error("expected a follow-up");
  const { round } = asked.followUp;
  expect(round.questions.length).toBeLessThanOrEqual(3);
  expect(
    [round.intro, ...round.questions.map((question) => question.text)].some((text) =>
      WIDENING_TERM.test(text),
    ),
  ).toBe(true);

  // The person answers the follow-up with its recommendations; the follow-up replaced the map's
  // title, summary and proposed destination.
  const outcome = await chart(config, {
    projectName: "tasks",
    projectFolder: tasksFolder,
    baseBranch: "main",
    idea: tasksIdea,
    ...UNCHARTED_PROJECT,
    mapRounds: [
      first,
      {
        questions: round.questions,
        answers: round.questions.map(() => ({ optionIndex: 0, note: "", accepted: true })),
        final: round.final,
      },
    ],
    proposed: {
      title: asked.followUp.title,
      summary: asked.followUp.summary,
      destination: asked.followUp.destination,
    },
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  });

  expect(WIDENING_TERM.test(confirmed(outcome).destination)).toBe(true);
});

test("ChartMap: wrap up in the person's words confirms", async () => {
  const outcome = await chart(config, {
    projectName: "tasks",
    projectFolder: tasksFolder,
    baseBranch: "main",
    idea: tasksIdea,
    ...UNCHARTED_PROJECT,
    mapRounds: [
      tasksRound([
        `${wideningNote} That is everything I want from this: please wrap up and chart it.`,
        "",
      ]),
    ],
    proposed: tasksProposed,
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  });

  confirmed(outcome);
});

test("ChartMap: after a final follow-up the port sends the confirm schema and confirms", async () => {
  // The real CLI behind a wrapper that records each call's argv (the pid stays the CLI's: `exec`).
  const wrapper = join(argvFolder, "claude");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `printf '%s\\0' "$@" > '${join(argvFolder, "argv")}'`,
      `exec '${claudePath}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const outcome = await chart(
    { ...config, claudePath: wrapper },
    {
      projectName: "tasks",
      projectFolder: tasksFolder,
      baseBranch: "main",
      idea: tasksIdea,
      ...UNCHARTED_PROJECT,
      mapRounds: [
        tasksRound([wideningNote, ""]),
        {
          questions: [
            {
              topic: "Which tasks are old",
              text: 'You asked to "clear out old tasks I no longer need in one go". Which tasks should that clear?',
              options: [
                { label: "All done tasks", detail: "Every task marked done is removed." },
                { label: "Every task", detail: "The whole list is emptied." },
              ],
            },
          ],
          answers: [{ optionIndex: 0, note: "", accepted: true }],
          final: true,
        },
      ],
      proposed: {
        title: "Delete and clear tasks",
        summary: "Delete one task, or clear out old tasks in one go.",
        destination:
          "`tasks delete <id>` removes one task (an unknown id exits 1), and a second command clears old tasks in one go.",
      },
      projectSpecs: [],
      split: [],
      refusedAttempt: null,
    },
  );

  const argv = readFileSync(join(argvFolder, "argv"), "utf8").split("\0").slice(0, -1);
  const schema = argv[argv.indexOf("--json-schema") + 1];
  expect(schema).toBe(chartConfirmationJsonSchema(LIMITS));
  confirmed(outcome);
});

const grillBase = {
  projectName: "wordcount",
  projectFolder,
  baseBranch: "main",
  idea,
  ...CHARTED_PROJECT,
  title: "Count lines or characters",
  destination:
    "wordcount counts lines (`-l`) or characters (`-c`) instead of words, one unit per call.",
  mapRounds: [destinationRound],
  otherWaypoints: [
    {
      number: 2,
      kind: "grilling" as const,
      title: "Help and README wording",
      status: "open" as const,
      gist: null,
      agentDecided: null,
      resolution: null,
    },
  ],
  otherPendingRounds: [],
  fog: [],
  outOfScope: ["Counting several units in one call."],
  finding: null,
  reviewFindings: [],
  note: null,
  refusedAttempt: null,
};

const outputQuestion = {
  topic: "Total label",
  text: "What should the total line show when counting lines or characters?",
  options: [
    { label: "Labelled total", detail: "`12 total lines`: clear, but changes the output." },
    { label: "Plain total", detail: "`12 total`: unchanged format, the unit is implicit." },
  ],
};

test("GrillWaypoint: the real CLI grills a fresh waypoint", async () => {
  const result = await claudeCodeGrillWaypoint(config)(
    {
      survey: null,
      ...grillBase,
      waypoint: {
        number: 1,
        kind: "grilling" as const,
        title: "Output format per unit",
        question: "How does the output read when counting lines or characters?",
        touches: [],
        rounds: [],
        reopened: false,
        supersededRounds: [],
        personDecides: false,
      },
      afterFinal: false,
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(GrillOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
});

test("GrillWaypoint: after a final round answered with words, the real CLI resolves", async () => {
  const result = await claudeCodeGrillWaypoint(config)(
    {
      survey: null,
      ...grillBase,
      waypoint: {
        number: 1,
        kind: "grilling" as const,
        title: "Output format per unit",
        question: "How does the output read when counting lines or characters?",
        touches: [],
        rounds: [
          {
            questions: [outputQuestion],
            answers: [
              {
                optionIndex: 0,
                note: "Use the plural only: `1 total lines` is fine, keep it simple.",
                accepted: false,
              },
            ],
            final: true,
          },
        ],
        reopened: false,
        supersededRounds: [],
        personDecides: false,
      },
      afterFinal: true,
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(result.value.round).toBeNull();
  expect(GrillOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
});

test("SettleFog: the map's fog run settles every fog item once", async () => {
  const result = await claudeCodeSettleFog(config)(
    {
      projectName: grillBase.projectName,
      projectFolder: grillBase.projectFolder,
      baseBranch: grillBase.baseBranch,
      idea: grillBase.idea,
      ...CHARTED_PROJECT,
      title: grillBase.title,
      destination: grillBase.destination,
      mapRounds: grillBase.mapRounds,
      outOfScope: [],
      survey: null,
      waypoints: [
        {
          number: 1,
          kind: "grilling" as const,
          title: "Output format per unit",
          question: "How does the output read when counting lines or characters?",
          resolution: "The count prints alone on one line, as the word count does today.",
          decidedByPerson: true,
        },
        {
          number: 2,
          kind: "grilling" as const,
          title: "Help and README wording",
          question: "How do the README and --help describe the new flags?",
          resolution: "README and --help list -l and -c",
          decidedByPerson: false,
        },
      ],
      fog: [{ position: 1, text: "Whether `-c` counts bytes or Unicode characters." }],
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  const settled = [
    ...result.value.fogSettledBy.map((item) => item.position),
    ...result.value.fogDecided.map((item) => item.position),
    ...result.value.fogOutOfScope.map((item) => item.position),
    ...result.value.fogForPerson.map((item) => item.position),
  ];
  expect(settled).toEqual([1]);
});

test("live GrillWaypoint reopened: old answered rounds and a note ask a new round", async () => {
  const result = await claudeCodeGrillWaypoint(config)(
    {
      survey: null,
      ...grillBase,
      waypoint: {
        number: 1,
        kind: "grilling" as const,
        title: "Output format per unit",
        question: "How does the output read when counting lines or characters?",
        touches: [],
        rounds: [],
        reopened: true,
        supersededRounds: [
          {
            questions: [outputQuestion],
            answers: [{ optionIndex: 1, note: "", accepted: false }],
            final: true,
          },
        ],
        personDecides: false,
      },
      note: {
        text: "The plain total was the wrong call: scripts can't tell what unit the total counts. Decide the total again.",
        sentAt: "2026-10-08T09:30:00.000Z",
      },
      afterFinal: false,
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  expect(GrillOutcome.safeParse(result.value).success).toBe(true);
  expect(result.value.round).not.toBeNull();
  expect(result.value.resolution).toBeNull();
});

const waypointRunBase = {
  projectName: "wordcount",
  projectFolder,
  baseBranch: "main",
  idea,
  ...CHARTED_PROJECT,
  title: "Count lines or characters",
  destination:
    "wordcount counts lines (`-l`) or characters (`-c`) instead of words, one unit per call.",
  mapRounds: [destinationRound],
  fog: [{ position: 1, text: "Whether characters means bytes or Unicode code points" }],
  outOfScope: ["Reading from standard input: wordcount only counts named files."],
  note: null,
};

/**
 * Research reads the web, so it gets more turns; the run doubles them and the timeout, so its
 * deadline (280 s) stays under the 300 s test timeout.
 */
const researchConfig: PlanningRunConfig = { ...config, maxTurns: 15, timeoutSeconds: 140 };

test("ResearchWaypoint: the real CLI researches a fact only the web holds", async () => {
  const result = await claudeCodeResearchWaypoint(researchConfig)(
    {
      survey: null,
      ...waypointRunBase,
      waypoint: {
        number: 2,
        kind: "research",
        title: "Supported Node.js versions",
        question:
          "Which Node.js release lines are in Active LTS or Maintenance LTS today, per the official Node.js release schedule? The answer fixes the oldest Node.js version wordcount supports.",
        touches: [],
      },
      otherWaypoints: [
        {
          number: 1,
          kind: "grilling",
          title: "Flag names",
          status: "claimed",
          gist: null,
          agentDecided: null,
          resolution: null,
        },
      ],
      earlierReports: [],
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(ResearchOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
});

test("WorkTask: the real CLI works a read-only task", async () => {
  const result = await claudeCodeWorkTask(config)(
    {
      survey: null,
      ...waypointRunBase,
      waypoint: {
        number: 3,
        kind: "task",
        title: "Find the CI that runs wordcount's tests",
        touches: [],
        question:
          "Which CI service runs wordcount's tests, and which job would a new flag's tests join?",
        rounds: [],
      },
      otherWaypoints: [
        {
          number: 1,
          kind: "grilling",
          title: "Flag names",
          status: "claimed",
          gist: null,
          agentDecided: null,
          resolution: null,
        },
      ],
      earlierOutcomes: [],
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(TaskOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
});

test("CheckConsistency: the real CLI compares resolutions that conflict", async () => {
  const result = await claudeCodeCheckConsistency(config)(
    {
      survey: null,
      projectName: "wordcount",
      projectFolder,
      baseBranch: "main",
      idea,
      ...CHARTED_PROJECT,
      title: waypointRunBase.title,
      destination: waypointRunBase.destination,
      mapRounds: waypointRunBase.mapRounds,
      outOfScope: waypointRunBase.outOfScope,
      waypoints: [
        {
          number: 1,
          kind: "grilling",
          title: "Flag names",
          question: "Which flags choose the unit?",
          resolution:
            "`-l` counts lines and `-c` counts characters; with neither, words are counted.",
          decidedByPerson: true,
          newSinceLastPass: true,
          finding: null,
        },
        {
          number: 2,
          kind: "grilling",
          title: "Output format per unit",
          question: "How does the output read when counting lines or characters?",
          resolution:
            "The total line names its unit, for example `12 total lines`, so readers never guess the unit.",
          decidedByPerson: true,
          newSinceLastPass: true,
          finding: null,
        },
        {
          number: 3,
          kind: "grilling",
          title: "Compatibility",
          question: "What must stay the same for existing users?",
          resolution:
            "Every output line keeps exactly today's format, `<count> <path>` and `<count> total`, because scripts parse it.",
          decidedByPerson: true,
          newSinceLastPass: true,
          finding: null,
        },
      ],
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(ConsistencyOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
});

test("CheckConsistency: the real CLI does not suggest again a map suggestion the project already has", async () => {
  // Waypoint 2's resolution leaves JSON output to another effort, which a pass would suggest as a
  // map; the project's list already holds that suggestion, pending, so the pass must not repeat it.
  const result = await claudeCodeCheckConsistency(config)(
    {
      survey: null,
      projectName: "wordcount",
      projectFolder,
      baseBranch: "main",
      idea,
      projectProposals: [
        {
          title: "JSON output for wordcount",
          line: "Machine-readable JSON output is left to its own map.",
          state: "pending",
        },
      ],
      projectMaps: [
        { title: "Count lines or characters", stage: "wayfinding" },
        { title: "Count words from standard input", stage: "spec" },
      ],
      title: waypointRunBase.title,
      destination: waypointRunBase.destination,
      mapRounds: waypointRunBase.mapRounds,
      outOfScope: waypointRunBase.outOfScope,
      waypoints: [
        {
          number: 1,
          kind: "grilling",
          title: "Flag names",
          question: "Which flags choose the unit?",
          resolution:
            "`-l` counts lines and `-c` counts characters; with neither, words are counted.",
          decidedByPerson: true,
          newSinceLastPass: true,
          finding: null,
        },
        {
          number: 2,
          kind: "grilling",
          title: "Output for scripts",
          question: "How do scripts read the counts?",
          resolution:
            "Scripts keep parsing today's `<count> <path>` lines. A machine-readable JSON output mode would serve them better, but it is outside this map's destination and is not built here.",
          decidedByPerson: true,
          newSinceLastPass: true,
          finding: null,
        },
      ],
    },
    SESSION,
  );

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  expect(ConsistencyOutcome.safeParse(result.value).success).toBe(true);
  const repeats = result.value.proposals.filter((proposal) =>
    /json|standard input|stdin/i.test(`${proposal.title} ${proposal.idea} ${proposal.line}`),
  );
  expect(repeats).toEqual([]);
});

/** Strings in `value` whose backticks nest or don't pair: reported, and asserted none. */
function badBackticks(value: unknown): string[] {
  const strings: string[] = [];
  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") strings.push(item);
    return item;
  });
  return strings.filter((text) => text.includes("``") || (text.split("`").length - 1) % 2 === 1);
}

const specMap = {
  projectName: "wordcount",
  projectFolder,
  baseBranch: "main",
  idea: "Let people count lines or characters instead of words, and add a --json output for scripts.",
  title: "Units and JSON output",
  destination:
    "wordcount can count lines (-l) or characters (-c) instead of words, and --json prints the counts as JSON for scripts; the plain output is unchanged.",
  waypoints: [
    {
      number: 1,
      kind: "grilling" as const,
      title: "Unit flags",
      question: "Which flags choose the unit?",
      resolution:
        "-l counts lines and -c counts characters; with neither, words are counted. Passing both is refused with exit code 2.",
      gist: "-l lines, -c characters, both refused.",
      agentDecided: [],
      touches: [],
    },
    {
      number: 2,
      kind: "grilling" as const,
      title: "JSON shape",
      question: "What does --json print?",
      resolution:
        "One JSON object: files, an array of {path, count}, and total, a number; nothing else is printed.",
      gist: "{files:[{path,count}], total}.",
      agentDecided: [],
      touches: [],
    },
    {
      number: 3,
      kind: "research" as const,
      title: "Character counting",
      question: "Does a character mean a byte or a code point?",
      resolution: "A character is a Unicode code point, as Node's Array.from(text).length counts.",
      gist: "Code points.",
      agentDecided: [],
      research: {
        findings: [
          {
            title: "Array.from counts code points",
            detail: "Array.from(text) splits a string into Unicode code points, not UTF-16 units.",
          },
        ],
        sources: [
          {
            title: "MDN: Array.from()",
            url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/from",
          },
        ],
      },
      touches: [],
    },
  ],
  outOfScope: ["Counting several units at once."],
  waits: [],
};

const unitsRevision: SpecRevisionContent = {
  title: "Count lines or characters",
  problem: "wordcount only counts words.",
  solution: "Flags choose lines or characters.",
  clauses: [
    {
      id: "C1",
      title: "Unit flags",
      text: "-l counts lines and -c counts characters; with neither flag words are counted. Both together are refused with exit code 2.",
      criteria: [
        { id: "1.1", text: "wordcount -l a.txt prints the line count of a.txt." },
        { id: "1.2", text: "wordcount -c a.txt prints the code-point count of a.txt." },
        { id: "1.3", text: "wordcount -l -c a.txt exits with code 2." },
      ],
      sources: [
        { kind: "waypoint", number: 1 },
        { kind: "waypoint", number: 3 },
      ],
    },
  ],
  outOfScope: ["Counting several units at once."],
};

test("live DraftSpecs: the real CLI writes the specs of a two-part idea", async () => {
  const result = await claudeCodeDraftSpecs(config)(
    {
      survey: null,
      ...specMap,
      mapRounds: [destinationRound],
      specs: [],
      projectSpecs: [],
      refusedAttempt: null,
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(DraftSpecsOutcome.safeParse(result.value).success).toBe(true);
  const sources = result.value.specs.flatMap((spec) =>
    spec.content.clauses.flatMap((clause) => clause.sources),
  );
  const named = new Set(
    sources.flatMap((source) => (source.kind === "waypoint" ? [source.number] : [])),
  );
  process.stdout.write(
    `${JSON.stringify({ specs: result.value.specs.length, waypointsNamed: [...named], badBackticks: badBackticks(result.value) })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect([...named].every((number) => [1, 2, 3].includes(number))).toBe(true);
  expect(badBackticks(result.value)).toEqual([]);
});

test("live ReviseSpec: the real CLI repairs a spec after a rejection, keeping its ids", async () => {
  const result = await claudeCodeReviseSpec(config)(
    {
      survey: null,
      references: [],
      ...specMap,
      mapRounds: [destinationRound],
      latest: { specNumber: 1, revision: 1, content: unitsRevision },
      retiredIds: [],
      feedback: {
        kind: "rejection",
        reason: "Say what the total line reads when counting lines or characters.",
      },
      earlierFindings: [],
      projectSpecs: [],
      refusedAttempt: null,
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(ReviseSpecOutcome.safeParse(result.value).success).toBe(true);
  const ids = result.value.revision.clauses.flatMap((clause) => clause.criteria.map((c) => c.id));
  process.stdout.write(
    `${JSON.stringify({ ids, badBackticks: badBackticks(result.value) })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(ids).toEqual(expect.arrayContaining(["1.1", "1.2", "1.3"]));
  expect(badBackticks(result.value)).toEqual([]);
});

test("live ReviewSpec: the real CLI finds a planted untraced clause", async () => {
  const planted: SpecRevisionContent = {
    ...unitsRevision,
    clauses: [
      ...unitsRevision.clauses,
      {
        id: "C2",
        title: "Colored counts",
        text: "Counts are printed in green when stdout is a terminal, and plain otherwise.",
        criteria: [{ id: "2.1", text: "On a terminal, each count is printed in green." }],
        sources: [{ kind: "destination" }],
      },
    ],
  };
  const result = await claudeCodeReviewSpec(config)(
    {
      survey: null,
      references: [],
      ...specMap,
      mapRounds: [destinationRound],
      revision: { specNumber: 1, revision: 1, content: planted },
      before: null,
      removed: null,
      earlierFindings: [],
      changes: null,
      otherSpecs: [],
      rejection: null,
      noteDirectedRevisions: [],
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(SpecReviewOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  expect(
    result.value.findings.some(
      (finding) =>
        (finding.kind === "invented_scope" || finding.kind === "contradiction") &&
        finding.elementIds.some((id) => id === "C2" || id === "2.1"),
    ),
  ).toBe(true);
});

/** The person's note overriding waypoint 1's "both refused" resolution. */
const bothNote =
  "Passing both -l and -c should be refused with exit code 1, not 2, so it matches wordcount's other usage errors.";

const noteRevision: SpecRevisionContent = {
  ...unitsRevision,
  clauses: [
    {
      id: "C1",
      title: "Unit flags",
      text: "-l counts lines and -c counts characters; with neither flag words are counted. Both together are refused with exit code 1.",
      criteria: [
        { id: "1.1", text: "wordcount -l a.txt prints the line count of a.txt." },
        { id: "1.2", text: "wordcount -c a.txt prints the code-point count of a.txt." },
        { id: "1.4", text: "wordcount -l -c a.txt exits with code 1." },
      ],
      sources: [{ kind: "waypoint", number: 1 }, { kind: "waypoint", number: 3 }, { kind: "note" }],
    },
  ],
};

const jsonRevision: SpecRevisionContent = {
  title: "JSON output",
  problem: "Scripts cannot read wordcount's plain output reliably.",
  solution: "--json prints the counts as one JSON object.",
  clauses: [
    {
      id: "C1",
      title: "JSON object",
      text: "--json prints one JSON object: files, an array of {path, count}, and total, a number; nothing else is printed. Without --json the plain output is unchanged.",
      criteria: [
        { id: "1.1", text: "wordcount --json a.txt prints one JSON object with files and total." },
        { id: "1.2", text: "wordcount a.txt prints the same plain output as before." },
      ],
      sources: [{ kind: "waypoint", number: 2 }, { kind: "destination" }],
    },
  ],
  outOfScope: [],
};

test("live notes ReviseSpec: the real CLI follows a note over an earlier resolution and cites it", async () => {
  const result = await claudeCodeReviseSpec(config)(
    {
      survey: null,
      references: [],
      ...specMap,
      mapRounds: [destinationRound],
      latest: { specNumber: 1, revision: 1, content: unitsRevision },
      retiredIds: [],
      feedback: { kind: "note", text: bothNote },
      earlierFindings: [],
      projectSpecs: [],
      refusedAttempt: null,
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(ReviseSpecOutcome.safeParse(result.value).success).toBe(true);
  const noteClauses = result.value.revision.clauses
    .filter((clause) => clause.sources.some((source) => source.kind === "note"))
    .map((clause) => clause.id);
  process.stdout.write(
    `${JSON.stringify({ noteClauses, badBackticks: badBackticks(result.value) })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(noteClauses.length).toBeGreaterThan(0);
  expect(badBackticks(result.value)).toEqual([]);
});

test("live notes ReviewSpec: the real CLI accepts the change a note asked for", async () => {
  const result = await claudeCodeReviewSpec(config)(
    {
      survey: null,
      references: [],
      ...specMap,
      mapRounds: [destinationRound],
      revision: { specNumber: 1, revision: 2, content: noteRevision },
      before: { specNumber: 1, revision: 1, content: unitsRevision, delivery: null },
      changes: null,
      removed: null,
      earlierFindings: [],
      otherSpecs: [{ specNumber: 2, revision: 1, content: jsonRevision }],
      rejection: null,
      noteDirectedRevisions: [{ revision: 2, note: bothNote }],
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(SpecReviewOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  const againstNote = result.value.findings.filter(
    (finding) =>
      finding.kind !== "undefined_term" &&
      finding.elementIds.some((id) => id === "C1" || id === "1.4"),
  );
  expect(againstNote).toEqual([]);
});

test("live notes DraftSpecs: a re-clear with every spec approved and nothing changed writes no spec", async () => {
  const result = await claudeCodeDraftSpecs(config)(
    {
      survey: null,
      ...specMap,
      mapRounds: [destinationRound],
      specs: [
        {
          latest: { specNumber: 1, revision: 1, content: unitsRevision },
          retiredIds: [],
          approved: true,
          feedback: null,
        },
        {
          latest: { specNumber: 2, revision: 1, content: jsonRevision },
          retiredIds: [],
          approved: true,
          feedback: null,
        },
      ],
      projectSpecs: [],
      refusedAttempt: null,
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  expect(result.value.specs).toEqual([]);
});

test("live DraftTicketSet: the real CLI writes tickets for an approved revision", async () => {
  const result = await claudeCodeDraftTicketSet(config)(
    {
      survey: null,
      ...specMap,
      approved: { specNumber: 1, revision: 1, content: unitsRevision },
      firstTicketNumber: 1,
      delta: null,
      readings: {},
      takenOut: [],
      touchingWaypoints: [],
      earlierTickets: [],
      rewrite: null,
      earlierFindings: [],
      refusedAttempt: null,
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(TicketSetContent.safeParse(result.value).success).toBe(true);
  const disposed = result.value.dispositions.map((disposition) => disposition.criterion).sort();
  process.stdout.write(
    `${JSON.stringify({ tickets: result.value.tickets.length, disposed, badBackticks: badBackticks(result.value) })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(disposed).toEqual(["1.1", "1.2", "1.3"]);
  expect(badBackticks(result.value)).toEqual([]);
});

const nestedRevision: SpecRevisionContent = {
  title: "Reject duplicate and nested project folders",
  problem:
    "Adding a folder that is already a project, or that sits inside or contains one, creates a second project over the same files.",
  solution: "addProject refuses duplicate and nested folders before anything is stored.",
  clauses: [
    {
      id: "C1",
      title: "Refuse duplicate folders",
      text: "A folder whose real path equals an existing project's folder is refused with FOLDER_ALREADY_PROJECT.",
      criteria: [{ id: "1.1", text: "Adding a project's own folder again is refused." }],
      sources: [{ kind: "waypoint", number: 2 }],
    },
    {
      id: "C2",
      title: "Refuse nested folders before anything is stored",
      text: "A folder inside an existing project's folder is refused with FOLDER_INSIDE_PROJECT, and a folder containing one with FOLDER_CONTAINS_PROJECT. The check compares every ancestor of the new folder and every descendant path of each project, so nesting at any depth is refused.",
      criteria: [
        { id: "2.1", text: "A folder three levels inside a project is refused." },
        { id: "2.2", text: "A folder containing a project is refused." },
      ],
      sources: [{ kind: "waypoint", number: 1 }],
    },
  ],
  outOfScope: ["Moving an existing project to another folder."],
};

/** The nested-folders map, its spec 1 a draft whose review passed. */
/** The hatch map's destination round, answered with its recommendation. */
const nestingRound = {
  questions: [
    {
      topic: "Nesting",
      text: "Should a folder inside a project, or one holding a project, be refused too?",
      options: [
        { label: "Refuse nesting both ways", detail: "No project inside another, at any depth." },
        { label: "Refuse duplicates only", detail: "Nested projects stay allowed." },
      ],
    },
  ],
  answers: [{ optionIndex: 0, note: "", accepted: true }],
  final: false,
};

function hatchRequest(
  stage: HatchStage,
  specNumber: number | null,
  text: string,
): ReplyThroughHatchRequest {
  return {
    survey: null,
    projectName: "zenorm",
    projectFolder,
    baseBranch: "main",
    idea: "Adding a folder that is already a project, or is inside one, should be refused.",
    projectProposals: [],
    projectMaps: [{ title: "Reject duplicate and nested project folders", stage: "spec" }],
    title: "Reject duplicate and nested project folders",
    destination: "Duplicate and nested folders can't become projects, delivered and merged.",
    mapRounds: [nestingRound],
    waypoints: [
      {
        number: 1,
        kind: "grilling",
        title: "Decide nested-folder handling",
        question:
          "A folder sits inside an existing project, or contains one. What happens when you add it?",
        status: "resolved",
        blockedBy: [],
        resolution:
          "Nesting is refused both ways and at any depth: a folder inside a project, or containing one, is refused before anything is stored.",
        gist: "Nested folders are refused both ways, at any depth.",
        agentDecided: [],
        waiting: null,
        report: null,
        stopped: false,
      },
      {
        number: 2,
        kind: "grilling",
        title: "Decide what counts as the same folder",
        question: "When are two folders the same project?",
        status: "resolved",
        blockedBy: [],
        resolution:
          "Two folders are the same when their real paths match: symlinks are resolved, so a symlink to a project's folder is a duplicate.",
        gist: "Same folder means same real path; symlinks resolved.",
        agentDecided: [],
        waiting: null,
        report: null,
        stopped: false,
      },
    ],
    fog: [],
    outOfScope: ["Moving an existing project to another folder."],
    waits: [],
    specs: [
      {
        latest: { specNumber: 1, revision: 1, content: nestedRevision },
        state: "draft",
        ticketSet: null,
        inFlight: [],
      },
    ],
    earlierMessages: [],
    message: { stage, specNumber, text },
    refusedAttempt: null,
  };
}

async function liveHatch(request: ReplyThroughHatchRequest): Promise<z.infer<typeof HatchOutcome>> {
  const result = await claudeCodeReplyThroughHatch(config)(request, SESSION);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(HatchOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  return result.value;
}

test("live hatch reply only: a question about the spec gets a reply and no change", async () => {
  const outcome = await liveHatch(
    hatchRequest("spec", 1, "Does “nested” mean any depth, or only a direct child?"),
  );
  expect(outcome.change).toBeNull();
});

test("live hatch reopen: a message saying a decision was wrong reopens its waypoint", async () => {
  const outcome = await liveHatch(
    hatchRequest(
      "wayfinding",
      null,
      "The decision on what counts as the same folder was wrong: a symlink to a project's folder should be its own project, not a duplicate.",
    ),
  );
  expect(outcome.change).toEqual({ kind: "reopen", waypoint: 2 });
});

test("live hatch reopen, every spec approved: the reply says the approved spec stands", async () => {
  const base = hatchRequest(
    "wayfinding",
    null,
    "The decision on what counts as the same folder was wrong: a symlink to a project's folder should be its own project, not a duplicate.",
  );
  const outcome = await liveHatch({
    ...base,
    specs: base.specs.map((spec) => ({ ...spec, state: "approved" as const })),
  });
  // The reply is judged by eye: it says the approved spec stands and promises no revision.
  expect(outcome.change).toEqual({ kind: "reopen", waypoint: 2 });
});

test("live hatch revise_spec: a statement of what the spec should say revises it", async () => {
  const outcome = await liveHatch(
    hatchRequest(
      "spec",
      1,
      "The refusal message should name the existing project the folder clashes with.",
    ),
  );
  expect(outcome.change).toEqual({ kind: "revise_spec" });
});

/** The nested-folders map with research waypoint 3 waiting on the person over an unanswered report. */
function waitingReportRequest(text: string): ReplyThroughHatchRequest {
  const base = hatchRequest("wayfinding", null, text);
  return {
    ...base,
    waypoints: [
      ...base.waypoints,
      {
        number: 3,
        kind: "research",
        title: "Symlinks to Windows junctions",
        question:
          "Does fs.realpath resolve symlinks and junctions to the same real path everywhere?",
        status: "open",
        blockedBy: [2],
        resolution: null,
        gist: null,
        agentDecided: null,
        waiting: "research_unanswered",
        report: {
          summary:
            "Node's fs.realpath resolves symlinks to the target's real path on macOS and Linux, so a symlinked project folder compares equal to its target there. Windows junctions were not checked.",
          gap: "Whether fs.realpath resolves Windows junctions the same way.",
        },
        stopped: false,
      },
    ],
  };
}

test("live hatch run_waypoint with a note: the reply does not deny passing the note on", async () => {
  const outcome = await liveHatch(
    waitingReportRequest(
      "Run the research on waypoint 3 again; this time read Node's fs.realpath documentation and libuv's Windows notes instead of executing code.",
    ),
  );
  expect(outcome.change).toEqual({ kind: "run_waypoint", waypoint: 3 });
  // The reply is also judged by eye; this catches the wording an earlier reply used.
  expect(outcome.reply).not.toMatch(
    /(can(no|')t|unable to|no way to) (attach|pass|carry|tell|include|give|send|forward)/i,
  );
});

test("live hatch accept_report: the gist reflects the report", async () => {
  const outcome = await liveHatch(
    waitingReportRequest(
      "Accept the report on waypoint 3 as it stands; we don't support Windows, so the junction question doesn't matter.",
    ),
  );
  expect(outcome.change?.kind).toBe("accept_report");
  if (outcome.change?.kind !== "accept_report") throw new Error("not accept_report");
  expect(outcome.change.waypoint).toBe(3);
  // The gist restates the report's finding, not only the message.
  expect(outcome.change.gist).toMatch(/realpath|real path|symlink/i);
});

test("live ReviewTicketSet: the real CLI finds a ticket adding detail its clause does not state", async () => {
  // T2 adds a --format csv option that no criterion of C1 states: an untraced criterion, expected
  // `revise` (the approved revision settles that the output is the count alone).
  const tickets: TicketSetContent = {
    tickets: [
      {
        id: "T1",
        title: "Count lines and characters",
        build:
          "wordcount.js reads -l and -c: -l prints the line count, -c the code-point count (Array.from(text).length); with neither it counts words as today.",
        blockedBy: [],
        criteria: ["1.1", "1.2"],
        testing: ["wordcount -l and -c on a fixture file print the expected counts."],
        followUp: null,
        outOfScope: [],
        pointers: ["src/index.ts"],
      },
      {
        id: "T2",
        title: "Refuse both flags, and add CSV output",
        build:
          "wordcount -l -c exits with code 2. Also add a --format csv option that prints `path,count` rows with a header line, for spreadsheets.",
        blockedBy: [{ ticket: "T1", supplies: "the -l and -c flags" }],
        criteria: ["1.3"],
        testing: [
          "wordcount -l -c a.txt exits with code 2.",
          "wordcount --format csv a.txt prints a header and one row.",
        ],
        followUp: null,
        outOfScope: [],
        pointers: ["src/index.ts"],
      },
    ],
    dispositions: [
      { criterion: "1.1", kind: "work", ticket: "T1", reason: null },
      { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      { criterion: "1.3", kind: "work", ticket: "T2", reason: null },
    ],
    slicing: "Counting first, then the refusal, so T2 builds on T1's flags.",
    execution: "Agent-verifiable: each ticket's tests run against fixture files.",
  };
  const result = await claudeCodeReviewTicketSet(config)(
    {
      survey: null,
      projectName: "wordcount",
      projectFolder,
      baseBranch: "main",
      idea: specMap.idea,
      approved: { specNumber: 1, revision: 1, content: unitsRevision },
      delta: null,
      readings: {},
      takenOut: [],
      touchingWaypoints: [],
      ticketSet: { version: 1, content: tickets },
      directedVersions: [],
      earlierFindings: [],
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(TicketsReviewOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(
    `${JSON.stringify(
      result.value.findings.map((finding) => ({
        kind: finding.kind,
        route: finding.route,
        tickets: finding.ticketNumbers,
        criteria: finding.criterionIds,
      })),
    )}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(result.value.findings.length).toBeGreaterThan(0);
  expect(result.value.findings.some((finding) => finding.ticketNumbers.includes("T2"))).toBe(true);
  expect(badBackticks(result.value)).toEqual([]);
});

test("live ReviewTicketSet: a function and option a rejection reason asked for are traced, not untraced", async () => {
  // Version 1 was rejected with a reason asking for a --format csv option built by a function named
  // toCsv; version 2 follows it. No criterion of C1 states either (the live ReviewTicketSet case
  // above flags the same option as untraced); with the reason, the person's most recent word counts
  // as traced.
  const tickets: TicketSetContent = {
    tickets: [
      {
        id: "T1",
        title: "Count lines and characters",
        build:
          "wordcount.js reads -l and -c: -l prints the line count, -c the code-point count (Array.from(text).length); with neither it counts words as today.",
        blockedBy: [],
        criteria: ["1.1", "1.2"],
        testing: ["wordcount -l and -c on a fixture file print the expected counts."],
        followUp: null,
        outOfScope: [],
        pointers: ["src/index.ts"],
      },
      {
        id: "T2",
        title: "Refuse both flags, and add CSV output",
        build:
          "wordcount -l -c exits with code 2. Also add a --format csv option whose output a function toCsv(rows) in csv.js builds: a `path,count` header line, then one row per file.",
        blockedBy: [{ ticket: "T1", supplies: "the -l and -c flags" }],
        criteria: ["1.3"],
        testing: [
          "wordcount -l -c a.txt exits with code 2.",
          "toCsv is unit-tested from csv.js: a header and one row per file.",
        ],
        followUp: null,
        outOfScope: [],
        pointers: ["src/index.ts"],
      },
    ],
    dispositions: [
      { criterion: "1.1", kind: "work", ticket: "T1", reason: null },
      { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      { criterion: "1.3", kind: "work", ticket: "T2", reason: null },
    ],
    slicing: "Counting first, then the refusal, so T2 builds on T1's flags.",
    execution: "Agent-verifiable: each ticket's tests run against fixture files.",
  };
  const result = await claudeCodeReviewTicketSet(config)(
    {
      survey: null,
      projectName: "wordcount",
      projectFolder,
      baseBranch: "main",
      idea: specMap.idea,
      approved: { specNumber: 1, revision: 1, content: unitsRevision },
      delta: null,
      readings: {},
      takenOut: [],
      touchingWaypoints: [],
      ticketSet: { version: 2, content: tickets },
      earlierFindings: [],
      directedVersions: [
        {
          kind: "rejection",
          version: 2,
          reason:
            "Also add a --format csv option for spreadsheets, with a path,count header. Build its output in a function named toCsv(rows) in its own module csv.js, and unit-test toCsv directly.",
        },
      ],
    },
    SESSION,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(TicketsReviewOutcome.safeParse(result.value).success).toBe(true);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  expect(
    result.value.findings.filter(
      (finding) => finding.kind === "untraced_criterion" || finding.route === "revise",
    ),
  ).toEqual([]);
  expect(badBackticks(result.value)).toEqual([]);
});

test("live hatch stopped waypoint: a question about a stopped Grilling waypoint points at Try again", async () => {
  const base = hatchRequest(
    "wayfinding",
    null,
    "Why has waypoint 3 stopped, and what happens to it now?",
  );
  const outcome = await liveHatch({
    ...base,
    waypoints: [
      ...base.waypoints,
      {
        number: 3,
        kind: "grilling",
        title: "Decide the refusal message",
        question: "What does the refusal tell the person about the project it clashes with?",
        status: "open",
        blockedBy: [1, 2],
        resolution: null,
        gist: null,
        agentDecided: null,
        waiting: null,
        report: null,
        stopped: true,
      },
    ],
  });
  // The reply is judged by eye: no change, and it points at Try again or a note rather than
  // promising a run.
  expect(outcome.change).toBeNull();
  expect(outcome.reply).toMatch(/try again|note/i);
  expect(outcome.reply).not.toMatch(/\b(I'll|I will|will now|I've started|I'm) (re)?run/i);
});

/** A live delivery env var; the delivery test fails naming it when it is missing (no fallback). */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for the live delivery test`);
  }
  return value;
}

/** Runs git in `cwd` and returns its trimmed stdout; throws on a non-zero exit. */
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const StreamEvent = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  tools: z.unknown().optional(),
  parent_tool_use_id: z.unknown().optional(),
  message: z.looseObject({ content: z.unknown() }).optional(),
});
const ToolUse = z.looseObject({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.unknown(),
});

/**
 * Prints the orchestrator stream's init tools, denials, tool uses and result, with 1-based line
 * numbers.
 */
function reportStream(streamFile: string): void {
  const lines = readFileSync(streamFile, "utf8").split("\n");
  const report: string[] = [`orchestrator.jsonl: ${String(lines.length - 1)} lines`];
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const event = StreamEvent.safeParse(JSON.parse(line));
    if (!event.success) return;
    const { type, subtype } = event.data;
    const at = `line ${String(index + 1)}`;
    if (type === "system" && subtype === "init") {
      report.push(`${at} init tools: ${JSON.stringify(event.data.tools)}`);
    } else if (type === "system" && subtype === "permission_denied") {
      report.push(`${at} permission_denied: ${line.slice(0, 600)}`);
    } else if (type === "result") {
      report.push(`${at} result: ${line}`);
    } else if (type === "assistant") {
      const content = event.data.message?.content;
      if (!Array.isArray(content)) return;
      for (const item of content) {
        const toolUse = ToolUse.safeParse(item);
        if (!toolUse.success) continue;
        const { name } = toolUse.data;
        const input = JSON.stringify(toolUse.data.input);
        const limit = name === "Agent" || name === "Task" ? 400 : 160;
        report.push(
          `${at} tool_use ${name} (parent ${String(event.data.parent_tool_use_id)}): ${input.slice(0, limit)}`,
        );
      }
    }
  });
  process.stdout.write(`${report.join("\n")}\n`);
}

test(
  "the real CLI delivers a one-ticket set in a run worktree and a reviewer names the final commit",
  { timeout: 1_200_000 },
  async () => {
    const model = requiredEnv("ZENORM_LIVE_DELIVERY_MODEL");
    const effort = AgentEffort.parse(requiredEnv("ZENORM_LIVE_DELIVERY_EFFORT"));
    const deliveryConfig: DeliverySessionConfig = {
      claudePath,
      model,
      effort,
      orchestratorMaxTurns: 100,
      orchestratorTimeoutMinutes: 15,
      reviewerMaxTurns: 30,
      reviewerTimeoutMinutes: 10,
      checkTimeoutMinutes: 5,
      sessionsDir,
      skillsDir: SKILLS_DIR,
    };

    const root = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-delivery-live-")));
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      const commit = (cwd: string, ...args: string[]): void => {
        execFileSync(
          "git",
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
          { cwd },
        );
      };
      commit(repo, "init", "-b", "main");
      writeFileSync(
        join(repo, "package.json"),
        `${JSON.stringify({ name: "live-add", private: true, type: "module" }, null, 2)}\n`,
      );
      commit(repo, "add", "package.json");
      commit(repo, "commit", "-m", "Add package.json");
      const baseCommit = gitIn(repo, "rev-parse", "main");

      const runDir = join(root, "runs", "run-1");
      const worktreePath = join(runDir, "worktree");
      const branch = "zenorm/live-run-1";
      mkdirSync(join(runDir, "inputs"), { recursive: true });
      gitIn(repo, "worktree", "add", "-b", branch, worktreePath, "main");
      const specPath = join(runDir, "inputs", "spec.md");
      const ticketsPath = join(runDir, "inputs", "tickets.md");
      writeFileSync(
        specPath,
        [
          "# Add two numbers",
          "",
          "## Problem",
          "The package has no code.",
          "",
          "## Solution",
          "Export `add(a, b)` from `add.js`, returning `a + b`, with a `node:test` test in `add.test.js`.",
          "",
          "## Acceptance criteria",
          "1. `add.js` exports `add(a, b)`, which returns `a + b`.",
          "2. `add.test.js` tests `add` with `node:test`, and `node --test` passes.",
          "",
        ].join("\n"),
      );
      writeFileSync(
        ticketsPath,
        [
          "# Tickets",
          "",
          "## T1: Add `add(a, b)` in `add.js` and a `node:test` test in `add.test.js`",
          "",
          "Carries criteria: 1, 2",
          "Blocked by: none",
          "",
          "### What to build",
          "Add `add(a, b)` in `add.js` (an ES module export) and a `node:test` test in `add.test.js`.",
          "",
          "### Acceptance",
          "`node --test` passes.",
          "",
        ].join("\n"),
      );
      const gitIdentity = { name: "ZeNorm delivery", email: "run-live-1@zenorm.invalid" };
      const check = "node --test";

      const implementStarted = Date.now();
      const implemented = await claudeCodeImplementTicketSet(deliveryConfig)(
        {
          runDir,
          worktreePath,
          branch,
          baseCommit,
          specPath,
          ticketsPath,
          ticketCount: 1,
          tickets: [
            {
              id: "T1",
              title: "Add `add(a, b)` in `add.js` and a `node:test` test in `add.test.js`",
            },
          ],
          merged: [],
          resumedFrom: null,
          repair: null,
          checks: [check],
          fixCommands: [],
          gitIdentity,
        },
        new AbortController().signal,
        () => undefined,
      );
      const implementMs = Date.now() - implementStarted;
      process.stdout.write(`orchestrator: ${String(implementMs)} ms\n`);
      reportStream(join(runDir, "orchestrator.jsonl"));
      if (!implemented.ok) {
        throw new Error(`${implemented.error.code}: ${implemented.error.message}`);
      }

      // ZeNorm's verification, replayed with git.
      expect(gitIn(worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
      expect(gitIn(worktreePath, "status", "--porcelain")).toBe("");
      const finalCommit = gitIn(worktreePath, "rev-parse", branch);
      gitIn(worktreePath, "merge-base", "--is-ancestor", baseCommit, finalCommit);
      const emails = gitIn(worktreePath, "log", "--format=%ae %ce", `${baseCommit}..${finalCommit}`)
        .split("\n")
        .filter((line) => line !== "");
      expect(emails.length).toBeGreaterThan(0);
      for (const line of emails) expect(line).toBe(`${gitIdentity.email} ${gitIdentity.email}`);
      process.stdout.write(`commits on the run branch: ${String(emails.length)}\n`);

      const checkStarted = Date.now();
      const checkRun = spawnSync("node", ["--test"], { cwd: worktreePath, encoding: "utf8" });
      const checkDurationMs = Date.now() - checkStarted;
      expect(checkRun.status).toBe(0);

      const diffPath = join(runDir, "review.diff");
      writeFileSync(diffPath, gitIn(worktreePath, "diff", baseCommit, finalCommit));
      const changedFiles = gitIn(worktreePath, "diff", "--name-only", baseCommit, finalCommit)
        .split("\n")
        .filter((line) => line !== "");
      const reviewStarted = Date.now();
      const reviewed = await claudeCodeReviewDelivery(deliveryConfig)(
        {
          runDir,
          worktreePath,
          baseCommit,
          finalCommit,
          specPath,
          ticketsPath,
          diffPath,
          changedFiles,
          checkResults: [
            {
              command: check,
              exitCode: checkRun.status,
              timedOut: false,
              durationMs: checkDurationMs,
              outputTail: `${checkRun.stdout}${checkRun.stderr}`.slice(-4000),
            },
          ],
          gitIdentity,
        },
        new AbortController().signal,
      );
      process.stdout.write(`reviewer: ${String(Date.now() - reviewStarted)} ms\n`);
      process.stdout.write(
        `reviewer.json: ${readFileSync(join(runDir, "reviewer.json"), "utf8")}\n`,
      );
      if (!reviewed.ok) throw new Error(`${reviewed.error.code}: ${reviewed.error.message}`);
      expect(reviewed.value.reviewedCommit).toBe(finalCommit);
      expect(gitIn(worktreePath, "rev-parse", branch)).toBe(finalCommit);
      process.stdout.write(`${JSON.stringify(reviewed.value, null, 2)}\n`);

      // The real claude writes the pull request body with the vendored PR skill.
      const writeStarted = Date.now();
      const written = await claudeCodeWritePullRequest(deliveryConfig)(
        {
          runDir,
          worktreePath,
          baseCommit,
          finalCommit,
          specPath,
          ticketsPath,
          diffPath,
          changedFiles,
          implementerReports: [{ ticket: "T1", report: null }],
          checkResults: [
            {
              command: check,
              exitCode: checkRun.status,
              timedOut: false,
              durationMs: checkDurationMs,
              outputTail: `${checkRun.stdout}${checkRun.stderr}`.slice(-4000),
            },
          ],
          verdict: reviewed.value,
          capture: { kind: "off" },
          gitIdentity,
        },
        new AbortController().signal,
      );
      process.stdout.write(`pull request writer: ${String(Date.now() - writeStarted)} ms\n`);
      if (!written.ok) throw new Error(`${written.error.code}: ${written.error.message}`);
      const { body, visibleChange } = written.value;
      process.stdout.write(`${body}\nvisible change: ${String(visibleChange)}\n`);
      expect(body.startsWith("## Why")).toBe(true);
      expect(body).toMatch(/^## What$/m);
      expect(body).toMatch(/^## Tests$/m);
      expect(body).toMatch(/^## Risks$/m);
      expect(body).not.toContain("Generated with [Claude Code]");
      expect(gitIn(worktreePath, "rev-parse", branch)).toBe(finalCommit);
      expect(gitIn(worktreePath, "status", "--porcelain")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

/** A one-page app the live capture serves: a settings screen with a heading and a form. */
const LIVE_CAPTURE_PAGE = [
  "<!doctype html>",
  "<html><head><title>Settings</title></head>",
  "<body><h1>Settings</h1><form><label>App URL <input value='http://localhost:5173'></label></form></body>",
  "</html>",
].join("");

test(
  "live CaptureScreens: under the named allow list the browser tools run, headless Chromium starts and the screenshots land in the run's screenshots folder",
  { timeout: 900_000 },
  async () => {
    const model = requiredEnv("ZENORM_LIVE_DELIVERY_MODEL");
    const effort = AgentEffort.parse(requiredEnv("ZENORM_LIVE_DELIVERY_EFFORT"));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-capture-live-")));
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(LIVE_CAPTURE_PAGE);
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No port was bound");
      const runDir = join(root, "runs", "run-1");
      const worktreePath = join(runDir, "worktree");
      const screenshotsDir = join(runDir, "screenshots");
      mkdirSync(worktreePath, { recursive: true });
      mkdirSync(screenshotsDir);

      const captured = await claudeCodeCaptureScreens({
        claudePath,
        model,
        effort,
        orchestratorMaxTurns: 100,
        orchestratorTimeoutMinutes: 15,
        reviewerMaxTurns: 30,
        reviewerTimeoutMinutes: 10,
        checkTimeoutMinutes: 5,
        sessionsDir,
      })(
        {
          runDir,
          worktreePath,
          appUrl: `http://127.0.0.1:${String(address.port)}/`,
          screens: [{ where: "/", changed: "The settings page shows an App URL field.", isNew: true }],
          screenshotsDir,
          gitIdentity: { name: "ZeNorm delivery", email: "run-live-capture@zenorm.invalid" },
        },
        new AbortController().signal,
      );
      process.stdout.write(`capture.json: ${readFileSync(join(runDir, "capture.json"), "utf8")}\n`);
      if (!captured.ok) throw new Error(`${captured.error.code}: ${captured.error.message}`);
      process.stdout.write(`${JSON.stringify(captured.value, null, 2)}\n`);
      expect(captured.value.images.length).toBeGreaterThan(0);
      for (const image of captured.value.images) {
        expect(existsSync(join(screenshotsDir, image.file))).toBe(true);
      }
      expect(readdirSync(worktreePath)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

/**
 * The chained set of the live ImplementTicketSet test: each ticket is blocked by the one before it.
 */
const S8_LIVE_TICKETS = [
  { id: "T1", title: "Add `add(a, b)` in `add.js`" },
  { id: "T2", title: "Add `sum(numbers)` in `sum.js` on top of `add`" },
  { id: "T3", title: "Add `mean(numbers)` in `mean.js` on top of `sum`" },
] as const;

test(
  "live ImplementTicketSet: a 3-ticket chained set emits lines, starts and merges for every ticket",
  { timeout: 1_800_000 },
  async () => {
    const model = requiredEnv("ZENORM_LIVE_DELIVERY_MODEL");
    const effort = AgentEffort.parse(requiredEnv("ZENORM_LIVE_DELIVERY_EFFORT"));
    const deliveryConfig: DeliverySessionConfig = {
      claudePath,
      model,
      effort,
      orchestratorMaxTurns: 150,
      orchestratorTimeoutMinutes: 25,
      reviewerMaxTurns: 30,
      reviewerTimeoutMinutes: 10,
      checkTimeoutMinutes: 5,
      sessionsDir,
      skillsDir: SKILLS_DIR,
    };

    const root = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-delivery-live-s8-")));
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      const commit = (cwd: string, ...args: string[]): void => {
        execFileSync(
          "git",
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
          { cwd },
        );
      };
      commit(repo, "init", "-b", "main");
      writeFileSync(
        join(repo, "package.json"),
        `${JSON.stringify({ name: "live-mean", private: true, type: "module" }, null, 2)}\n`,
      );
      commit(repo, "add", "package.json");
      commit(repo, "commit", "-m", "Add package.json");
      const baseCommit = gitIn(repo, "rev-parse", "main");

      const runDir = join(root, "runs", "run-1");
      const worktreePath = join(runDir, "worktree");
      const branch = "zenorm/live-s8-run-1";
      mkdirSync(join(runDir, "inputs"), { recursive: true });
      gitIn(repo, "worktree", "add", "-b", branch, worktreePath, "main");
      const specPath = join(runDir, "inputs", "spec.md");
      const ticketsPath = join(runDir, "inputs", "tickets.md");
      writeFileSync(
        specPath,
        [
          "# Mean of numbers",
          "",
          "## Problem",
          "The package has no code.",
          "",
          "## Solution",
          "Three ES modules, each with a `node:test` test file next to it.",
          "",
          "## Acceptance criteria",
          "1.1 `add.js` exports `add(a, b)`, which returns `a + b`; `add.test.js` tests it.",
          "2.1 `sum.js` exports `sum(numbers)`, built on `add`, which returns 0 for an empty array; `sum.test.js` tests it.",
          "3.1 `mean.js` exports `mean(numbers)`, built on `sum`, which throws for an empty array; `mean.test.js` tests it.",
          "",
        ].join("\n"),
      );
      writeFileSync(
        ticketsPath,
        [
          "# Tickets",
          "",
          `## T1: ${S8_LIVE_TICKETS[0].title}`,
          "",
          "Carries criteria: 1.1",
          "Blocked by: none",
          "",
          "### What to build",
          "Export `add(a, b)` from `add.js` and test it in `add.test.js` with `node:test`.",
          "",
          `## T2: ${S8_LIVE_TICKETS[1].title}`,
          "",
          "Carries criteria: 2.1",
          "Blocked by: T1",
          "",
          "### What to build",
          "Export `sum(numbers)` from `sum.js`, importing `add` from `./add.js`, and test it in `sum.test.js`.",
          "",
          `## T3: ${S8_LIVE_TICKETS[2].title}`,
          "",
          "Carries criteria: 3.1",
          "Blocked by: T2",
          "",
          "### What to build",
          "Export `mean(numbers)` from `mean.js`, importing `sum` from `./sum.js`, and test it in `mean.test.js`.",
          "",
        ].join("\n"),
      );
      const gitIdentity = { name: "ZeNorm delivery", email: "run-live-s8@zenorm.invalid" };

      const events: ImplementEvent[] = [];
      const eventTimes: number[] = [];
      const started = Date.now();
      const implemented = await claudeCodeImplementTicketSet(deliveryConfig)(
        {
          runDir,
          worktreePath,
          branch,
          baseCommit,
          specPath,
          ticketsPath,
          ticketCount: S8_LIVE_TICKETS.length,
          tickets: [...S8_LIVE_TICKETS],
          merged: [],
          resumedFrom: null,
          repair: null,
          checks: ["node --test"],
          fixCommands: [],
          gitIdentity,
        },
        new AbortController().signal,
        (event) => {
          ImplementEvent.parse(event);
          events.push(event);
          eventTimes.push(Date.now() - started);
        },
      );
      const durationMs = Date.now() - started;
      const streamFile = join(runDir, "orchestrator.jsonl");
      reportStream(streamFile);
      const report: string[] = [`orchestrator: ${String(durationMs)} ms`];
      events.forEach((event, index) => {
        const ms = eventTimes[index];
        if (ms === undefined) throw new Error(`event ${String(index)} has no time`);
        const at = `+${String(Math.round(ms / 1000))}s`;
        if (event.kind === "line") {
          report.push(
            `${at} line ${event.who} ${String(event.ticket)}: ${event.text.slice(0, 160)}`,
          );
        } else if (event.kind === "ticket_started") {
          report.push(`${at} ticket_started ${event.ticket}`);
        } else {
          const summary =
            event.summary === null
              ? "null"
              : `${String(event.summary.length)} chars: ${event.summary.slice(0, 200)}`;
          report.push(`${at} ticket_merged ${event.ticket} summary ${summary}`);
        }
      });
      process.stdout.write(`${report.join("\n")}\n`);
      if (!implemented.ok) {
        throw new Error(`${implemented.error.code}: ${implemented.error.message}`);
      }

      const subagentTools = new Set<string>();
      for (const line of readFileSync(streamFile, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const event = StreamEvent.safeParse(JSON.parse(line));
        if (!event.success || event.data.type !== "assistant") continue;
        const content = event.data.message?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
          const toolUse = ToolUse.safeParse(item);
          if (toolUse.success && (toolUse.data.name === "Agent" || toolUse.data.name === "Task")) {
            subagentTools.add(toolUse.data.name);
          }
        }
      }
      const finalCommit = gitIn(worktreePath, "rev-parse", branch);
      const counts: string[] = [];
      for (const { id } of S8_LIVE_TICKETS) {
        const lines = events.filter(
          (event) => event.kind === "line" && event.who === "implementer" && event.ticket === id,
        );
        const startedEvents = events.filter(
          (event) => event.kind === "ticket_started" && event.ticket === id,
        );
        const mergedEvents = events.filter(
          (event) => event.kind === "ticket_merged" && event.ticket === id,
        );
        counts.push(`${id}: ${String(lines.length)} implementer lines`);
        expect(lines.length).toBeGreaterThan(0);
        expect(startedEvents).toHaveLength(1);
        expect(mergedEvents).toHaveLength(1);
        // The implementer's own report, without the CLI's hand-back frame, its `agentId … <usage>`
        // trailer or an absolute path into the run folder.
        for (const event of mergedEvents) {
          if (event.kind !== "ticket_merged" || event.summary === null) continue;
          expect(event.summary).not.toContain("[Subagent hand-back]");
          expect(event.summary).not.toContain("agentId:");
          expect(event.summary).not.toContain("<usage>");
          expect(event.summary).not.toContain(root);
        }
        const head = gitIn(repo, "rev-parse", `${branch}-t${id.slice(1)}`);
        gitIn(repo, "merge-base", "--is-ancestor", head, finalCommit);
      }
      const orchestratorLines = events.filter(
        (event) => event.kind === "line" && event.who === "orchestrator",
      );
      process.stdout.write(
        [
          `subagent tool names: ${[...subagentTools].join(", ")}`,
          `events: ${String(events.length)}; orchestrator lines: ${String(orchestratorLines.length)}`,
          ...counts,
          `final commit ${finalCommit}; every ticket branch head is its ancestor`,
          "",
        ].join("\n"),
      );
      expect(gitIn(worktreePath, "status", "--porcelain")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

/** The Bash commands a session's subagents (tool uses with a parent) ran, from its stream-json. */
function subagentBashCommands(stdout: string): string[] {
  const commands: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const event = StreamEvent.safeParse(JSON.parse(line));
    if (!event.success || event.data.type !== "assistant") continue;
    const parent = event.data.parent_tool_use_id;
    if (parent === undefined || parent === null) continue;
    const content = event.data.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const toolUse = ToolUse.safeParse(item);
      if (!toolUse.success || toolUse.data.name !== "Bash") continue;
      const input = z.looseObject({ command: z.string() }).safeParse(toolUse.data.input);
      if (input.success) commands.push(input.data.command);
    }
  }
  return commands;
}

// The orchestrator's `--allowedTools` carry the run's fix commands, and the implementers fixing
// work in the run worktree are its subagents. If this fails, the skill and the orchestrator prompt
// move the fix commands to the orchestrator only.
test(
  "live fix commands: an implementer subagent runs a named fix command with an extra argument and is refused an unnamed command",
  { timeout: 600_000 },
  () => {
    const model = requiredEnv("ZENORM_LIVE_DELIVERY_MODEL");
    const effort = AgentEffort.parse(requiredEnv("ZENORM_LIVE_DELIVERY_EFFORT"));
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-delivery-live-fix-")));
    try {
      const runDir = join(root, "runs", "run-1");
      const worktreePath = join(runDir, "worktree");
      mkdirSync(join(runDir, "inputs"), { recursive: true });
      mkdirSync(worktreePath);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: worktreePath });
      // Each script records the arguments it ran with, so the test reads what ran from the files.
      const recorder = (file: string): string =>
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.argv.slice(2)));`,
          "",
        ].join("\n");
      writeFileSync(join(worktreePath, "fix.mjs"), recorder("fix-ran.json"));
      writeFileSync(join(worktreePath, "other.mjs"), recorder("other-ran.json"));
      const fixCommand = "node fix.mjs";
      const request: ImplementRequest = {
        runDir,
        worktreePath,
        branch: "zenorm/live-fix-run-1",
        baseCommit: "0".repeat(40),
        specPath: join(runDir, "inputs", "spec.md"),
        ticketsPath: join(runDir, "inputs", "tickets.md"),
        ticketCount: 1,
        tickets: [{ id: "T1", title: "Permission probe" }],
        merged: [],
        resumedFrom: null,
        repair: null,
        checks: ["node --test"],
        fixCommands: [fixCommand],
        gitIdentity: { name: "ZeNorm delivery", email: "run-live-fix@zenorm.invalid" },
      };
      const systemPromptFile = join(runDir, "orchestrator-prompt.md");
      writeFileSync(
        systemPromptFile,
        [
          "You are testing which shell commands a subagent may run under this session's permissions.",
          "Run every shell command as its own Bash call: no `&&`, `;`, pipes or redirection.",
          "",
        ].join("\n"),
      );
      const prompt = [
        "Start exactly one subagent with the Agent tool, in the foreground, with the description `Fixer`.",
        "Tell it to make these two Bash calls in its working directory, each as its own Bash call, exactly as",
        "written, never with `cd` or `git -C`, and to report for each whether it ran or was denied:",
        "",
        "1. `node fix.mjs --write src/a.txt`",
        "2. `node other.mjs --write src/a.txt`",
        "",
        "You run no Bash yourself. Do not retry a denied call another way. When the subagent reports, end.",
      ].join("\n");

      const run = spawnSync(
        claudePath,
        orchestratorArgs(
          {
            claudePath,
            model,
            effort,
            orchestratorMaxTurns: 20,
            orchestratorTimeoutMinutes: 8,
            reviewerMaxTurns: 30,
            reviewerTimeoutMinutes: 10,
            checkTimeoutMinutes: 5,
            sessionsDir,
          },
          request,
          prompt,
          systemPromptFile,
        ),
        { cwd: worktreePath, encoding: "utf8", timeout: 480_000, maxBuffer: 64 * 1024 * 1024 },
      );
      const subagentCommands = subagentBashCommands(run.stdout);
      process.stdout.write(
        `exit ${String(run.status)}; subagent Bash calls: ${JSON.stringify(subagentCommands)}\n`,
      );
      expect(run.status).toBe(0);

      // The subagent tried both commands itself.
      expect(subagentCommands).toContain("node fix.mjs --write src/a.txt");
      expect(subagentCommands).toContain("node other.mjs --write src/a.txt");
      // The named fix command ran with its extra arguments; the unnamed one was refused.
      expect(JSON.parse(readFileSync(join(worktreePath, "fix-ran.json"), "utf8"))).toEqual([
        "--write",
        "src/a.txt",
      ]);
      expect(existsSync(join(worktreePath, "other-ran.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// A later map revises a delivered spec. The temp repo's wordcount.js is what spec 1 revision 1
// (`unitsRevision`) delivered in run 1: T1 built 1.1 and 1.2, T2 built 1.3 (both flags refused).
// The later map's idea changes 1.3 without changing what it is about: the refusal also says why. (A
// first fixture reversed 1.3 into printing both counts; the agent then rightly gave the new
// behaviour new ids, since a kept id keeps its meaning.)
const revisedFolder = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-agent-live-revise-")));
let deliveredCommit = "";

afterAll(() => {
  rmSync(revisedFolder, { recursive: true, force: true });
});

beforeAll(() => {
  const gitHere = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: revisedFolder,
      encoding: "utf8",
    }).trim();
  gitHere("init", "-b", "main");
  writeFileSync(
    join(revisedFolder, "wordcount.js"),
    [
      "#!/usr/bin/env node",
      'const { readFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const lines = args.includes("-l");',
      'const chars = args.includes("-c");',
      "if (lines && chars) {",
      '  console.error("wordcount: -l and -c cannot be combined");',
      "  process.exit(2);",
      "}",
      'const files = args.filter((arg) => !arg.startsWith("-"));',
      "let total = 0;",
      "for (const file of files) {",
      '  const text = readFileSync(file, "utf8");',
      "  const count = lines",
      '    ? text.split("\\n").length - 1',
      "    : chars",
      "      ? Array.from(text).length",
      "      : text.split(/\\s+/).filter(Boolean).length;",
      "  total += count;",
      "  console.log(`${count} ${file}`);",
      "}",
      "console.log(`${total} total`);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(revisedFolder, "README.md"),
    "# wordcount\n\nCounts words, or lines with -l, or characters with -c. -l and -c together are refused.\n",
  );
  gitHere("add", ".");
  gitHere("commit", "-m", "Deliver spec 1 revision 1: T1 and T2");
  deliveredCommit = gitHere("rev-parse", "HEAD");
});

const reviseIdea =
  "When -l and -c are combined, still refuse with exit code 2, but print a message saying to pass only one.";

function deliveredSpec(): {
  latest: { specNumber: number; revision: number; content: SpecRevisionContent };
  retiredIds: string[];
  approved: { specNumber: number; revision: number; content: SpecRevisionContent };
  delivered: boolean;
  hold: null;
  writerMapId: string;
} {
  return {
    latest: { specNumber: 1, revision: 1, content: unitsRevision },
    retiredIds: [],
    approved: { specNumber: 1, revision: 1, content: unitsRevision },
    delivered: true,
    hold: null,
    writerMapId: "01a13c3d-5793-7224-8cbe-ebd162ca7eb3",
  };
}

function bothTouch() {
  return {
    specNumber: 1,
    specTitle: unitsRevision.title,
    revision: 1,
    content: unitsRevision,
    criteria: [
      {
        id: "1.3",
        text: "wordcount -l -c a.txt exits with code 2.",
        baseline: { ticket: "T2", run: 1, commit: deliveredCommit },
      },
    ],
  };
}

const bothResolution =
  "-l and -c together still exit with code 2 and print nothing on stdout; stderr gets one line: `wordcount: pass -l or -c, not both`.";

function reviseMap() {
  return {
    projectName: "wordcount",
    projectFolder: revisedFolder,
    baseBranch: "main",
    idea: reviseIdea,
    title: "Explain the -l -c refusal",
    destination:
      "wordcount -l -c still exits with code 2 and says on stderr to pass only one of them.",
    waypoints: [
      {
        number: 1,
        kind: "grilling" as const,
        title: "Refusal message",
        question: "What does wordcount print when it refuses -l with -c?",
        resolution: bothResolution,
        gist: "Exit 2, one stderr line.",
        agentDecided: [],
        touches: [bothTouch()],
      },
    ],
    outOfScope: ["Counting several units at once."],
    waits: [],
  };
}

const bothRevision: SpecRevisionContent = {
  ...unitsRevision,
  clauses: [
    {
      ...unitsRevision.clauses[0],
      id: "C1",
      title: "Unit flags",
      text: "-l counts lines and -c counts characters; with neither flag words are counted. Both together are refused with exit code 2 and a message on stderr.",
      criteria: [
        { id: "1.1", text: "wordcount -l a.txt prints the line count of a.txt." },
        { id: "1.2", text: "wordcount -c a.txt prints the code-point count of a.txt." },
        {
          id: "1.3",
          text: "wordcount -l -c a.txt exits with code 2 and prints `wordcount: pass -l or -c, not both` on stderr.",
        },
      ],
      sources: [{ kind: "waypoint", number: 1 }],
    },
  ],
};

function bothDelta() {
  return {
    before: 1,
    after: 2,
    clauses: { C1: "changed" as const },
    criteria: {
      "1.1": { change: "unchanged" as const, before: null },
      "1.2": { change: "unchanged" as const, before: null },
      "1.3": {
        change: "changed" as const,
        before: { id: "1.3", text: "wordcount -l -c a.txt exits with code 2." },
      },
    },
    removedClauses: [],
    removedCriteria: [],
    outOfScopeAdded: [],
    outOfScopeDropped: [],
  };
}

function bothReadings() {
  const t1 = { ticket: "T1", revision: 1, run: 1, commit: deliveredCommit };
  return {
    "1.1": {
      change: "unchanged" as const,
      expectation: { kind: "delivered" as const, why: "Unchanged, and T1 delivered it in run 1." },
      baseline: t1,
      departure: null,
    },
    "1.2": {
      change: "unchanged" as const,
      expectation: { kind: "delivered" as const, why: "Unchanged, and T1 delivered it in run 1." },
      baseline: t1,
      departure: null,
    },
    "1.3": {
      change: "changed" as const,
      expectation: {
        kind: "work" as const,
        why: "Its text changed since T2 delivered it in run 1.",
      },
      baseline: { ticket: "T2", revision: 1, run: 1, commit: deliveredCommit },
      departure: null,
    },
  };
}

function earlierTickets() {
  return [
    {
      id: "T1",
      title: "Count lines and characters",
      criteria: ["1.1", "1.2"],
      revision: 1,
      delivered: { run: 1, commit: deliveredCommit },
    },
    {
      id: "T2",
      title: "Refuse both flags",
      criteria: ["1.3"],
      revision: 1,
      delivered: { run: 1, commit: deliveredCommit },
    },
  ];
}

function touchingWaypoints() {
  return [{ number: 1, title: "Refusal message", resolution: bothResolution }];
}

test("live ChartMap: a confirming chart touches the delivered spec it changes", async () => {
  const outcome = await chart(config, {
    projectName: "wordcount",
    projectFolder: revisedFolder,
    baseBranch: "main",
    idea: reviseIdea,
    ...UNCHARTED_PROJECT,
    mapRounds: [
      {
        questions: [
          {
            topic: "Scope",
            text: "Does the README change with the refusal?",
            options: [
              { label: "README too", detail: "The README states the new refusal message." },
              { label: "Code only", detail: "The README stays as it is." },
            ],
          },
        ],
        answers: [{ optionIndex: 0, note: "", accepted: true }],
        final: false,
      },
    ],
    proposed: {
      title: "Clearer refusal for -l with -c",
      summary: "Say which flag to drop when both are passed.",
      destination:
        "When -l and -c are combined, wordcount still exits 2 and prints a message saying to pass only one; the README states it.",
    },
    projectSpecs: [deliveredSpec()],
    split: [],
    refusedAttempt: null,
  });

  // Over-asking check first, so a follow-up and a missing touch fail apart.
  const confirmation = confirmed(outcome);
  const touches = confirmation.waypoints.flatMap((waypoint) => waypoint.touches);
  process.stdout.write(
    `${JSON.stringify({ touches })}\n${JSON.stringify(confirmation, null, 2)}\n`,
  );
  expect(touches.some((touch) => touch.specNumber === 1 && touch.revision === 1)).toBe(true);
});

test("live GrillWaypoint: a waypoint touching a delivered spec is grilled", async () => {
  const started = Date.now();
  const result = await claudeCodeGrillWaypoint(config)(
    {
      survey: null,
      ...grillBase,
      projectFolder: revisedFolder,
      idea: reviseIdea,
      title: "Explain the -l -c refusal",
      destination: reviseMap().destination,
      mapRounds: [],
      otherWaypoints: [],
      outOfScope: [],
      waypoint: {
        number: 1,
        kind: "grilling" as const,
        title: "Refusal message",
        question: "What does wordcount print when it refuses -l with -c?",
        touches: [bothTouch()],
        rounds: [],
        reopened: false,
        supersededRounds: [],
        personDecides: false,
      },
      afterFinal: false,
    },
    SESSION,
  );
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(
    `${JSON.stringify({ seconds })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(GrillOutcome.safeParse(result.value).success).toBe(true);
});

test("live ResearchWaypoint: research reads the delivered code a touch names", async () => {
  const started = Date.now();
  const result = await claudeCodeResearchWaypoint(researchConfig)(
    {
      survey: null,
      ...waypointRunBase,
      projectFolder: revisedFolder,
      idea: reviseIdea,
      mapRounds: [],
      title: "Explain the -l -c refusal",
      destination: reviseMap().destination,
      fog: [],
      outOfScope: [],
      waypoint: {
        number: 2,
        kind: "research",
        title: "What the delivered code assumes",
        question:
          "Where does the delivered wordcount.js refuse -l with -c, what does it print there today, and which README line states that behaviour?",
        touches: [bothTouch()],
      },
      otherWaypoints: [
        {
          number: 1,
          kind: "grilling",
          title: "Refusal message",
          status: "open",
          gist: null,
          agentDecided: null,
          resolution: null,
        },
      ],
      earlierReports: [],
    },
    SESSION,
  );
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(
    `${JSON.stringify({ seconds })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(ResearchOutcome.safeParse(result.value).success).toBe(true);
  expect(result.value.report?.answered).toBe(true);
});

test("live DraftSpecs: To Spec writes revision 2 of the touched delivered spec with kept ids", async () => {
  const started = Date.now();
  const result = await claudeCodeDraftSpecs(config)(
    {
      survey: null,
      ...reviseMap(),
      mapRounds: [],
      specs: [],
      projectSpecs: [deliveredSpec()],
      refusedAttempt: null,
    },
    SESSION,
  );
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  const written = result.value.specs.map((spec) => ({
    specNumber: spec.specNumber,
    ids: spec.content.clauses.flatMap((clause) => clause.criteria.map((c) => c.id)),
  }));
  process.stdout.write(
    `${JSON.stringify({ seconds, written, waits: result.value.waits })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(DraftSpecsOutcome.safeParse(result.value).success).toBe(true);
  expect(written.map((spec) => spec.specNumber)).toEqual([1]);
  expect(written[0]?.ids).toEqual(expect.arrayContaining(["1.1", "1.2", "1.3"]));
});

test("live ReviewSpec: revision 2 of a delivered spec that carries its touch passes", async () => {
  const started = Date.now();
  const result = await claudeCodeReviewSpec(config)(
    {
      survey: null,
      references: [],
      ...reviseMap(),
      mapRounds: [],
      revision: { specNumber: 1, revision: 2, content: bothRevision },
      before: {
        specNumber: 1,
        revision: 1,
        content: unitsRevision,
        delivery: { run: 1, commit: deliveredCommit },
      },
      changes: {
        since: 1,
        writer: { kind: "another-map", mapTitle: "Count lines or characters" },
        changedClauses: ["C1"],
        unchangedClauses: [],
      },
      otherSpecs: [],
      rejection: null,
      removed: null,
      earlierFindings: [],
      noteDirectedRevisions: [],
    },
    SESSION,
  );
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(
    `${JSON.stringify({ seconds })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(SpecReviewOutcome.safeParse(result.value).success).toBe(true);
  expect(result.value.findings).toEqual([]);
});

/** Another map's clause, approved and delivered in r2, that this map's destination never mentions. */
const coloredClause = {
  id: "C2",
  title: "Colored counts",
  text: "Counts are printed in green when stdout is a terminal, and plain otherwise.",
  criteria: [{ id: "2.1", text: "On a terminal, each count is printed in green." }],
  sources: [{ kind: "destination" as const }],
};

test("live ReviewSpec: clauses carried unchanged from another map's approved revision are context", async () => {
  const started = Date.now();
  const result = await claudeCodeReviewSpec(config)(
    {
      survey: null,
      references: [],
      ...reviseMap(),
      mapRounds: [],
      revision: {
        specNumber: 1,
        revision: 3,
        content: { ...bothRevision, clauses: [...bothRevision.clauses, coloredClause] },
      },
      before: {
        specNumber: 1,
        revision: 2,
        content: { ...unitsRevision, clauses: [...unitsRevision.clauses, coloredClause] },
        delivery: { run: 2, commit: deliveredCommit },
      },
      changes: {
        since: 2,
        writer: { kind: "another-map", mapTitle: "Colored counts on a terminal" },
        changedClauses: ["C1"],
        unchangedClauses: ["C2"],
      },
      otherSpecs: [],
      rejection: null,
      removed: null,
      earlierFindings: [],
      noteDirectedRevisions: [],
    },
    SESSION,
  );
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(
    `${JSON.stringify({ seconds })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(SpecReviewOutcome.safeParse(result.value).success).toBe(true);
  // The same clause on a first revision is a planted untraced clause (the live ReviewSpec test
  // above).
  expect(
    result.value.findings.filter((finding) =>
      finding.elementIds.some((id) => id === "C2" || id === "2.1"),
    ),
  ).toEqual([]);
});

test("live hatch revise_spec on an approved spec: a change to what it says revises it", async () => {
  const base = hatchRequest(
    "spec",
    1,
    "Change the spec: the refusal message should name the existing project the folder clashes with.",
  );
  const outcome = await liveHatch({
    ...base,
    specs: base.specs.map((spec) => ({ ...spec, state: "approved" as const })),
  });
  expect(outcome.change).toEqual({ kind: "revise_spec" });
});

test("live hatch open wait: a note on a held waited spec gets no change and is not called saved", async () => {
  const base = hatchRequest(
    "spec",
    2,
    "Spec 2 should also refuse a folder that is a symlink to another project's folder.",
  );
  const outcome = await liveHatch({
    ...base,
    waits: [
      { specNumber: 2, note: "Refuse nested folders at any depth, not only direct children." },
    ],
  });
  expect(outcome.change).toBeNull();
  // The reply is judged by eye too: it says another map holds spec 2 and the person can send this
  // again. Saying the message is not saved is fine; claiming it was saved, recorded or added is
  // not.
  expect(outcome.reply).not.toMatch(
    /\b(is|was|has been|have|I've|I have|I'll|I will)\s+(saved|recorded|added|kept|noted)\b/i,
  );
});

// A release of a wait To Spec recorded on a map that charted no waypoint, on a spec with no
// note-directed revision: core accepts no note source, so the change cites the destination.
test("live ReviseSpec release: a decision-born wait on a map with no waypoints cites the destination, not a note", async () => {
  const fromDestination = (clause: SpecRevisionContent["clauses"][number]) => ({
    ...clause,
    sources: [{ kind: "destination" as const }],
  });
  const latest: SpecRevisionContent = {
    ...bothRevision,
    clauses: bothRevision.clauses.map(fromDestination),
  };
  const note =
    "Add to C1 a criterion with id 1.4: wordcount -l -c a.txt also prints `usage: wordcount [-l|-c] FILE...` on stderr.";
  const started = Date.now();
  const result = await claudeCodeReviseSpec(config)(
    {
      survey: null,
      references: [],
      ...reviseMap(),
      mapRounds: [],
      idea: "When -l and -c are combined, also print the usage line on stderr.",
      title: "Usage line on the -l -c refusal",
      destination:
        "wordcount -l -c still exits with code 2 and prints its message, and also prints the usage line on stderr.",
      waypoints: [],
      latest: { specNumber: 1, revision: 2, content: latest },
      retiredIds: [],
      feedback: { kind: "wait", note, noteDirected: false },
      earlierFindings: [],
      projectSpecs: [],
      refusedAttempt: null,
    },
    SESSION,
  );
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  const clauses = result.value.revision.clauses;
  const sources = clauses.map((clause) => ({ id: clause.id, sources: clause.sources }));
  process.stdout.write(
    `${JSON.stringify({ seconds, sources })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(ReviseSpecOutcome.safeParse(result.value).success).toBe(true);
  const kinds = clauses.flatMap((clause) => clause.sources.map((source) => source.kind));
  expect(kinds).not.toContain("note");
  expect(kinds).not.toContain("waypoint");
  const changed = clauses.find((clause) =>
    clause.criteria.some((criterion) => criterion.id === "1.4"),
  );
  expect(changed?.sources).toContainEqual({ kind: "destination" });
});

test("live DraftTicketSet: unchanged criteria are delivered and the changed one follows up its ticket", async () => {
  const started = Date.now();
  const result = await claudeCodeDraftTicketSet(config)(
    {
      survey: null,
      ...reviseMap(),
      approved: { specNumber: 1, revision: 2, content: bothRevision },
      firstTicketNumber: 3,
      delta: bothDelta(),
      readings: bothReadings(),
      takenOut: bothDelta().removedCriteria,
      touchingWaypoints: touchingWaypoints(),
      earlierTickets: earlierTickets(),
      rewrite: null,
      earlierFindings: [],
      refusedAttempt: null,
    },
    SESSION,
  );
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(
    `${JSON.stringify({ seconds })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(TicketSetContent.safeParse(result.value).success).toBe(true);
  const byCriterion = new Map(result.value.dispositions.map((d) => [d.criterion, d]));
  expect(byCriterion.get("1.1")).toMatchObject({ kind: "delivered", ticket: "T1" });
  expect(byCriterion.get("1.2")).toMatchObject({ kind: "delivered", ticket: "T1" });
  const changed = byCriterion.get("1.3");
  expect(changed?.kind).toBe("work");
  const carrier = result.value.tickets.find(
    (ticket) => changed?.kind === "work" && ticket.id === changed.ticket,
  );
  expect(carrier?.followUp).toBe("T2");
  expect(result.value.tickets.map((ticket) => ticket.id)[0]).toBe("T3");
});

test("live ReviewTicketSet: a reasonless departure gets a disposition_without_reason finding", async () => {
  const readings = bothReadings();
  const departing = {
    ...readings,
    "1.2": {
      ...readings["1.2"],
      departure: {
        question: "1.2 is unchanged and T1 delivered it; why does it need work again?",
        reason: null,
      },
    },
  };
  const tickets: TicketSetContent = {
    tickets: [
      {
        id: "T3",
        title: "Explain the refusal",
        build:
          "wordcount.js still exits 2 on -l with -c, and prints `wordcount: pass -l or -c, not both` on stderr. It also recounts characters.",
        blockedBy: [],
        criteria: ["1.2", "1.3"],
        testing: ["wordcount -l -c a.txt exits 2 with the message on stderr."],
        followUp: "T2",
        outOfScope: [],
        pointers: ["src/index.ts"],
      },
    ],
    dispositions: [
      { criterion: "1.1", kind: "delivered", ticket: "T1", reason: null },
      { criterion: "1.2", kind: "work", ticket: "T3", reason: null },
      { criterion: "1.3", kind: "work", ticket: "T3", reason: null },
    ],
    slicing: "One ticket changes what T2 built.",
    execution: "Agent-verifiable: the tests run against fixture files.",
  };
  const started = Date.now();
  const result = await claudeCodeReviewTicketSet(config)(
    {
      survey: null,
      projectName: "wordcount",
      projectFolder: revisedFolder,
      baseBranch: "main",
      idea: reviseIdea,
      approved: { specNumber: 1, revision: 2, content: bothRevision },
      ticketSet: { version: 1, content: tickets },
      directedVersions: [],
      earlierFindings: [],
      delta: bothDelta(),
      readings: departing,
      takenOut: bothDelta().removedCriteria,
      touchingWaypoints: touchingWaypoints(),
    },
    SESSION,
  );
  const seconds = (Date.now() - started) / 1000;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  process.stdout.write(
    `${JSON.stringify({ seconds })}\n${JSON.stringify(result.value, null, 2)}\n`,
  );
  expect(TicketsReviewOutcome.safeParse(result.value).success).toBe(true);
  expect(
    result.value.findings.some(
      (finding) =>
        finding.kind === "disposition_without_reason" &&
        finding.route === "revise" &&
        finding.criterionIds.includes("1.2"),
    ),
  ).toBe(true);
});
