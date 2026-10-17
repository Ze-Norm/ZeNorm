import { err, ok } from "@zenorm/contracts";
import type {
  Actor,
  Answers,
  CreateMapError,
  CreateMapInput,
  MapDetail,
  MapNotFoundError,
  MapRecord,
  Project,
  ProjectNotFoundError,
  QuestionRound,
  Result,
  RoundQuestions,
  SubmitAnswersError,
  SubmitAnswersInput,
  UserActor,
} from "@zenorm/contracts";
import { mapProposals, maps, projects, questionRounds } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { mapRecordColumns } from "./planning-runs.ts";
import type { Reader, Tx } from "./planning-runs.ts";
import { getProject, isDirectory, toProject } from "./project.ts";
import { planAndRelease } from "./spec-holds.ts";
import { write } from "./writes.ts";

/** The project's maps, oldest first, or `project_not_found`. */
export async function listMaps(
  db: ZeNormDatabase,
  projectId: string,
): Promise<Result<MapRecord[], ProjectNotFoundError>> {
  const project = await getProject(db, projectId);
  if (!project.ok) {
    return project;
  }
  return ok(readMapsOfProject(db, projectId));
}

/** The maps of the project `projectId`, oldest first (as `listMaps` lists them). */
export function readMapsOfProject(db: Reader, projectId: string): MapRecord[] {
  return db
    .select(mapRecordColumns)
    .from(maps)
    .where(eq(maps.projectId, projectId))
    .orderBy(asc(maps.createdAt), asc(maps.id))
    .all();
}

/**
 * The project a new map is created in, refused as `map.create` refuses it (S6a-2):
 * `project_not_found`, or `project_folder_missing` when its folder is gone.
 */
export async function projectForNewMap(
  db: ZeNormDatabase,
  projectId: string,
): Promise<Result<Project, CreateMapError>> {
  const found = await getProject(db, projectId);
  if (!found.ok) {
    return found;
  }
  const project = found.value;
  if (!(await isDirectory(project.folderPath))) {
    return err({
      code: "project_folder_missing",
      message: `${project.folderPath} does not exist or is not a directory`,
      data: { folderPath: project.folderPath },
    });
  }
  return ok(project);
}

/**
 * Inserts a new map created by `actor`'s User (S9-11) and inserts what it makes due, its first
 * `chart` run, in the caller's transaction: `map.create`'s insert, and a confirmed proposal's, which
 * names the map and run it was split from (map proposals).
 */
export function insertMap(
  actor: UserActor,
  tx: Tx,
  map: {
    readonly projectId: string;
    readonly idea: string;
    readonly splitFromMapId: string | null;
    readonly splitFromRunId: string | null;
  },
): MapRecord {
  const record: MapRecord = {
    id: uuidv7(),
    projectId: map.projectId,
    idea: map.idea,
    title: null,
    summary: null,
    destination: null,
    destinationConfirmedAt: null,
    createdAt: new Date().toISOString(),
    splitFromMapId: map.splitFromMapId,
    splitFromRunId: map.splitFromRunId,
  };
  tx.insert(maps)
    .values({ ...record, fogNextPosition: 1, userId: actor.userId })
    .run();
  planAndRelease(actor, tx, record.id);
  return record;
}

/**
 * Starts a map (S6a-2) taking its creator's User (S9-11): stores it and its first `chart` run in one transaction and returns
 * without waiting on the agent. Refuses only `project_not_found` and `project_folder_missing`,
 * writing nothing.
 */
export async function createMap(
  actor: UserActor,
  db: ZeNormDatabase,
  input: CreateMapInput,
): Promise<Result<MapDetail, CreateMapError>> {
  const found = await projectForNewMap(db, input.projectId);
  if (!found.ok) {
    return found;
  }
  const project = found.value;
  const map = write(db, actor, (tx) =>
    insertMap(actor, tx, {
      projectId: project.id,
      idea: input.idea,
      splitFromMapId: null,
      splitFromRunId: null,
    }),
  );
  return ok({ map, project });
}

