import { err, ok } from "@zenorm/contracts";
import type {
  ChartMapRequest,
  CheckConsistencyRequest,
  DraftSpecsRequest,
  DraftTicketSetRequest,
  GrillWaypointRequest,
  MapRecord,
  MapRound,
  PlanningRun,
  ReplyThroughHatchRequest,
  ResearchWaypointRequest,
  Result,
  ReviewSpecRequest,
  ReviewTicketSetRequest,
  ReviseSpecRequest,
  SettleFogRequest,
  SurveyCodeRequest,
  Waypoint,
  WaypointNote,
  WorkTaskRequest,
} from "@zenorm/contracts";
import { hatchMessages, planningRuns, projects } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { eq } from "drizzle-orm";

import { readCodeSurvey, surveyCodeRequest } from "./code-survey.ts";
import { decidedByPerson, settleFogRequest } from "./fog-settlement.ts";
import { hatchRequest } from "./hatch-runs.ts";
import { projectSuggestionContext } from "./map-overview.ts";
import {
  currentRounds,
  mapRoundsOf,
  newSinceLastPass,
  reopenedAt,
  reopenSplit,
  readMap,
  readMapRuns,
  readRounds,
  readWaypoints,
  scopeRuns,
  waypointRounds,
} from "./planning-runs.ts";
import type { RunFailure } from "./planning-runs.ts";
import { projectName } from "./project.ts";
import { seamsOf } from "./seams.ts";
import { grillReviewFindings } from "./review-findings.ts";
import {
  draftSpecsRequest,
  draftTicketSetRequest,
  reviewSpecRequest,
  reviewTicketSetRequest,
  reviseSpecRequest,
  otherProjectSpecs,
} from "./spec-requests.ts";
import { runTouches } from "./spec-context.ts";
import {
  readExclusions,
  readFindings,
  readFog,
  readPasses,
  readReports,
  readSplitOffers,
  readTaskOutcomes,
} from "./wayfinding-records.ts";
import { present } from "./present.ts";

/** What a running planning run asks its port for, by purpose (spec D3). */
type PurposeWork =
  | { readonly purpose: "chart"; readonly run: PlanningRun; readonly request: ChartMapRequest }
  | { readonly purpose: "survey"; readonly run: PlanningRun; readonly request: SurveyCodeRequest }
  | { readonly purpose: "fog"; readonly run: PlanningRun; readonly request: SettleFogRequest }
  | {
      readonly purpose: "grilling";
      readonly run: PlanningRun;
      readonly request: GrillWaypointRequest;
    }
  | {
      readonly purpose: "research";
      readonly run: PlanningRun;
      readonly request: ResearchWaypointRequest;
    }
  | { readonly purpose: "task"; readonly run: PlanningRun; readonly request: WorkTaskRequest }
  | {
      readonly purpose: "consistency";
      readonly run: PlanningRun;
      readonly request: CheckConsistencyRequest;
    }
  | {
      readonly purpose: "to_spec";
      /** A map-scope run writes the map's specs (`DraftSpecs`). */
      readonly scope: "map";
      readonly run: PlanningRun;
      readonly request: DraftSpecsRequest;
    }
  | {
      readonly purpose: "to_spec";
      /** A spec-scoped run repairs one spec (`ReviseSpec`, S7-7, S7-12). */
      readonly scope: "spec";
      readonly run: PlanningRun;
      readonly request: ReviseSpecRequest;
    }
  | {
      readonly purpose: "spec_review";
      readonly run: PlanningRun;
      readonly request: ReviewSpecRequest;
    }
  | {
      readonly purpose: "to_tickets";
      readonly run: PlanningRun;
      readonly request: DraftTicketSetRequest;
    }
  | {
      readonly purpose: "tickets_review";
      readonly run: PlanningRun;
      readonly request: ReviewTicketSetRequest;
    }
  | {
      readonly purpose: "hatch";
      readonly run: PlanningRun;
      readonly request: ReplyThroughHatchRequest;
    };

/**
 * What a running planning run asks its port for, and the CLI session it resumes: the session of
 * the run it retries when that run ran out of turns (`error_max_turns`), else null. A retry is
 * never retried (S6a-12), so a run resumes at most once.
 */
