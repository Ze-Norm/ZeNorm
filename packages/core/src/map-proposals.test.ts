import { rm } from "node:fs/promises";

import { ConfirmProposalInput } from "@zenorm/contracts";
import type { ChartConfirmation, GrillOutcome, Project, ProposedMap } from "@zenorm/contracts";
import { mapExclusions, mapFog, mapProposals, maps } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { recordFogSettlement } from "./fog-settlement.ts";
import { getMapOverview } from "./map-overview.ts";
import { confirmProposal, dismissProposal } from "./map-proposals.ts";
import {
  readMap,
  readWaypoints,
  recordChart,
  recordConsistency,
  recordGrill,
} from "./planning-runs.ts";
import {
  addProject,
  answerDestination,
  closeTestContext,
  CONFIRMATION,
  confirm,
  grillingRun,
  newMap,
  NO_MAP_CHANGES,
  openTestContext,
  propose,
  resolve,
  runningMapRun,
  runsOf,
  UNKNOWN_ID,
  waypointOf,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import { readFog } from "./wayfinding-records.ts";

let context: TestContext;
let project: Project;
let mapId: string;

beforeEach(async () => {
  context = await openTestContext("zenorm-proposals-");
  project = await addProject(context, "repo");
  mapId = await newMap(context, project, "Export data");
  propose(context, mapId);
  answerDestination(context, mapId);
});

afterEach(async () => {
  await closeTestContext(context);
});

const IMPORTS: ProposedMap = {
  title: "CSV imports",
  idea: "Import records from a CSV file.",
  line: "Importing CSV files is its own effort.",
};

const SCHEDULES: ProposedMap = {
  title: "Nightly exports",
  idea: "Schedule exports every night.",
  line: "Scheduled exports are their own effort.",
};

const RULING_REASON = "Columns are fixed by the importer.";
const RULING_IDEA = "Rework the importer.";

/** The draft ideas no run may write. */
const IDEAS_OUT_OF_BOUNDS: readonly [string, string][] = [
  ["an empty idea", ""],
  ["a blank idea", "   "],
  ["an idea over 4000 characters", "i".repeat(4001)],
];

/** The proposals no run may write: each idea above, and a line over 500 characters. */
const OUT_OF_BOUNDS: readonly [string, ProposedMap][] = [
  ...IDEAS_OUT_OF_BOUNDS.map(([name, idea]): [string, ProposedMap] => [
    name,
    { title: "Later", idea, line: "Later." },
  ]),
  [
    "a line over 500 characters",
    { title: "Imports", idea: "Import records.", line: "l".repeat(501) },
  ],
];

function proposalRows() {
  return context.db.select().from(mapProposals).all();
}

function exclusionRows() {
  return context.db.select().from(mapExclusions).all();
}

function mapCount(): number {
  return context.db.select().from(maps).all().length;
}

/** Records the running confirming chart with `confirmation`, then the survey it starts. */
function confirmWith(confirmation: ChartConfirmation): void {
  confirm(context, mapId, confirmation);
}

/** Waypoint 1's out-of-scope ruling, with a proposal of `idea` attached. */
function rulingWith(idea: string): GrillOutcome {
  return {
    round: null,
    resolution: null,
    outOfScope: { reason: RULING_REASON, proposal: { title: "Importer rework", idea } },
    mapChanges: NO_MAP_CHANGES,
  };
}

/** Rules waypoint 1 out of scope with a proposal of `RULING_IDEA` attached. */
function ruleOutWaypointOne(): void {
  const recorded = recordGrill(
    context.user,
    context.db,
    grillingRun(context, mapId, 1).id,
    rulingWith(RULING_IDEA),
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** Resolves waypoints 1, 2 and 3 in turn: the map's fog run, else its pass, then runs. */
function resolveAll(): void {
  resolve(context, mapId, 1);
  resolve(context, mapId, 2);
  resolve(context, mapId, 3);
}

/** The one proposal stored; anything else throws. */
function onlyProposal() {
  const rows = proposalRows();
  const [row] = rows;
  if (row === undefined || rows.length !== 1) {
    throw new Error(`Expected one proposal, found ${String(rows.length)}`);
  }
  return row;
}

async function wayfinding() {
  const overview = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
  if (!overview.ok) throw new Error(overview.error.code);
  return overview.value.wayfinding;
}

describe("runs save their proposals of new maps", () => {
  test("a confirming chart saves each proposal pending, with its own line and no Out of scope line yet", async () => {
    const chart = runningMapRun(context, mapId);
    confirmWith({ ...CONFIRMATION, proposals: [IMPORTS] });

    expect(proposalRows()).toMatchObject([
      {
        mapId,
        idea: IMPORTS.idea,
        line: IMPORTS.line,
        waypointId: null,
        state: "pending",
        newMapId: null,
        createdByRun: chart.id,
        decidedAt: null,
      },
    ]);
    expect(exclusionRows()).toEqual([]);
    expect((await wayfinding()).proposals).toMatchObject([
      { idea: IMPORTS.idea, line: IMPORTS.line, waypoint: null, state: "pending", newMapId: null },
    ]);
  });

  test("a draft idea is stored trimmed", () => {
    confirmWith({ ...CONFIRMATION, proposals: [{ ...IMPORTS, idea: `  ${IMPORTS.idea}\n` }] });
    expect(onlyProposal().idea).toBe(IMPORTS.idea);
  });

  test("a waypoint run ruling its waypoint out attaches a proposal with an idea and no line", async () => {
    confirmWith(CONFIRMATION);
    const run = grillingRun(context, mapId, 1);
    ruleOutWaypointOne();

    const one = waypointOf(context, mapId, 1);
    expect(one.status).toBe("out_of_scope");
    expect(onlyProposal()).toMatchObject({
      idea: RULING_IDEA,
      line: null,
      waypointId: one.id,
      state: "pending",
      createdByRun: run.id,
    });
    expect(exclusionRows()).toMatchObject([
      { text: RULING_REASON, waypointId: one.id, splitMapId: null },
    ]);
    expect((await wayfinding()).proposals).toMatchObject([{ waypoint: 1, line: null }]);
  });

  test("a fog item settled as a proposal leaves the fog with no Out of scope line", () => {
    confirmWith({ ...CONFIRMATION, fog: ["Fog 1.", "Fog 2."] });
    resolveAll();
    const fogRun = runningMapRun(context, mapId);
    expect(fogRun.purpose).toBe("fog");

    const recorded = recordFogSettlement(context.user, context.db, fogRun.id, {
      fogSettledBy: [{ position: 1, waypoint: 1 }],
      fogDecided: [],
      fogOutOfScope: [],
      fogForPerson: [],
      fogProposed: [{ position: 2, ...IMPORTS }],
    });
    expect(recorded.ok).toBe(true);

    expect(context.db.select().from(mapFog).all()).toEqual([]);
    expect(exclusionRows()).toEqual([]);
    expect(onlyProposal()).toMatchObject({
      idea: IMPORTS.idea,
      line: IMPORTS.line,
      waypointId: null,
      createdByRun: fogRun.id,
    });
  });

  test("a fog item both settled and proposed is refused fog_item_unknown and saves nothing", () => {
    confirmWith({ ...CONFIRMATION, fog: ["Fog 1."] });
    resolveAll();
    const fogRun = runningMapRun(context, mapId);

    const recorded = recordFogSettlement(context.user, context.db, fogRun.id, {
      fogSettledBy: [{ position: 1, waypoint: 1 }],
      fogDecided: [],
      fogOutOfScope: [],
      fogForPerson: [],
      fogProposed: [{ position: 1, ...IMPORTS }],
    });

    expect(!recorded.ok && recorded.error.code).toBe("fog_item_unknown");
    expect(readFog(context.db, mapId)).toHaveLength(1);
    expect(proposalRows()).toEqual([]);
  });

  test("a consistency pass saves its proposals beside its findings", () => {
    confirmWith(CONFIRMATION);
    resolveAll();
    const pass = runningMapRun(context, mapId);
    expect(pass.purpose).toBe("consistency");

    const recorded = recordConsistency(context.user, context.db, pass.id, {
      findings: [],
      proposals: [SCHEDULES],
    });
    expect(recorded.ok).toBe(true);

    expect(onlyProposal()).toMatchObject({
      idea: SCHEDULES.idea,
      line: SCHEDULES.line,
      waypointId: null,
      createdByRun: pass.id,
    });
    expect(exclusionRows()).toEqual([]);
  });
});

describe("a proposal outside its bounds fails its run agent_output_invalid and saves nothing", () => {
  test.each(OUT_OF_BOUNDS)("a confirming chart with %s", (_, proposal) => {
    const chart = runningMapRun(context, mapId);
    const recorded = recordChart(context.user, context.db, chart.id, {
      kind: "confirmation",
      confirmation: { ...CONFIRMATION, proposals: [proposal] },
    });

    expect(!recorded.ok && recorded.error.code).toBe("agent_output_invalid");
    expect(proposalRows()).toEqual([]);
    expect(readWaypoints(context.db, mapId)).toEqual([]);
    expect(readMap(context.db, mapId).destinationConfirmedAt).toBeNull();
    expect(runningMapRun(context, mapId)).toMatchObject({
      purpose: "chart",
      retryOfRunId: chart.id,
    });
  });

  test.each(IDEAS_OUT_OF_BOUNDS)("a waypoint's ruling with %s", (_, idea) => {
    confirmWith(CONFIRMATION);
    const run = grillingRun(context, mapId, 1);
    const recorded = recordGrill(context.user, context.db, run.id, rulingWith(idea));

    expect(!recorded.ok && recorded.error.code).toBe("agent_output_invalid");
    expect(proposalRows()).toEqual([]);
    expect(exclusionRows()).toEqual([]);
    expect(waypointOf(context, mapId, 1).status).toBe("claimed");
  });

  test.each(OUT_OF_BOUNDS)("a fog run with %s", (_, proposal) => {
    confirmWith({ ...CONFIRMATION, fog: ["Fog 1."] });
    resolveAll();
    const fogRun = runningMapRun(context, mapId);

    const recorded = recordFogSettlement(context.user, context.db, fogRun.id, {
      fogSettledBy: [],
      fogDecided: [],
      fogOutOfScope: [],
      fogForPerson: [],
      fogProposed: [{ position: 1, ...proposal }],
    });

    expect(!recorded.ok && recorded.error.code).toBe("agent_output_invalid");
    expect(readFog(context.db, mapId)).toHaveLength(1);
    expect(proposalRows()).toEqual([]);
  });

  test.each(OUT_OF_BOUNDS)("a consistency pass with %s", (_, proposal) => {
    confirmWith(CONFIRMATION);
    resolveAll();
    const pass = runningMapRun(context, mapId);

    const recorded = recordConsistency(context.user, context.db, pass.id, {
      findings: [],
      proposals: [proposal],
    });

    expect(!recorded.ok && recorded.error.code).toBe("agent_output_invalid");
    expect(proposalRows()).toEqual([]);
  });
});

describe("confirming a proposal", () => {
  test("creates a charting map in the same project, split from the map and run, and links the line; the map is otherwise unchanged", async () => {
    const chart = runningMapRun(context, mapId);
    confirmWith({ ...CONFIRMATION, fog: ["Fog 1."], proposals: [IMPORTS] });
    const proposalId = onlyProposal().id;
    const before = {
      map: readMap(context.db, mapId),
      waypoints: readWaypoints(context.db, mapId),
      fog: readFog(context.db, mapId),
    };

    const confirmed = await confirmProposal(
      context.user,
      context.db,
      ConfirmProposalInput.parse({ proposalId, idea: "  Import records, matching headers.  " }),
    );

    if (!confirmed.ok) throw new Error(confirmed.error.code);
    const { map } = confirmed.value;
    expect(confirmed.value.mapId).toBe(mapId);
    expect(map).toMatchObject({
      projectId: project.id,
      idea: "Import records, matching headers.",
      title: null,
      splitFromMapId: mapId,
      splitFromRunId: chart.id,
    });
    expect(readMap(context.db, map.id)).toEqual(map);
    // Its chart starts at once, and the map is the confirming User's.
    expect(runsOf(context, map.id)).toMatchObject([
      { purpose: "chart", state: "running", retryOfRunId: null },
    ]);
    expect(
      context.db.select({ userId: maps.userId }).from(maps).where(eq(maps.id, map.id)).get(),
    ).toEqual({ userId: context.user.userId });

    expect(onlyProposal()).toMatchObject({
      state: "confirmed",
      newMapId: map.id,
      idea: "Import records, matching headers.",
    });
    expect(onlyProposal().decidedAt).not.toBeNull();
    expect(exclusionRows()).toMatchObject([
      { mapId, text: IMPORTS.line, waypointId: null, splitMapId: map.id, createdByRun: chart.id },
    ]);
    // The map's destination, waypoints and fog are unchanged.
    expect(readMap(context.db, mapId)).toEqual(before.map);
    expect(readWaypoints(context.db, mapId)).toEqual(before.waypoints);
    expect(readFog(context.db, mapId)).toEqual(before.fog);
  });

  test("a ruled-out waypoint's line gains the link and keeps its waypoint", async () => {
    confirmWith(CONFIRMATION);
    ruleOutWaypointOne();

    const confirmed = await confirmProposal(
      context.user,
      context.db,
      ConfirmProposalInput.parse({ proposalId: onlyProposal().id, idea: RULING_IDEA }),
    );
    if (!confirmed.ok) throw new Error(confirmed.error.code);

    const one = waypointOf(context, mapId, 1);
    const newMapId = confirmed.value.map.id;
    expect(exclusionRows()).toMatchObject([
      { text: RULING_REASON, waypointId: one.id, splitMapId: newMapId },
    ]);
    expect((await wayfinding()).outOfScope).toEqual([
      { text: RULING_REASON, waypoint: 1, splitMapId: newMapId },
    ]);
  });

  test("confirming or dismissing a decided proposal is refused proposal_already_decided and changes nothing", async () => {
    confirmWith({ ...CONFIRMATION, proposals: [IMPORTS] });
    const proposalId = onlyProposal().id;
    const first = await confirmProposal(
      context.user,
      context.db,
      ConfirmProposalInput.parse({ proposalId, idea: IMPORTS.idea }),
    );
    expect(first.ok).toBe(true);
    const mapsBefore = mapCount();
    const exclusionsBefore = exclusionRows();

    const again = await confirmProposal(
      context.user,
      context.db,
      ConfirmProposalInput.parse({ proposalId, idea: "Another idea." }),
    );
    expect(!again.ok && again.error.code).toBe("proposal_already_decided");
    const dismissed = dismissProposal(context.user, context.db, { proposalId });
    expect(!dismissed.ok && dismissed.error.code).toBe("proposal_already_decided");
    expect(mapCount()).toBe(mapsBefore);
    expect(exclusionRows()).toEqual(exclusionsBefore);
    expect(onlyProposal()).toMatchObject({ state: "confirmed", idea: IMPORTS.idea });
  });

  test("a missing project folder is refused project_folder_missing; the proposal stays pending", async () => {
    confirmWith({ ...CONFIRMATION, proposals: [IMPORTS] });
    const proposalId = onlyProposal().id;
    const mapsBefore = mapCount();
    await rm(project.folderPath, { recursive: true, force: true });

    const refused = await confirmProposal(
      context.user,
      context.db,
      ConfirmProposalInput.parse({ proposalId, idea: "Import records, edited." }),
    );

    expect(!refused.ok && refused.error.code).toBe("project_folder_missing");
    expect(mapCount()).toBe(mapsBefore);
    expect(exclusionRows()).toEqual([]);
    expect(onlyProposal()).toMatchObject({ state: "pending", idea: IMPORTS.idea, newMapId: null });
  });

  test("an unknown proposal is refused proposal_not_found", async () => {
    const refused = await confirmProposal(
      context.user,
      context.db,
      ConfirmProposalInput.parse({ proposalId: UNKNOWN_ID, idea: "X" }),
    );
    expect(!refused.ok && refused.error.code).toBe("proposal_not_found");
    const dismissed = dismissProposal(context.user, context.db, { proposalId: UNKNOWN_ID });
    expect(!dismissed.ok && dismissed.error.code).toBe("proposal_not_found");
  });
});

describe("dismissing a proposal", () => {
  test("saves the proposal's own line plain, and creates no map", () => {
    const chart = runningMapRun(context, mapId);
    confirmWith({ ...CONFIRMATION, proposals: [IMPORTS] });
    const mapsBefore = mapCount();

    const dismissed = dismissProposal(context.user, context.db, {
      proposalId: onlyProposal().id,
    });

    expect(dismissed).toEqual({ ok: true, value: mapId });
    expect(mapCount()).toBe(mapsBefore);
    expect(onlyProposal()).toMatchObject({ state: "dismissed", newMapId: null });
    expect(onlyProposal().decidedAt).not.toBeNull();
    expect(exclusionRows()).toMatchObject([
      { text: IMPORTS.line, waypointId: null, splitMapId: null, createdByRun: chart.id },
    ]);
  });

  test("a waypoint-attached proposal leaves exactly one unlinked line for that waypoint", () => {
    confirmWith(CONFIRMATION);
    ruleOutWaypointOne();

    const dismissed = dismissProposal(context.user, context.db, {
      proposalId: onlyProposal().id,
    });
    expect(dismissed.ok).toBe(true);

    const one = waypointOf(context, mapId, 1);
    expect(exclusionRows()).toMatchObject([
      { text: RULING_REASON, waypointId: one.id, splitMapId: null },
    ]);
    expect(exclusionRows()).toHaveLength(1);
  });
});
