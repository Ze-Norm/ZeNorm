import { SubmitAnswersInput } from "@zenorm/contracts";
import type { Project, ProposedMap } from "@zenorm/contracts";
import { mapExclusions, mapProposals, maps } from "@zenorm/db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { submitAnswers } from "./map.ts";
import { confirmProposal, dismissProposal } from "./map-proposals.ts";
import { recordChart } from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import {
  addProject,
  ANSWERS,
  closeTestContext,
  newMap,
  openTestContext,
  pendingMapRound,
  PROPOSAL,
  runningMapRun,
  runsOf,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;
let mapId: string;

beforeEach(async () => {
  context = await openTestContext("zenorm-split-");
  project = await addProject(context, "repo");
  mapId = await newMap(context, project, "Export data, import data and schedule exports");
});

afterEach(async () => {
  await closeTestContext(context);
});

const IMPORTS: ProposedMap = {
  title: "CSV imports",
  idea: "Import records from a CSV file.",
  line: "Imports are their own map.",
};

const SCHEDULES: ProposedMap = {
  title: "Nightly exports",
  idea: "Schedule exports every night.",
  line: "Scheduled exports are their own map.",
};

/** Records the running first chart's proposal with `split`. */
function proposeSplit(split: readonly ProposedMap[]) {
  return recordChart(context.user, context.db, runningMapRun(context, mapId).id, {
    kind: "proposal",
    proposal: { ...PROPOSAL, split: [...split] },
  });
}

function offers() {
  return context.db.select().from(mapProposals).all();
}

function offerId(title: string): string {
  const offer = offers().find((candidate) => candidate.title === title);
  if (offer === undefined) throw new Error(`No offer titled ${title}`);
  return offer.id;
}

function submitDestination() {
  return submitAnswers(
    context.user,
    context.db,
    SubmitAnswersInput.parse({ roundId: pendingMapRound(context, mapId), answers: ANSWERS }),
  );
}

describe("idea-phase split", () => {
  test("a first chart saves its split offers pending, beside the destination round", () => {
    expect(proposeSplit([IMPORTS, SCHEDULES]).ok).toBe(true);

    expect(
      offers().map(({ kind, title, idea, line, state }) => ({ kind, title, idea, line, state })),
    ).toEqual([
      { kind: "split", ...IMPORTS, state: "pending" },
      { kind: "split", ...SCHEDULES, state: "pending" },
    ]);
    expect(pendingMapRound(context, mapId)).toEqual(expect.any(String));
  });

  test("a split offer outside its bounds fails the chart agent_output_invalid and saves nothing", () => {
    const result = proposeSplit([{ ...IMPORTS, idea: " " }]);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    expect(offers()).toEqual([]);
    expect(
      context.db
        .select()
        .from(maps)
        .all()
        .map((map) => map.title),
    ).toEqual([null]);
  });

  test("the destination round is refused round_split_undecided until every offer is decided", async () => {
    proposeSplit([IMPORTS, SCHEDULES]);

    const refused = submitDestination();
    expect(refused.ok ? null : refused.error.code).toBe("round_split_undecided");

    const created = await confirmProposal(context.user, context.db, {
      proposalId: offerId(IMPORTS.title),
      idea: IMPORTS.idea,
    });
    expect(created.ok).toBe(true);
    const stillRefused = submitDestination();
    expect(stillRefused.ok ? null : stillRefused.error.code).toBe("round_split_undecided");

    expect(
      dismissProposal(context.user, context.db, { proposalId: offerId(SCHEDULES.title) }).ok,
    ).toBe(true);
    expect(submitDestination().ok).toBe(true);
  });

  test("creating an offer makes a map split from this one and saves its line, linked; dismissing one keeps its work here", async () => {
    proposeSplit([IMPORTS, SCHEDULES]);

    const created = await confirmProposal(context.user, context.db, {
      proposalId: offerId(IMPORTS.title),
      idea: IMPORTS.idea,
    });
    if (!created.ok) throw new Error(created.error.code);
    expect(created.value.map.splitFromMapId).toBe(mapId);
    expect(
      dismissProposal(context.user, context.db, { proposalId: offerId(SCHEDULES.title) }).ok,
    ).toBe(true);

    expect(
      context.db
        .select({ text: mapExclusions.text, splitMapId: mapExclusions.splitMapId })
        .from(mapExclusions)
        .all(),
    ).toEqual([{ text: IMPORTS.line, splitMapId: created.value.map.id }]);
  });

  test("the confirming chart's request carries each offer with the person's decision", async () => {
    proposeSplit([IMPORTS, SCHEDULES]);
    await confirmProposal(context.user, context.db, {
      proposalId: offerId(IMPORTS.title),
      idea: "Import records from a CSV file, by header.",
    });
    dismissProposal(context.user, context.db, { proposalId: offerId(SCHEDULES.title) });
    expect(submitDestination().ok).toBe(true);

    const chart = runsOf(context, mapId).find(
      (run) => run.purpose === "chart" && run.state === "running",
    );
    if (chart === undefined) throw new Error("No confirming chart is running");
    const work = await prepareRun(context.db, chart.id);
    if (!work.ok) throw new Error(work.error.code);
    if (work.value.purpose !== "chart") throw new Error(work.value.purpose);
    expect(work.value.request.split).toEqual([
      {
        title: IMPORTS.title,
        idea: "Import records from a CSV file, by header.",
        state: "confirmed",
      },
      { title: SCHEDULES.title, idea: SCHEDULES.idea, state: "dismissed" },
    ]);
  });

  test("an idea that fits one map offers no split, and its round is sent as before", () => {
    proposeSplit([]);

    expect(offers()).toEqual([]);
    expect(submitDestination().ok).toBe(true);
  });
});