export type RunWork = PurposeWork & { readonly resumeSessionId: string | null };

/** The session a retry of `run` resumes, or null when it starts cold. */
export function resumeSessionId(db: ZeNormDatabase, run: PlanningRun): string | null {
  if (run.retryOfRunId === null) return null;
  const retried = db
    .select({ resultSubtype: planningRuns.resultSubtype, sessionId: planningRuns.sessionId })
    .from(planningRuns)
    .where(eq(planningRuns.id, run.retryOfRunId))
    .get();
  if (retried === undefined) {
    throw new Error(`Planning run ${run.id} retries missing run ${run.retryOfRunId}`);
  }
  if (retried.resultSubtype !== "error_max_turns") return null;
  // `recordRunUsage` stores the subtype and the session together.
  return present(retried.sessionId, `Planning run ${run.retryOfRunId}'s session`);
}

/**
 * What the running run `runId` asks its port, with the session it resumes (`resumeSessionId`).
 */
export async function prepareRun(
  db: ZeNormDatabase,
  runId: string,
): Promise<Result<RunWork, RunFailure>> {
  const work = await prepareWork(db, runId);
  if (!work.ok) return work;
  return ok({ ...work.value, resumeSessionId: resumeSessionId(db, work.value.run) });
}

/**
 * What the running run `runId` asks its port, built from the stored records. A project folder that
 * is gone fails the run's attempt with `project_folder_missing` before any port is called. A run
 * that is not running, or whose purpose this slice does not start, is a programmer error.
 */
