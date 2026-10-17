import type { Project, SpecRevisionContent } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { specHold } from "./spec-holds.ts";
import {
  addProject,
  clearedMap,
  closeTestContext,
  deliveredSpec,
  holdByDelivery,
  holdByRevising,
  holdByRevision,
  holdByTickets,
  insertRun,
  openTestContext,
  SPEC,
  TICKETS,
} from "./test-support.ts";
import type { DeliveredSpec, TestContext } from "./test-support.ts";

/** A later revision of SPEC: 1.2 reworded and 1.3 added. */
const REVISED: SpecRevisionContent = {
  ...SPEC,
  clauses: SPEC.clauses.map((clause) => ({
    ...clause,
    criteria: [
      { id: "1.1", text: "A CSV file downloads." },
      { id: "1.2", text: "Every row is exported, quoted." },
      { id: "1.3", text: "The header row names every column." },
    ],
  })),
};

let context: TestContext;
let project: Project;
let delivered: DeliveredSpec;
/** The map whose change is held (cleared, its own `to_spec` running). */
let mine: string;
/** The map that holds the spec. */
let other: string;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-spec-holds-");
  project = await addProject(context, "repo");
  delivered = await deliveredSpec(context, project);
  mine = await clearedMap(context, project);
  other = await clearedMap(context, project);
});

afterEach(async () => {
  await closeTestContext(context);
});

function holdOn(mapId: string) {
  return specHold(context.db, delivered.specificationId, mapId);
}

describe("specHold (S8b-4)", () => {
  test("nothing holds a delivered, merged spec", () => {
    expect(holdOn(mine)).toBeNull();
  });

  test("revision: another map wrote the latest revision and it is unapproved", () => {
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: REVISED,
      review: "running",
    });
    expect(holdOn(mine)).toMatchObject({ kind: "revision", mapId: other, revision: 2 });
    // The writer's own unapproved revision does not hold it against itself.
    expect(holdOn(other)).toBeNull();
  });

  test("revising: another map's spec-scoped to_spec runs, or stopped and not superseded", () => {
    holdByRevising(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      state: "running",
    });
    expect(holdOn(mine)).toMatchObject({ kind: "revising", mapId: other, revision: 1 });
  });

  test("revising: a stopped run that is not superseded still holds", () => {
    holdByRevising(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      state: "stopped",
    });
    expect(holdOn(mine)).toMatchObject({ kind: "revising", mapId: other });
  });

  test("a stopped, superseded run does not hold", () => {
    holdByRevising(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      state: "stopped",
    });
    // A map-scope run started after the stop supersedes it (L121, S7-26).
    insertRun(context, {
      mapId: other,
      specificationId: null,
      purpose: "to_spec",
      state: "completed",
    });
    expect(holdOn(mine)).toBeNull();
  });

  test.each(["to_tickets", "tickets_review"] as const)(
    "tickets: another map's %s holds it on that map's approved revision",
    (purpose) => {
      const held = holdByTickets(context, {
        specificationId: delivered.specificationId,
        mapId: other,
        content: REVISED,
        set: purpose === "tickets_review" ? TICKETS : null,
        purpose,
        state: "running",
      });
      expect(holdOn(mine)).toMatchObject({
        kind: "tickets",
        mapId: other,
        revision: held.revision,
      });
    },
  );

  test("this map's own to_tickets gives no tickets hold (its next revision replaces it, S8b-9)", () => {
    holdByTickets(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: REVISED,
      set: null,
      purpose: "to_tickets",
      state: "running",
    });
    expect(holdOn(other)).toBeNull();
  });

  test("delivering: an active delivery run holds the spec on every map", async () => {
    const held = await holdByDelivery(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: REVISED,
    });
    expect(holdOn(mine)).toMatchObject({
      kind: "delivering",
      mapId: other,
      revision: held.revision,
    });
    // On the delivering map's own run, the hold names that map.
    expect(holdOn(other)).toMatchObject({ kind: "delivering", mapId: other });
  });

  test("the first applicable hold wins: revising before delivering", async () => {
    await holdByDelivery(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: REVISED,
    });
    const third = await clearedMap(context, project);
    holdByRevising(context, {
      specificationId: delivered.specificationId,
      mapId: third,
      state: "running",
    });
    expect(holdOn(mine)).toMatchObject({ kind: "revising", mapId: third });
  });

  test("the first applicable hold wins: revision before revising", async () => {
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: REVISED,
      review: "running",
    });
    const third = await clearedMap(context, project);
    holdByRevising(context, {
      specificationId: delivered.specificationId,
      mapId: third,
      state: "stopped",
    });
    expect(holdOn(mine)).toMatchObject({ kind: "revision", mapId: other, revision: 2 });
  });
});
