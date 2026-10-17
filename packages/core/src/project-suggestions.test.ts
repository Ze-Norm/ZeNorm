import type {
  ChartConfirmation,
  MapProposalKind,
  MapProposalState,
  Project,
  ProjectMapContext,
  ProjectProposalContext,
} from "@zenorm/contracts";
import { mapExclusions, mapProposals } from "@zenorm/db";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview, readProjectMaps } from "./map-overview.ts";
import { reachedStage } from "./map-status.ts";
import { recordChart } from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import type { RunWork } from "./run-work.ts";
import {
  addProject,
  answerDestination,
  closeTestContext,
  confirm,
  deliverableTicketSet,
  draftedSpec,
  grillingRun,
  insertHatchRun,
  insertMessage,
  insertRun,
  newMap,
  openTestContext,
  PROPOSAL,
  runningMapRun,
  runsOf,
  waypointOf,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import { readProjectProposals } from "./wayfinding-records.ts";

let context: TestContext;
let project: Project;

/** Research 1, Task 2 and Grilling 3, none blocked: each is claimed with a running run. */
const KINDS: ChartConfirmation = {
  title: "Fetch migration",
  summary: PROPOSAL.summary,
  destination: "Move the HTTP client to built-in fetch behind the proxy.",
  waypoints: [
    {
      kind: "research",
      title: "Proxy support",
      question: "Does built-in fetch honour the proxy variables?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "task",
      title: "Count the call sites",
      question: "How many files call the old client?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "grilling",
      title: "Migration order",
      question: "Which call sites move first?",
      blockedBy: [],
      touches: [],
    },
  ],
  fog: [],
  outOfScope: [],
  proposals: [],
};

/** The project's maps, oldest first, one on each reached stage but Tickets. */
interface ProjectMaps {
  /** An approved ticket set, delivery not started: Delivery. */
  readonly delivery: string;
  /** A drafted spec under review: Spec. */
  readonly spec: string;
  readonly specificationId: string;
  /** Charted with `KINDS`, its waypoints worked: Wayfinding. */
  readonly kinds: string;
  /** Its first chart running, no title yet: Idea. */
  readonly uncharted: string;
  /** A map of another project. */
  readonly elsewhere: string;
}

let projectMaps: ProjectMaps;

async function kindsMap(): Promise<string> {
  const mapId = await newMap(context, project, "Move to fetch");
  const recorded = recordChart(context.user, context.db, runningMapRun(context, mapId).id, {
    kind: "proposal",
    proposal: { ...PROPOSAL, title: "Fetch migration" },
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
  answerDestination(context, mapId);
  confirm(context, mapId, KINDS);
  return mapId;
}

/** The map's first run, which its stored proposals name as the run that proposed them. */
function firstRunOf(mapId: string): string {
  const [first] = runsOf(context, mapId);
  if (first === undefined) throw new Error(`Map ${mapId} has no run`);
  return first.id;
}

/** Inserts one stored proposal; exactly one of `line`, `waypointId` and `exclusionPosition` is set. */
function insertProposal(proposal: {
  mapId: string;
  kind: MapProposalKind;
  title: string;
  line: string | null;
  waypointId: string | null;
  exclusionPosition: number | null;
  state: MapProposalState;
  newMapId: string | null;
  createdAt: string;
}): void {
  writeTestData(context, (tx) =>
    tx
      .insert(mapProposals)
      .values({
        id: uuidv7(),
        mapId: proposal.mapId,
        kind: proposal.kind,
        title: proposal.title,
        idea: `${proposal.title}, as its own map.`,
        line: proposal.line,
        waypointId: proposal.waypointId,
        exclusionPosition: proposal.exclusionPosition,
        state: proposal.state,
        newMapId: proposal.newMapId,
        createdByRun: firstRunOf(proposal.mapId),
        createdAt: proposal.createdAt,
        decidedAt: proposal.state === "pending" ? null : proposal.createdAt,
      })
      .run(),
  );
}

beforeEach(async () => {
  context = await openTestContext("zenorm-project-suggestions-");
  project = await addProject(context, "repo");
  const other = await addProject(context, "other");
  const delivery = (await deliverableTicketSet(context, project)).mapId;
  const drafted = await draftedSpec(context, project);
  const kinds = await kindsMap();
  const uncharted = await newMap(context, project, "Import data");
  const elsewhere = await newMap(context, other, "Elsewhere");
  projectMaps = {
    delivery,
    spec: drafted.mapId,
    specificationId: drafted.specificationId,
    kinds,
    uncharted,
    elsewhere,
  };

  // An existing Out of scope line on the delivered map, for a suggestion that splits it off.
  writeTestData(context, (tx) =>
    tx
      .insert(mapExclusions)
      .values({
        mapId: delivery,
        position: 1,
        text: "Export logs are left out.",
        waypointId: null,
        createdByRun: firstRunOf(delivery),
        splitMapId: null,
      })
      .run(),
  );
  // Inserted out of order: the reader orders them by when they were proposed.
  insertProposal({
    mapId: kinds,
    kind: "outside",
    title: "Retire the old exporter",
    line: null,
    waypointId: waypointOf(context, kinds, 3).id,
    exclusionPosition: null,
    state: "pending",
    newMapId: null,
    createdAt: "2026-01-01T00:00:03.000Z",
  });
  insertProposal({
    mapId: elsewhere,
    kind: "outside",
    title: "Another project's suggestion",
    line: "Not this project's.",
    waypointId: null,
    exclusionPosition: null,
    state: "pending",
    newMapId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  insertProposal({
    mapId: delivery,
    kind: "split",
    title: "CSV imports",
    line: "Imports are their own map.",
    waypointId: null,
    exclusionPosition: null,
    state: "confirmed",
    newMapId: uncharted,
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  insertProposal({
    mapId: delivery,
    kind: "outside",
    title: "Keep an export log",
    line: null,
    waypointId: null,
    exclusionPosition: 1,
    state: "pending",
    newMapId: null,
    createdAt: "2026-01-01T00:00:04.000Z",
  });
  insertProposal({
    mapId: kinds,
    kind: "outside",
    title: "Nightly exports",
    line: "Nightly exports are a later effort.",
    waypointId: null,
    exclusionPosition: null,
    state: "dismissed",
    newMapId: null,
    createdAt: "2026-01-01T00:00:02.000Z",
  });
});

afterEach(async () => {
  await closeTestContext(context);
});

/** Every suggestion of the project, from both maps that made one, oldest first. */
const PROJECT_PROPOSALS: ProjectProposalContext[] = [
  // A split offer, with its own line; confirmed (created) as it is stored.
  { title: "CSV imports", line: "Imports are their own map.", state: "confirmed" },
  // An outside suggestion with its own line.
  { title: "Nightly exports", line: "Nightly exports are a later effort.", state: "dismissed" },
  // Attached to a waypoint a run ruled out: its line is the waypoint's, so it has none.
  { title: "Retire the old exporter", line: null, state: "pending" },
  // Split off an existing Out of scope line: it has none of its own.
  { title: "Keep an export log", line: null, state: "pending" },
];

/** Every map of the project, oldest first, with the stage it has reached. */
const PROJECT_MAPS: ProjectMapContext[] = [
  { title: PROPOSAL.title, stage: "delivery" },
  { title: PROPOSAL.title, stage: "spec" },
  { title: "Fetch migration", stage: "wayfinding" },
  { title: null, stage: "idea" },
];

/** The request of the running run `runId`, which can suggest maps. */
async function suggestingRequest(runId: string, purpose: RunWork["purpose"]) {
  const work = await prepareRun(context.db, runId);
  if (!work.ok) throw new Error(work.error.code);
  expect(work.value.purpose).toBe(purpose);
  switch (work.value.purpose) {
    case "chart":
    case "fog":
    case "grilling":
    case "research":
    case "task":
    case "consistency":
    case "hatch":
      return work.value.request;
    case "survey":
    case "to_spec":
    case "spec_review":
    case "to_tickets":
    case "tickets_review":
      throw new Error(`A ${work.value.purpose} run suggests no map`);
  }
}

describe("the project's suggestions", () => {
  test("the reader lists every suggestion of the project oldest first, each line as stored", () => {
    expect(readProjectProposals(context.db, project.id)).toEqual(PROJECT_PROPOSALS);
  });

  test("each of the seven requests carries every suggestion and every map of the project", async () => {
    const { delivery, spec, specificationId, kinds, uncharted } = projectMaps;
    const consistency = insertRun(context, {
      mapId: kinds,
      specificationId: null,
      purpose: "consistency",
      state: "running",
    });
    const fog = insertRun(context, {
      mapId: delivery,
      specificationId: null,
      purpose: "fog",
      state: "running",
    });
    const message = insertMessage(context, spec, {
      state: "queued",
      stage: "spec",
      specificationId,
      text: "Does the export cover archived records?",
    });
    const hatch = insertHatchRun(context, spec, message, "running");
    const requests = [
      await suggestingRequest(runningMapRun(context, uncharted).id, "chart"),
      await suggestingRequest(fog.id, "fog"),
      await suggestingRequest(consistency.id, "consistency"),
      await suggestingRequest(hatch.id, "hatch"),
      await suggestingRequest(grillingRun(context, kinds, 3).id, "grilling"),
      await suggestingRequest(grillingRun(context, kinds, 1).id, "research"),
      await suggestingRequest(grillingRun(context, kinds, 2).id, "task"),
    ];
    for (const request of requests) {
      expect(request.projectProposals).toEqual(PROJECT_PROPOSALS);
      expect(request.projectMaps).toEqual(PROJECT_MAPS);
    }
  });
});

describe("the project's maps", () => {
  test("every map of the project, this one included, with the stage it has reached; another project's is absent", () => {
    expect(readProjectMaps(context.db, project.id)).toEqual(PROJECT_MAPS);
  });

  test("each stage is the latest the map's stage rail does not show as later, whatever the runner holds", async () => {
    const { delivery, spec, kinds, uncharted } = projectMaps;
    const reached = readProjectMaps(context.db, project.id).map((map) => map.stage);
    for (const deliveryHeld of [() => false, () => true]) {
      const shown: (string | undefined)[] = [];
      for (const mapId of [delivery, spec, kinds, uncharted]) {
        const overview = await getMapOverview(context.db, mapId, { deliveryHeld });
        if (!overview.ok) throw new Error(overview.error.code);
        shown.push(
          overview.value.status.stages.filter((stage) => stage.tone !== "later").at(-1)?.stage,
        );
      }
      expect(shown).toEqual(reached);
    }
  });

  test("the reached stage reads one input, synchronously: no runner state, start blocker or active run", () => {
    expect(reachedStage.length).toBe(1);
    expect(readProjectMaps(context.db, project.id)).not.toBeInstanceOf(Promise);
  });
});