async function prepareWork(
  db: ZeNormDatabase,
  runId: string,
): Promise<Result<PurposeWork, RunFailure>> {
  const run = db.select().from(planningRuns).where(eq(planningRuns.id, runId)).get();
  if (run?.state !== "running") {
    throw new Error(`Planning run ${runId} is not running`);
  }
  const map = readMap(db, run.mapId);
  const project = db.select().from(projects).where(eq(projects.id, map.projectId)).get();
  if (project === undefined) {
    throw new Error(`Map ${map.id} references missing project ${map.projectId}`);
  }
  // The checkout seam gives the folder the run works in (S9-17, D15).
  const checkedOut = await seamsOf(db).checkout(project);
  if (!checkedOut.ok) {
    return err({ code: "project_folder_missing", message: checkedOut.error.message });
  }
  const folder = checkedOut.value;
  const base = {
    projectName: projectName(project.folderPath),
    projectFolder: folder,
    baseBranch: project.baseBranch,
    idea: map.idea,
  };
  const rounds = readRounds(db, map.id);
  // Read once per run, for every run that decides or checks scope (DR-14).
  const mapRounds = mapRoundsOf(rounds);

  switch (run.purpose) {
    case "chart":
      return ok({
        purpose: "chart",
        run,
        request: {
          ...base,
          ...projectSuggestionContext(db, map.projectId),
          mapRounds,
          // What the last round was asked about (DR-3); the first chart proposes it.
          proposed:
            mapRounds.length === 0
              ? null
              : {
                  title: present(map.title, `Map ${map.id}'s title`),
                  summary: present(map.summary, `Map ${map.id}'s summary`),
                  destination: present(map.destination, `Map ${map.id}'s destination`),
                },
          projectSpecs: otherProjectSpecs(db, map),
          split: readSplitOffers(db, map.id),
          refusedAttempt: chartRefusedAttempt(db, run),
        },
      });
    case "survey":
      return ok({ purpose: "survey", run, request: surveyCodeRequest(db, map.id, base) });
    case "fog":
      return ok({ purpose: "fog", run, request: settleFogRequest(db, map.id, base, mapRounds) });
    case "to_spec":
      return ok(
        run.specificationId === null
          ? {
              purpose: "to_spec",
              scope: "map",
              run,
              request: draftSpecsRequest(db, map, run, base, mapRounds),
            }
          : {
              purpose: "to_spec",
              scope: "spec",
              run,
              request: reviseSpecRequest(db, map, run, base, mapRounds),
            },
      );
    case "spec_review":
      return ok({
        purpose: "spec_review",
        run,
        request: reviewSpecRequest(db, map, run, base, mapRounds),
      });
    case "to_tickets":
      return ok({ purpose: "to_tickets", run, request: draftTicketSetRequest(db, run, base) });
    case "grilling": {
      const waypointId = present(run.waypointId, `Grilling run ${run.id}'s waypoint`);
      const mapWaypoints = readWaypoints(db, map.id);
      const waypoint = mapWaypoints.find((candidate) => candidate.id === waypointId);
      if (waypoint === undefined) {
        throw new Error(`Grilling run ${run.id}'s waypoint ${waypointId} is not on map ${map.id}`);
      }
      // A round withdrawn by a reopen (S7b-6) was never answered; it is left out of the record.
      const kept = waypointRounds(rounds, waypointId).filter(
        (round) => round.status !== "withdrawn",
      );
      const scope = scopeRuns(readMapRuns(db, map.id), waypointId);
      // Only a final round since the waypoint's work last ended makes this run "after final".
      // The waypoint's latest reopen cuts both the same way (L156 (1), L162 (1)).
      const reopenAt = reopenedAt(db, waypoint, kept);
      const current = currentRounds(kept, scope, reopenAt);
      // Rounds answered before a reopen are superseded context, not live answers (L156 (1)).
      const split = reopenSplit(kept, scope, reopenAt);
      const answeredOf = (round: (typeof kept)[number]) => {
        if (round.status !== "submitted" || round.answers === null) {
          throw new Error(`Round ${round.id} is not answered while its waypoint is grilled`);
        }
        return { questions: round.questions, answers: round.answers, final: round.final };
      };
      const previous = scope[scope.findIndex((candidate) => candidate.id === run.id) - 1];
      const finding = readFindings(db, map.id).find(
        (candidate) => candidate.waypointId === waypointId,
      );
      // A waypoint the finding names that a reopen (S7b-6) undid has no resolution to show: the
      // finding carries the ones still resolved, and none when every one was reopened.
      const numbered = (number: number) => {
        const named = mapWaypoints.find((candidate) => candidate.number === number);
        if (named === undefined) {
          throw new Error(
            `A finding names waypoint ${String(number)}, which is not on map ${map.id}`,
          );
        }
        return named.resolution === null
          ? []
          : [{ number, title: named.title, resolution: named.resolution }];
      };
      const findingWaypoints =
        finding === undefined ? [] : finding.waypointNumbers.flatMap(numbered);
      const titleOf = (id: string): string => {
        const other = mapWaypoints.find((candidate) => candidate.id === id);
        if (other === undefined) {
          throw new Error(`Round on waypoint ${id}, which is not on map ${map.id}`);
        }
        return other.title;
      };
      return ok({
        purpose: "grilling",
        run,
        request: {
          ...base,
          ...projectSuggestionContext(db, map.projectId),
          title: present(map.title, `Map ${map.id}'s title`),
          destination: present(map.destination, `Map ${map.id}'s destination`),
          mapRounds,
          waypoint: {
            number: waypoint.number,
            kind: waypoint.kind,
            title: waypoint.title,
            question: waypoint.question,
            rounds: split.live.map(answeredOf),
            reopened: split.reopened,
            supersededRounds: split.superseded.map(answeredOf),
            personDecides: waypoint.personDecides,
            touches: runTouches(db, waypoint.id),
          },
          otherWaypoints: mapWaypoints
            .filter((other) => other.id !== waypointId)
            .map((other) => ({
              number: other.number,
              kind: other.kind,
              title: other.title,
              status: other.status,
              gist: other.gist,
              agentDecided: other.agentDecided,
              resolution: other.resolution,
            })),
          otherPendingRounds: rounds
            .filter(
              (round) =>
                round.waypointId !== null &&
                round.waypointId !== waypointId &&
                round.status === "pending",
            )
            .map((round) => ({
              waypointTitle: titleOf(present(round.waypointId, `Round ${round.id}'s waypoint`)),
              questions: round.questions,
            })),
          fog: readFog(db, map.id),
          outOfScope: readExclusions(db, map.id).map((exclusion) => exclusion.text),
          survey: readCodeSurvey(db, map.id),
          finding:
            finding === undefined || findingWaypoints.length === 0
              ? null
              : {
                  kind: finding.kind,
                  explanation: finding.explanation,
                  waypoints: findingWaypoints,
                },
          reviewFindings: grillReviewFindings(db, map.id, waypointId),
          note: waypointNote(db, waypoint),
          afterFinal: current.at(-1)?.final === true,
          // The scope's run just before this one (a retry, or a fresh run after Try again), when
          // core refused its output (L142, L156 (1)).
          refusedAttempt:
            previous?.errorCode === "agent_output_invalid"
              ? { problem: present(previous.errorMessage, `Failed run ${previous.id}'s message`) }
              : null,
        },
      });
    }
    case "research": {
      const { waypoint, context } = waypointRunContext(db, run, map, base, mapRounds);
      const earlierReports = readReports(db, map.id)
        // An answered report resolved the waypoint before a reopen (S7b-6) undid that resolution;
        // the request carries the unanswered ones (an answered one would resolve it).
        .filter((report) => report.waypointId === waypoint.id && !report.answered)
        .map((report) => {
          return {
            answered: report.answered,
            summary: report.summary,
            gap: report.gap,
            gist: null,
            findings: report.findings,
            sources: report.sources,
            limitations: report.limitations,
            uncertainties: report.uncertainties,
          };
        });
      return ok({
        purpose: "research",
        run,
        request: {
          ...context,
          waypoint: { ...runWaypoint(waypoint), touches: runTouches(db, waypoint.id) },
          earlierReports,
        },
      });
    }
    case "task": {
      const { waypoint, context } = waypointRunContext(db, run, map, base, mapRounds);
      // A round withdrawn by a reopen (S7b-6) was never answered; it is left out of the record.
      const answered = waypointRounds(rounds, waypoint.id)
        .filter((round) => round.status !== "withdrawn")
        .map((round) => {
          if (round.status !== "submitted" || round.answers === null) {
            throw new Error(`Round ${round.id} is not answered while its task is worked`);
          }
          return { questions: round.questions, answers: round.answers };
        });
      const earlierOutcomes = readTaskOutcomes(db, map.id)
        .filter((outcome) => outcome.waypointId === waypoint.id)
        .map(({ outcome, action, facts }) => ({ outcome, action, facts }));
      return ok({
        purpose: "task",
        run,
        request: {
          ...context,
          waypoint: {
            ...runWaypoint(waypoint),
            rounds: answered,
            touches: runTouches(db, waypoint.id),
          },
          earlierOutcomes,
        },
      });
    }
    case "consistency": {
      const findings = readFindings(db, map.id);
      const byPerson = decidedByPerson(db, map.id);
      const mapWaypoints = readWaypoints(db, map.id);
      const fresh = newSinceLastPass(mapWaypoints, readPasses(db, map.id));
      return ok({
        purpose: "consistency",
        run,
        request: {
          ...base,
          ...projectSuggestionContext(db, map.projectId),
          title: present(map.title, `Map ${map.id}'s title`),
          destination: present(map.destination, `Map ${map.id}'s destination`),
          mapRounds,
          outOfScope: readExclusions(db, map.id).map((exclusion) => exclusion.text),
          survey: readCodeSurvey(db, map.id),
          waypoints: mapWaypoints
            .filter((waypoint) => waypoint.status === "resolved")
            .map((waypoint) => {
              const finding = findings.find((candidate) => candidate.waypointId === waypoint.id);
              return {
                number: waypoint.number,
                kind: waypoint.kind,
                title: waypoint.title,
                question: waypoint.question,
                resolution: present(waypoint.resolution, `Waypoint ${waypoint.id}'s resolution`),
                decidedByPerson: byPerson(waypoint),
                newSinceLastPass: fresh === null || fresh.has(waypoint.id),
                finding:
                  finding === undefined
                    ? null
                    : { kind: finding.kind, waypointNumbers: finding.waypointNumbers },
              };
            }),
        },
      });
    }
    case "hatch":
      return ok({ purpose: "hatch", run, request: hatchRequest(db, run, base, mapRounds) });
    case "tickets_review":
      return ok({
        purpose: "tickets_review",
        run,
        request: reviewTicketSetRequest(db, run, base),
      });
  }
}

