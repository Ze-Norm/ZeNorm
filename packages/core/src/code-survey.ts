import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ok } from "@zenorm/contracts";
import type { Actor, CodeSurvey, Result, SurveyCodeRequest } from "@zenorm/contracts";
import { codeSurveys } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { eq } from "drizzle-orm";

import {
  endRun,
  isReplaced,
  now,
  readMap,
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
  readonly projectName: SurveyCodeRequest["projectName"];
  readonly projectFolder: SurveyCodeRequest["projectFolder"];
  readonly baseBranch: SurveyCodeRequest["baseBranch"];
  readonly idea: SurveyCodeRequest["idea"];
}

/** A `survey` run's request: the map as its confirming chart left it. */
export function surveyCodeRequest(db: Reader, mapId: string, base: RequestBase): SurveyCodeRequest {
  const map = readMap(db, mapId);
  return {
    ...base,
    title: present(map.title, `Map ${mapId}'s title`),
    destination: present(map.destination, `Map ${mapId}'s destination`),
    waypoints: readWaypoints(db, mapId).map((waypoint) => ({
      number: waypoint.number,
      kind: waypoint.kind,
      title: waypoint.title,
      question: waypoint.question,
    })),
    fog: readFog(db, mapId),
    outOfScope: readExclusions(db, mapId).map((exclusion) => exclusion.text),
  };
}

/** The map's current code survey, or null before its `survey` run completed. */
export function readCodeSurvey(db: Reader, mapId: string): CodeSurvey | null {
  const row = db
    .select({ content: codeSurveys.content })
    .from(codeSurveys)
    .where(eq(codeSurveys.mapId, mapId))
    .get();
  return row === undefined ? null : row.content;
}

/** How many lines `path` has (a final newline ends the last line), or null when it is no file. */
function fileLineCount(path: string): number | null {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats?.isFile() !== true) {
    return null;
  }
  const text = readFileSync(path, "utf8");
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** Why `path:line` is not a line of a file of the project at `folder`, or null when it is. */
export function sourceLineProblem(folder: string, path: string, line: number): string | null {
  const count = fileLineCount(join(folder, path));
  if (count === null) {
    return `names ${path}, which is not a file of the project`;
  }
  if (line > count) {
    return `names ${path}:${String(line)}, past the file's ${String(count)} lines`;
  }
  return null;
}

/**
 * The first source of `survey` the project at `folder` does not have, as a refusal, or null: every
 * area must exist (a file or directory), every surface file must be a file, and every fact's,
 * identifier's, lifecycle transition's and terminal state's line must be a line of its file.
 */
export function surveySourceProblem(folder: string, survey: CodeSurvey): RunFailure | null {
  const unknown = (what: string, detail: string): RunFailure => ({
    code: "survey_source_unknown",
    message: `${what} ${detail}`,
  });
  const lineProblem = (what: string, path: string, line: number): RunFailure | null => {
    const problem = sourceLineProblem(folder, path, line);
    return problem === null ? null : unknown(what, problem);
  };
  for (const [index, entry] of survey.entries.entries()) {
    const where = `Entry ${String(index + 1)} (${entry.area})`;
    if (statSync(join(folder, entry.area), { throwIfNoEntry: false }) === undefined) {
      return unknown(where, `names ${entry.area}, which the project does not have`);
    }
    for (const file of entry.surfaceFiles) {
      if (fileLineCount(join(folder, file)) === null) {
        return unknown(where, `names surface file ${file}, which is not a file of the project`);
      }
    }
    for (const [factIndex, fact] of entry.facts.entries()) {
      const problem = lineProblem(`${where} fact ${String(factIndex + 1)}`, fact.path, fact.line);
      if (problem !== null) return problem;
    }
  }
  for (const [index, identifier] of survey.identifiers.entries()) {
    const problem = lineProblem(
      `Identifier ${String(index + 1)} (${identifier.name})`,
      identifier.path,
      identifier.line,
    );
    if (problem !== null) return problem;
  }
  if (survey.lifecycles === undefined) {
    // A survey written before lifecycles has none to check.
    return null;
  }
  for (const [index, lifecycle] of survey.lifecycles.entries()) {
    const where = `Lifecycle ${String(index + 1)} (${lifecycle.record})`;
    const cited = [
      ...lifecycle.transitions.map((transition) => ({
        what: `transition ${transition.from} to ${transition.to}`,
        source: transition,
      })),
      ...lifecycle.terminal.map((terminal) => ({
        what: `terminal state ${terminal.state}`,
        source: terminal,
      })),
    ];
    for (const { what, source } of cited) {
      const problem = lineProblem(`${where} ${what}`, source.path, source.line);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/**
 * Saves a `survey` run's code survey as the map's current one in one transaction and inserts what
 * it makes due: the frontier's waypoint runs, or the map's next run. A survey naming a path or line
 * the project does not have is refused `survey_source_unknown`: the run fails, follows the retry
 * rules, and nothing is written. The paths are checked in `folder`, the one the run's checkout
 * gave.
 */
export function recordSurvey(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  folder: string,
  survey: CodeSurvey,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      // A run cancelled while its call was out saves nothing and is not retried.
      return ok(null);
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "survey") {
      throw new Error(`Planning run ${runId} is a ${run.purpose} run, not survey`);
    }
    const problem = surveySourceProblem(folder, survey);
    if (problem !== null) {
      return refuse(actor, tx, run, problem);
    }
    const values = { runId, content: survey, createdAt: now() };
    tx.insert(codeSurveys)
      .values({ mapId: run.mapId, ...values })
      .onConflictDoUpdate({ target: codeSurveys.mapId, set: values })
      .run();
    endRun(tx, runId, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}
