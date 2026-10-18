import type { MapGroup, MapOverview, StageTone } from "@zenorm/contracts";
import { describe, expect, it } from "vitest";

import { groupProjectMaps } from "./map-groups.ts";

const PROJECT_ID = "01900000-0000-7000-8000-000000000000";

/** A map overview in `group` whose Delivery stage shows `delivery`, named by `n`. */
function overview(n: number, group: MapGroup, delivery: StageTone): MapOverview {
  return {
    map: {
      id: `01900000-0000-7000-8000-00000000000${String(n)}`,
      projectId: PROJECT_ID,
      idea: `Map ${String(n)}`,
      title: null,
      summary: null,
      destination: null,
      destinationConfirmedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      splitFromMapId: null,
      splitFromRunId: null,
    },
    project: {
      id: PROJECT_ID,
      name: "Project",
      folderPath: "/tmp/project",
      baseBranch: "main",
      requiredChecks: [],
      repairLimit: null,
      fixCommands: [],
      appStartCommand: null,
      appUrl: null,
      appSetupCommands: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      folder: "present",
      startDeliveryBlockers: [],
      activeRun: null,
    },
    status: {
      stages: [
        { stage: "idea", tone: "done", line: "Idea." },
        { stage: "wayfinding", tone: "done", line: "Wayfinding." },
        { stage: "spec", tone: "done", line: "Spec." },
        { stage: "tickets", tone: "done", line: "Tickets." },
        { stage: "delivery", tone: delivery, line: "Delivery." },
      ],
      next: [
        {
          who: "nobody",
          label: null,
          stage: "delivery",
          headline: "Nothing to do.",
          detail: null,
          round: null,
          stopped: null,
          waiting: null,
          spec: null,
          onMap: null,
        },
      ],
      group,
    },
  };
}

function ids(overviews: readonly MapOverview[]): string[] {
  return overviews.map((o) => o.map.id);
}

describe("groupProjectMaps", () => {
  it("groups a mixed set into Needs you, Agent is working, Quiet and Completed, in input order", () => {
    const needsYou = overview(1, "needs-you", "needs-you");
    const working = overview(2, "working", "working");
    const quietOpen = overview(3, "quiet", "idle");
    const quietDone = overview(4, "quiet", "done");
    const needsYouDone = overview(5, "needs-you", "done");
    const workingDone = overview(6, "working", "done");
    const quietDoneLater = overview(7, "quiet", "done");
    const groups = groupProjectMaps([
      needsYou,
      working,
      quietOpen,
      quietDone,
      needsYouDone,
      workingDone,
      quietDoneLater,
    ]);
    expect(Object.keys(groups)).toEqual(["needs-you", "working", "quiet", "completed"]);
    expect(ids(groups["needs-you"])).toEqual(ids([needsYou, needsYouDone]));
    expect(ids(groups.working)).toEqual(ids([working, workingDone]));
    expect(ids(groups.quiet)).toEqual(ids([quietOpen]));
    expect(ids(groups.completed)).toEqual(ids([quietDone, quietDoneLater]));
  });

  it("leaves a group with no maps empty", () => {
    const groups = groupProjectMaps([overview(1, "quiet", "done")]);
    expect(groups["needs-you"]).toEqual([]);
    expect(groups.working).toEqual([]);
    expect(groups.quiet).toEqual([]);
    expect(ids(groups.completed)).toEqual(ids([overview(1, "quiet", "done")]));
    expect(groupProjectMaps([])).toEqual({
      "needs-you": [],
      working: [],
      quiet: [],
      completed: [],
    });
  });
});