/**
 * The problem core refused a chart's previous attempt with (DR-8, L253, as `mapRefusedAttempt` for
 * To Spec): the map scope's run just before `run` (a retry, or a fresh run after Try again) when it
 * is a `chart` that failed `agent_output_invalid`; null otherwise. The map scope also holds survey and
 * fog runs, so the purpose is checked.
 */
function chartRefusedAttempt(
  db: ZeNormDatabase,
  run: PlanningRun,
): ChartMapRequest["refusedAttempt"] {
  const scope = scopeRuns(readMapRuns(db, run.mapId), null);
  const previous = scope[scope.findIndex((candidate) => candidate.id === run.id) - 1];
  if (previous?.purpose !== "chart" || previous.errorCode !== "agent_output_invalid") {
    return null;
  }
  return { problem: present(previous.errorMessage, `Failed run ${previous.id}'s message`) };
}

/** The map-level rounds of map `mapId`, as every run that decides or checks scope reads them. */
export function readMapRounds(db: ZeNormDatabase, mapId: string): MapRound[] {
  return mapRoundsOf(readRounds(db, mapId));
}

/**
 * The note a waypoint's run carries (S7b-10): the hatch message that last opened, reopened,
 * reworded or directed it, with when it was sent; null when no message did.
 */
function waypointNote(db: ZeNormDatabase, waypoint: Waypoint): WaypointNote | null {
  if (waypoint.hatchMessageId === null) {
    return null;
  }
  const message = db
    .select({ text: hatchMessages.text, sentAt: hatchMessages.sentAt })
    .from(hatchMessages)
    .where(eq(hatchMessages.id, waypoint.hatchMessageId))
    .get();
  if (message === undefined) {
    throw new Error(`Waypoint ${waypoint.id}'s message ${waypoint.hatchMessageId} does not exist`);
  }
  return message;
}

