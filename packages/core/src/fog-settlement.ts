import { ok } from "@zenorm/contracts";
import type {
  Actor,
  FogSettlementOutcome,
  Result,
  SettleFogRequest,
  Waypoint,
} from "@zenorm/contracts";
import { waypoints } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, eq } from "drizzle-orm";

import { readCodeSurvey } from "./code-survey.ts";
import { applyMapChanges, proposalsProblem, proposeFog } from "./map-changes.ts";
import { projectSuggestionContext } from "./map-overview.ts";
import {
  endRun,
  isReplaced,
  readMap,
  readRounds,
  readWaypoints,
  refuse,
  runningRun,
} from "./planning-runs.ts";
import type { Reader, RunFailure } from "./planning-runs.ts";
import { present } from "./present.ts";
import { planAndRelease } from "./spec-holds.ts";
import { readExclusions, readFog } from "./wayfinding-records.ts";
import { write } from "./writes.ts";

/** The base fields every request carries, as `prepareRun` builds them. */
interface RequestBase {
  readonly projectName: SettleFogRequest["projectName"];
  readonly projectFolder: SettleFogRequest["projectFolder"];
  readonly baseBranch: SettleFogRequest["baseBranch"];
  readonly idea: SettleFogRequest["idea"];
}

/**
 * Whether the person stands behind a resolved waypoint's resolution: they answered a round on it,
 * it was resolved from their plain choices, or their note through the hatch directed it. False when
 * the agent decided it alone.
 */
export function decidedByPerson(
  db: Reader,
  mapId: string,
): (waypoint: Pick<Waypoint, "id" | "resolvedHow" | "hatchMessageId">) => boolean {
  const answered = new Set(
    readRounds(db, mapId).flatMap((round) =>
      round.status === "submitted" && round.waypointId !== null ? [round.waypointId] : [],
    ),
  );
  return (waypoint) =>
    waypoint.resolvedHow === "plain_choice" ||
    answered.has(waypoint.id) ||
    waypoint.hatchMessageId !== null;
}

/**
 * A `fog` run's request (harness change #4): the map, its code survey, every resolved waypoint with
 * who stands behind it, the fog to settle, and the project's map suggestions and maps.
 */
export function settleFogRequest(
  db: Reader,
  mapId: string,
  base: RequestBase,
  mapRounds: SettleFogRequest["mapRounds"],
): SettleFogRequest {
  const map = readMap(db, mapId);
  const byPerson = decidedByPerson(db, mapId);
  return {
    ...base,
    ...projectSuggestionContext(db, map.projectId),
    title: present(map.title, `Map ${mapId}'s title`),
    destination: present(map.destination, `Map ${mapId}'s destination`),
    mapRounds,
    outOfScope: readExclusions(db, mapId).map((exclusion) => exclusion.text),
    survey: readCodeSurvey(db, mapId),
    waypoints: readWaypoints(db, mapId)
      .filter((waypoint) => waypoint.status === "resolved")
      .map((waypoint) => ({
        number: waypoint.number,
        kind: waypoint.kind,
        title: waypoint.title,
        question: waypoint.question,
        resolution: present(waypoint.resolution, `Waypoint ${waypoint.id}'s resolution`),
        decidedByPerson: byPerson(waypoint),
      })),
    fog: readFog(db, mapId),
  };
}

/** Every fog position a fog run's outcome settles, in its lists' order. */
function settledPositions(outcome: FogSettlementOutcome): number[] {
  return [
    ...outcome.fogSettledBy.map((item) => item.position),
    ...outcome.fogDecided.map((item) => item.position),
    ...outcome.fogOutOfScope.map((item) => item.position),
    ...outcome.fogForPerson.map((item) => item.position),
    ...outcome.fogProposed.map((item) => item.position),
  ];
}

/**
 * The first problem of a fog run's outcome, checked before anything is written: a position naming
 * no current fog item, or named twice, is `fog_item_unknown`; a fog item settled by a waypoint that
 * is not `resolved` is `fog_settled_without_resolution`; a fog item left out is
 * `fog_left_unsettled`. Null when there is none.
 */
function fogSettlementProblem(
  db: Reader,
  mapId: string,
  outcome: FogSettlementOutcome,
): RunFailure | null {
  const fog = new Set(readFog(db, mapId).map((item) => item.position));
  const used = new Set<number>();
  for (const position of settledPositions(outcome)) {
    if (!fog.has(position) || used.has(position)) {
      return {
        code: "fog_item_unknown",
        message: `Fog position ${String(position)} is not a fog item of the map, or is used twice`,
      };
    }
    used.add(position);
  }
  const resolved = new Set(
    readWaypoints(db, mapId)
      .filter((waypoint) => waypoint.status === "resolved")
      .map((waypoint) => waypoint.number),
  );
  const unresolved = outcome.fogSettledBy.find((item) => !resolved.has(item.waypoint));
  if (unresolved !== undefined) {
    return {
      code: "fog_settled_without_resolution",
      message: `Fog position ${String(unresolved.position)} is settled by waypoint ${String(unresolved.waypoint)}, which is not a resolved waypoint of the map`,
    };
  }
  const left = [...fog].filter((position) => !used.has(position));
  if (left.length > 0) {
    return {
      code: "fog_left_unsettled",
      message: `The output leaves fog positions ${left.map(String).join(", ")} unsettled: settle every fog item exactly once`,
    };
  }
  return null;
}

/**
 * Saves a `fog` run's settlement in one transaction and inserts what it makes due (harness change
 * #4): each item settled by an existing resolution deleted, each decided item saved as a waypoint
 * resolved by the run, each item out of scope deleted with its Out of scope line, and each item
 * only the person can settle opened as an unblocked Grilling waypoint only the person settles
 * (`personDecides`), and each item proposed as a new map deleted with its proposal saved pending
 * and no Out of scope line; the run ends `completed`. An outcome `fogSettlementProblem` refuses, or
 * a proposal outside its bounds (`agent_output_invalid`), fails the run with its code and writes
 * nothing else.
 */
export function recordFogSettlement(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: FogSettlementOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      // A run cancelled while its call was out saves nothing and is not retried (S7b-6).
      return ok(null);
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "fog" || run.waypointId !== null) {
      throw new Error(`Planning run ${runId} is not the map's fog run`);
    }
    const problem =
      fogSettlementProblem(tx, run.mapId, outcome) ?? proposalsProblem(outcome.fogProposed);
    if (problem !== null) {
      return refuse(actor, tx, run, problem);
    }
    applyMapChanges(tx, run, {
      newWaypoints: outcome.fogForPerson.map((item) => ({
        kind: "grilling",
        title: item.title,
        question: item.question,
        blockedBy: [],
        fromFog: item.position,
      })),
      fogOutOfScope: outcome.fogOutOfScope,
      fogDecided: outcome.fogDecided,
      fogSettledHere: outcome.fogSettledBy.map((item) => item.position),
      newFog: [],
    });
    tx.update(waypoints)
      .set({ personDecides: true })
      .where(
        and(
          eq(waypoints.mapId, run.mapId),
          eq(waypoints.createdByRun, runId),
          eq(waypoints.status, "open"),
        ),
      )
      .run();
    for (const item of outcome.fogProposed) {
      proposeFog(tx, run, item);
    }
    endRun(tx, runId, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}