/** The map with its project, or `map_not_found`. */
export async function getMap(
  db: ZeNormDatabase,
  mapId: string,
): Promise<Result<MapDetail, MapNotFoundError>> {
  const map = db.select(mapRecordColumns).from(maps).where(eq(maps.id, mapId)).get();
  if (map === undefined) {
    return err({ code: "map_not_found", message: `No map with id ${mapId}`, data: { mapId } });
  }
  const projectRow = db.select().from(projects).where(eq(projects.id, map.projectId)).get();
  if (projectRow === undefined) {
    throw new Error(`Map ${mapId} references missing project ${map.projectId}`);
  }
  return ok({ map, project: await toProject(db, projectRow) });
}

/**
 * The index of the first question whose answer is invalid, `null` when the answer count is
 * wrong, or `undefined` when every answer is valid (S6a-9): each answer names an option of its
 * question, has words, or both; an `accepted` answer is option 0 with no words.
 */
function invalidAnswerIndex(
  questions: RoundQuestions,
  answers: Answers,
): number | null | undefined {
  if (answers.length !== questions.length) {
    return null;
  }
  const index = answers.findIndex((answer, i) => {
    const question = questions[i];
    if (question === undefined) {
      throw new Error(`No question at index ${String(i)}`);
    }
    const { optionIndex, note, accepted } = answer;
    if (optionIndex !== null && optionIndex >= question.options.length) {
      return true;
    }
    if (accepted) {
      return optionIndex !== 0 || note.length > 0;
    }
    return optionIndex === null && note.length === 0;
  });
  return index === -1 ? undefined : index;
}

/** Whether the map has a map the first chart offered to split off, still undecided. */
function undecidedSplit(tx: Tx, mapId: string): boolean {
  return (
    tx
      .select({ id: mapProposals.id })
      .from(mapProposals)
      .where(
        and(
          eq(mapProposals.mapId, mapId),
          eq(mapProposals.kind, "split"),
          eq(mapProposals.state, "pending"),
        ),
      )
      .get() !== undefined
  );
}

/**
 * Stores a pending round's answers and inserts what they make due in the same transaction (S6a-9;
 * the chart after the map-level round, D3). Refuses an unknown round, an invalid submission, a
 * round no longer pending, and a map-level round while a map the first chart offered to split off
 * is undecided (`round_split_undecided`, idea-phase split: the destination is confirmed knowing what
 * stays in this map), and writes nothing on any refusal.
 */
export function submitAnswers(
  actor: Actor,
  db: ZeNormDatabase,
  input: SubmitAnswersInput,
): Result<QuestionRound, SubmitAnswersError> {
  const { roundId, answers } = input;
  return write(db, actor, (tx): Result<QuestionRound, SubmitAnswersError> => {
    const round = tx.select().from(questionRounds).where(eq(questionRounds.id, roundId)).get();
    if (round === undefined) {
      return err({
        code: "round_not_found",
        message: `No question round with id ${roundId}`,
        data: { roundId },
      });
    }
    if (round.status !== "pending") {
      return err({
        code: "round_already_submitted",
        message: `Question round ${roundId} is ${round.status}, not pending`,
        data: { roundId },
      });
    }
    if (round.waypointId === null && undecidedSplit(tx, round.mapId)) {
      return err({
        code: "round_split_undecided",
        message: `Map ${round.mapId} has a split offer to create or dismiss before its round`,
        data: { roundId },
      });
    }
    const questionIndex = invalidAnswerIndex(round.questions, answers);
    if (questionIndex !== undefined) {
      return err({
        code: "round_answers_invalid",
        message:
          questionIndex === null
            ? `Expected ${String(round.questions.length)} answers, got ${String(answers.length)}`
            : `Answer ${String(questionIndex)} names no option of its question, has neither an option nor words, or is accepted without being option 0 alone`,
        data: { roundId, questionIndex },
      });
    }
    const submittedAt = new Date().toISOString();
    const submitted: QuestionRound = { ...round, status: "submitted", answers, submittedAt };
    const updated = tx
      .update(questionRounds)
      .set({ status: submitted.status, answers, submittedAt: submitted.submittedAt })
      .where(and(eq(questionRounds.id, roundId), eq(questionRounds.status, "pending")))
      .run();
    if (updated.changes !== 1) {
      throw new Error(`Question round ${roundId} stopped being pending inside its transaction`);
    }
    planAndRelease(actor, tx, round.mapId);
    return ok(submitted);
  });
}