/** The waypoint a Research or Task run works, by its number, kind, title and question. */
function runWaypoint(waypoint: Waypoint): Omit<ResearchWaypointRequest["waypoint"], "touches"> {
  return {
    number: waypoint.number,
    kind: waypoint.kind,
    title: waypoint.title,
    question: waypoint.question,
  };
}

/** The run's waypoint and the map context every Research and Task request carries (spec D2). */
function waypointRunContext(
  db: ZeNormDatabase,
  run: PlanningRun,
  map: Pick<MapRecord, "id" | "projectId" | "title" | "destination">,
  base: Pick<ResearchWaypointRequest, "projectName" | "projectFolder" | "baseBranch" | "idea">,
  mapRounds: MapRound[],
): {
  waypoint: Waypoint;
  context: Omit<ResearchWaypointRequest, "waypoint" | "earlierReports">;
} {
  const waypointId = present(run.waypointId, `${run.purpose} run ${run.id}'s waypoint`);
  const mapWaypoints = readWaypoints(db, map.id);
  const waypoint = mapWaypoints.find((candidate) => candidate.id === waypointId);
  if (waypoint === undefined) {
    throw new Error(`Run ${run.id}'s waypoint ${waypointId} is not on map ${map.id}`);
  }
  return {
    waypoint,
    context: {
      ...base,
      ...projectSuggestionContext(db, map.projectId),
      title: present(map.title, `Map ${map.id}'s title`),
      destination: present(map.destination, `Map ${map.id}'s destination`),
      mapRounds,
      otherWaypoints: mapWaypoints
        .filter((other) => other.id !== waypointId)
        .map((other) => ({
          number: other.number,
          kind: other.kind,
          title: other.title,
          status: other.status,
          gist: other.gist,
          agentDecided: other.agentDecided,
          resolution: other.resolution,
        })),
      fog: readFog(db, map.id),
      outOfScope: readExclusions(db, map.id).map((exclusion) => exclusion.text),
      survey: readCodeSurvey(db, map.id),
      note: waypointNote(db, waypoint),
    },
  };
}
