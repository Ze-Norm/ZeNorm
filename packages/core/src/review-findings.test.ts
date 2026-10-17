import type { Project, SpecReviewFinding } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import { prepareRun } from "./run-work.ts";
import {
  SPEC,
  addProject,
  closeTestContext,
  grillingRun,
  openTestContext,
  reviewedSpec,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-review-findings-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/** A decision finding: the person must decide, so the review sends it to Wayfinding. */
const DECISION: SpecReviewFinding = {
  kind: "undefined_term",
  route: "decision",
  title: "Which records?",
  explanation: "C1 says 'every record', which no source defines.",
  question: "Which records does the export cover?",
  elementIds: ["C1"],
  waypointNumbers: [],
};

describe("an escalated waypoint carries the finding behind it", () => {
  test("its grilling run receives the finding; the overview shows it, the Spec stage waits, and the activity links the waypoint", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [DECISION]);

    const work = await prepareRun(context.db, grillingRun(context, mapId, 1).id);
    if (!work.ok) throw new Error(work.error.code);
    expect(work.value.purpose).toBe("grilling");
    expect(work.value.request).toMatchObject({
      reviewFindings: [
        {
          kind: DECISION.kind,
          explanation: DECISION.explanation,
          spec: { number: 1, title: SPEC.title },
          elementIds: DECISION.elementIds,
        },
      ],
      finding: null,
    });

    const result = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    if (!result.ok) throw new Error(result.error.code);
    const { wayfinding, specs, status, activity } = result.value;
    expect(wayfinding.waypoints.map((waypoint) => waypoint.reviewFinding)).toEqual([
      {
        spec: 1,
        specTitle: SPEC.title,
        explanation: DECISION.explanation,
        elementIds: DECISION.elementIds,
      },
    ]);
    expect(specs.map((spec) => [spec.id, spec.stages[0].tone])).toEqual([
      [specificationId, "later"],
    ]);
    expect(status.next.every((action) => action.stage !== "spec")).toBe(true);
    expect(
      activity
        .filter((line) => line.stage === "spec" && line.waypoint !== null)
        .map((line) => line.waypoint),
    ).toEqual([1]);
  });
});
