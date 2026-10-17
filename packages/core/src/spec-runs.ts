import { ok, SpecRevisionContent } from "@zenorm/contracts";
import type {
  Actor,
  DraftSpecsOutcome,
  PlanningRun,
  PlanningRunPurpose,
  Result,
  ReviseSpecOutcome,
  SpecHold,
  SpecRemovals,
  SpecReviewOutcome,
  SpecReviewSource,
  Waypoint,
} from "@zenorm/contracts";
import {
  maps,
  planningRuns,
  projects,
  specifications,
  specReviewFindings,
  specReviews,
  specRevisions,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import {
  cancelRun,
  endRun,
  isReplaced,
  now,
  readWaypoints,
  refuse,
  runningRun,
  specRuns,
  stoppedRun,
} from "./planning-runs.ts";
import type { Reader, RunFailure, Tx } from "./planning-runs.ts";
import { readCodeSurvey, sourceLineProblem } from "./code-survey.ts";
import { escalatedPositions, escalationWaypoint } from "./spec-escalation.ts";
import { referencesProblem } from "./spec-references.ts";
import {
  closeWait,
  planAndRelease,
  recordWait,
  releasedWaitOf,
  reopenWait,
  specHold,
  waitsOnAny,
} from "./spec-holds.ts";
import {
  compareElementIds,
  elementIds,
  isDraft,
  latestOf,
  retiredIds,
  noteAfter,
  readMapSpecs,
  readNoteDirectedRevisions,
  readNoteText,
  readProjectSpecs,
  readReview,
  readSpecRevisions,
} from "./specs.ts";
import type { StoredRevision, StoredSpec } from "./specs.ts";
import { readExclusions } from "./wayfinding-records.ts";
import { present } from "./present.ts";
import { specLintProblem } from "./spec-lint.ts";
import { reviewedRevision, runSpec } from "./spec-requests.ts";
import { write } from "./writes.ts";
function contentInvalid(message: string): RunFailure {
  return { code: "spec_content_invalid", message };
}

/**
 * The first problem of a revision's content, or null; `earlier` holds the spec's revisions before
 * it, oldest first (none for revision 1). Clause ids `C<n>` and criterion ids `<n>.<k>` under their
 * clause, unique; no id that an earlier revision used but the revision before dropped (a retired
 * id); `was` names an id of the revision before that this revision drops; a clause new in the
 * revision has a source (a kept clause may list none); every waypoint source is resolved on the
 * map; a note source only when `noted`: the revision or an earlier one of the spec is
 * note-directed. A kept id with new wording passes: the review judges it. Then the lint
 * (`specLintProblem`): criterion order, conditional and silent-default phrasing, nested backticks,
 * every problem in one message.
 */
export function revisionProblem(
  content: SpecRevisionContent,
  resolved: ReadonlySet<number>,
  earlier: readonly SpecRevisionContent[],
  noted: boolean,
): RunFailure | null {
  const parsed = SpecRevisionContent.safeParse(content);
  if (!parsed.success) {
    return contentInvalid(
      `The revision breaks the skill's "The document" rules: ${parsed.error.message}`,
    );
  }
  const before = earlier.at(-1);
  const kept = before === undefined ? new Set<string>() : elementIds(before);
  const retiredList = retiredIds(earlier);
  const retired = new Set(retiredList);
  const ids = elementIds(content);
  const seen = new Set<string>();
  for (const clause of content.clauses) {
    for (const id of [clause.id, ...clause.criteria.map((criterion) => criterion.id)]) {
      if (seen.has(id)) {
        return contentInvalid(`Id ${id} appears twice in the revision`);
      }
      if (retired.has(id)) {
        return contentInvalid(
          `Id ${id} was retired by an earlier revision and cannot return. The spec's retired ids are ${retiredList.join(", ")}; ${nextFree(id, earlier)}`,
        );
      }
      seen.add(id);
    }
    const clauseNumber = clause.id.slice(1);
    const outside = clause.criteria.find(
      (criterion) => criterion.id.split(".")[0] !== clauseNumber,
    );
    if (outside !== undefined) {
      return contentInvalid(`Criterion ${outside.id} is not under clause ${clause.id}`);
    }
    for (const criterion of clause.criteria) {
      if (criterion.was === undefined) {
        continue;
      }
      if (before === undefined) {
        return contentInvalid(
          `Criterion ${criterion.id} names a revision before, but there is none`,
        );
      }
      if (!kept.has(criterion.was) || ids.has(criterion.was)) {
        return contentInvalid(
          `Criterion ${criterion.id}'s was names ${criterion.was}, which is not an id the revision before had and this one drops`,
        );
      }
    }
    if (clause.sources.length === 0 && !kept.has(clause.id)) {
      return contentInvalid(`Clause ${clause.id} is new in the revision and has no source`);
    }
    for (const source of clause.sources) {
      if (source.kind === "waypoint" && !resolved.has(source.number)) {
        return contentInvalid(
          `Clause ${clause.id} names waypoint ${String(source.number)}, which is not resolved on the map`,
        );
      }
      if (source.kind === "note" && !noted) {
        return contentInvalid(
          `Clause ${clause.id} names a note, but no revision of the spec is note-directed: cite the resolved waypoints that decided it, or the destination`,
        );
      }
    }
  }
  const lint = specLintProblem(content);
  return lint === null ? null : contentInvalid(lint);
}

/**
 * The problem of a repair's declared removals, or null: the ids it actually drops (every id
 * of `before`, the spec's latest revision, that `content` lacks, a dropped clause's criteria and a
 * moved criterion's old id included) must be exactly the declared ids, each declared once. Every
 * mismatch, either way, is named in one message.
 */
export function removalsProblem(
  removed: SpecRemovals,
  before: SpecRevisionContent,
  content: SpecRevisionContent,
): RunFailure | null {
  const now = elementIds(content);
  const dropped = [...elementIds(before)].filter((id) => !now.has(id));
  const declaredList = removed.map((removal) => removal.id);
  const declared = new Set(declaredList);
  const problems = [
    ...declaredList
      .filter((id, index) => declaredList.indexOf(id) !== index)
      .map((id) => `${id} is declared removed twice`),
    ...dropped
      .filter((id) => !declared.has(id))
      .map((id) => `${id} is dropped but not declared in removed`),
    ...[...declared]
      .filter((id) => !dropped.includes(id))
      .map((id) =>
        now.has(id)
          ? `${id} is declared in removed but the revision still has it`
          : `${id} is declared in removed but the revision before never had it`,
      ),
  ];
  return problems.length === 0
    ? null
    : contentInvalid(
        `The revision's removed list does not match the ids it drops from revision before: ${problems.join("; ")}. Declare exactly each dropped clause and criterion id, with why, or keep it.`,
      );
}

/**
 * The next id unused by every revision of the spec, in place of a retired `id`: the next
 * clause number, or the next criterion number under the criterion's clause.
 */
function nextFree(id: string, earlier: readonly SpecRevisionContent[]): string {
  const used = earlier.flatMap((revision) => [...elementIds(revision)]);
  if (id.startsWith("C")) {
    const top = Math.max(
      ...used.filter((other) => other.startsWith("C")).map((c) => Number(c.slice(1))),
    );
    return `the next unused clause id is C${String(top + 1)}`;
  }
  const clause = id.split(".")[0];
  const under = used
    .filter((other) => !other.startsWith("C") && other.split(".")[0] === clause)
    .map((other) => Number(other.split(".")[1]));
  return `the next unused criterion id under C${String(clause)} is ${String(clause)}.${String(Math.max(...under) + 1)}`;
}

function resolvedNumbers(mapWaypoints: readonly Waypoint[]): Set<number> {
  return new Set(
    mapWaypoints
      .filter((waypoint) => waypoint.status === "resolved")
      .map((waypoint) => waypoint.number),
  );
}

/**
 * Whether the next revision after the spec's latest may cite a note: a revision of
 * the spec is note-directed, or a note superseded the latest, so the next is.
 */
function isNoted(db: Reader, latest: StoredRevision): boolean {
  return (
    readNoteDirectedRevisions(db, latest.specificationId).length > 0 ||
    (latest.supersededAt !== null && noteAfter(db, latest, null) !== null)
  );
}

/**
 * Writes the run's revision of the spec whose latest revision is `latest`.
 * A draft of the run's map no one has acted on (neither approved nor superseded: no rejection, no
 * note) is rewritten in place (`rewriteDraft`): an agent's repair or re-clear of it is no new
 * revision. Else the spec's next revision is inserted; an approved revision stays approved. In the
 * same transaction every running `to_tickets` and `tickets_review` on the spec ends `cancelled`,
 * `replaced`: its set is replaced by the newer revision and its late result saves nothing (another
 * map's such run is a `tickets` hold, so it is this map's). The map's open wait on the spec closes,
 * released by the run.
 */
function writeNextRevision(
  tx: Tx,
  run: PlanningRun,
  latest: StoredRevision,
  content: SpecRevisionContent,
  removed: SpecRemovals | null,
  at: string,
): void {
  const replaced = tx
    .select({ id: planningRuns.id })
    .from(planningRuns)
    .where(
      and(
        eq(planningRuns.specificationId, latest.specificationId),
        eq(planningRuns.state, "running"),
        inArray(planningRuns.purpose, ["to_tickets", "tickets_review"]),
      ),
    )
    .all();
  for (const ticketRun of replaced) {
    cancelRun(tx, ticketRun.id, "replaced");
  }
  cancelStoppedRuns(tx, latest.specificationId, ["to_tickets", "tickets_review"], at);
  if (isDraft(latest) && latest.mapId === run.mapId) {
    rewriteDraft(tx, run, latest, content, removed, at);
  } else {
    tx.insert(specRevisions)
      .values({
        id: uuidv7(),
        specificationId: latest.specificationId,
        revision: latest.revision + 1,
        mapId: run.mapId,
        writtenByRun: run.id,
        content,
        removed,
        createdAt: at,
        approvedAt: null,
        supersededAt: null,
        rejectionReason: null,
      })
      .run();
  }
  closeWait(tx, { mapId: run.mapId, specificationId: latest.specificationId, runId: run.id }, at);
}

/**
 * Rewrites the map's draft in place with the run's content: a new revision needs the person
 * to have acted on the one before (approved, rejected or noted it), so an agent's rewrite of a draft
 * no one has acted on keeps its number and its `created_at`. The run checked `content` against the
 * draft as the revision before; it is stored against the revision before the draft (`asOfBaseline`),
 * as a new revision would have been. A review of the draft's earlier content stays, an earlier
 * review (`earlierReviews`); a `spec_review` of it that runs or is stopped ends `cancelled`,
 * `replaced`, and the rewritten content is reviewed afresh.
 */
function rewriteDraft(
  tx: Tx,
  run: PlanningRun,
  draft: StoredRevision,
  content: SpecRevisionContent,
  removed: SpecRemovals | null,
  at: string,
): void {
  const baseline = readSpecRevisions(tx, draft.specificationId)
    .filter((revision) => revision.revision < draft.revision)
    .at(-1);
  const stored = asOfBaseline(content, draft.content, baseline?.content);
  const rewritten = tx
    .update(specRevisions)
    .set({
      content: stored,
      removed:
        baseline === undefined || draft.removed === null || removed === null
          ? null
          : removedSince(baseline.content, stored, [...removed, ...draft.removed]),
      writtenByRun: run.id,
    })
    .where(
      and(
        eq(specRevisions.id, draft.id),
        eq(specRevisions.mapId, run.mapId),
        isNull(specRevisions.approvedAt),
        isNull(specRevisions.supersededAt),
      ),
    )
    .run();
  if (rewritten.changes !== 1) {
    throw new Error(`Revision ${draft.id} was not a draft of map ${run.mapId} when rewritten`);
  }
  const reviews = tx
    .select({ id: planningRuns.id })
    .from(planningRuns)
    .where(
      and(
        eq(planningRuns.specificationId, draft.specificationId),
        eq(planningRuns.state, "running"),
        eq(planningRuns.purpose, "spec_review"),
      ),
    )
    .all();
  for (const review of reviews) {
    cancelRun(tx, review.id, "replaced");
  }
  cancelStoppedRuns(tx, draft.specificationId, ["spec_review"], at);
}

/**
 * `content`, written against `draft` as the revision before, restated against `baseline`, the
 * revision before the draft (none for revision 1): each criterion's `was` names the baseline id it
 * descends from, through the draft (a criterion the draft moved keeps the draft's `was`; one moved
 * from a criterion the draft moved names that one's origin), and is left out when it descends from
 * no baseline id the content drops.
 */
function asOfBaseline(
  content: SpecRevisionContent,
  draft: SpecRevisionContent,
  baseline: SpecRevisionContent | undefined,
): SpecRevisionContent {
  const kept = baseline === undefined ? new Set<string>() : elementIds(baseline);
  const ids = elementIds(content);
  const draftWas = new Map(
    draft.clauses.flatMap((clause) =>
      clause.criteria.flatMap((criterion) =>
        criterion.was === undefined ? [] : [[criterion.id, criterion.was] as const],
      ),
    ),
  );
  return {
    ...content,
    clauses: content.clauses.map((clause) => ({
      ...clause,
      criteria: clause.criteria.map((criterion) => {
        const { was: written, ...rest } = criterion;
        const from = written ?? criterion.id;
        const origin = draftWas.has(from) ? draftWas.get(from) : written;
        return origin !== undefined && kept.has(origin) && !ids.has(origin)
          ? { ...rest, was: origin }
          : rest;
      }),
    })),
  };
}

/**
 * The ids `baseline` has that `content` drops, each with the reason a run declared for it, in id
 * order: a rewrite's own removals and the draft's, both checked when written.
 */
function removedSince(
  baseline: SpecRevisionContent,
  content: SpecRevisionContent,
  declared: SpecRemovals,
): SpecRemovals {
  const ids = elementIds(content);
  return [...elementIds(baseline)]
    .filter((id) => !ids.has(id))
    .sort(compareElementIds)
    .map((id) => {
      const removal = declared.find((candidate) => candidate.id === id);
      if (removal === undefined) {
        throw new Error(`Id ${id} is dropped since the revision before the draft with no reason`);
      }
      return removal;
    });
}

/**
 * Ends each map's stopped run of one of `purposes` on the spec (its spec scope's latest run, a
 * failed retry) `cancelled`, `replaced`, as a running one is (a stale run never blocks the newer
 * state): it no longer holds the spec, blocks the newer content's `spec_review` or offers Try
 * again. Its error columns are cleared (a cancelled run has none).
 */
function cancelStoppedRuns(
  tx: Tx,
  specificationId: string,
  purposes: readonly PlanningRunPurpose[],
  at: string,
): void {
  const runs = tx
    .select()
    .from(planningRuns)
    .where(eq(planningRuns.specificationId, specificationId))
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all();
  const latestByMap = new Map(runs.map((run) => [run.mapId, run]));
  for (const latest of latestByMap.values()) {
    if (
      !purposes.includes(latest.purpose) ||
      stoppedRun(
        specRuns(
          runs.filter((run) => run.mapId === latest.mapId),
          specificationId,
        ),
      )?.runId !== latest.id
    ) {
      continue;
    }
    const cancelled = tx
      .update(planningRuns)
      .set({
        state: "cancelled",
        cancelReason: "replaced",
        errorCode: null,
        errorMessage: null,
        endedAt: at,
      })
      .where(and(eq(planningRuns.id, latest.id), eq(planningRuns.state, "failed")))
      .run();
    if (cancelled.changes !== 1) {
      throw new Error(`Stopped run ${latest.id} was not failed when replaced`);
    }
  }
}

/** A spec the run may write the next revision of. */
interface TargetSpec {
  readonly number: number;
  readonly latest: StoredRevision;
  /** Every revision of the spec, oldest first: ids are checked against them all. */
  readonly revisions: readonly StoredRevision[];
  /** Whether its next revision may cite a note (`isNoted`). */
  readonly noted: boolean;
}

function targetOf(db: Reader, spec: StoredSpec): TargetSpec {
  const revisions = readSpecRevisions(db, spec.id);
  const latest = latestOf(revisions);
  return { number: spec.number, latest, revisions, noted: isNoted(db, latest) };
}

/**
 * Records a map-scope `to_spec` run's outcome in one transaction: each new spec (`specNumber` null)
 * numbered per project at revision 1; the next revision of every spec whose latest revision is this
 * map's unapproved one (the re-clear must name each; another map's draft of a spec is a hold, not
 * one to leave out); the next revision of a project spec whose latest revision is approved, on any
 * map, when nothing holds it (`specHold`), leaving that revision approved; an approved spec the run
 * does not name is untouched. Each wait names a held spec of the project, and records it with the
 * hold seen now or replaces the note of the map's open wait on it; an open wait the run leaves out
 * is kept. Zero specs is accepted when the outcome has a wait, the map wrote specs (all approved,
 * else one is left out), or the map waits on a spec.
 * Output breaking the schema or the id rules, naming a spec it may not write, naming one twice,
 * leaving one out, a wait on an unheld spec or a spec named twice fails the run
 * `spec_content_invalid` and writes nothing; the retry carries the problem.
 */
export function recordSpecs(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: DraftSpecsOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      // A run a reopen cancelled saves nothing and is not retried.
      return ok(null);
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "to_spec" || run.specificationId !== null || run.waypointId !== null) {
      throw new Error(`Planning run ${runId} is not a map-scope to_spec run`);
    }
    const projectId = mapProjectId(tx, run.mapId);
    const projectSpecs = readProjectSpecs(tx, projectId);
    const resolved = resolvedNumbers(readWaypoints(tx, run.mapId));
    const mapSpecs = readMapSpecs(tx, run.mapId);
    // The re-clear names every spec whose latest revision is this map's unapproved one.
    const open: TargetSpec[] = mapSpecs
      .map((spec) => targetOf(tx, spec))
      .filter((spec) => spec.latest.mapId === run.mapId && spec.latest.approvedAt === null);
    // Zero specs is accepted when the outcome names a wait, or on a re-clear of a map that wrote
    // specs (all approved, else one is left out below) or waits on one (it keeps that wait).
    if (
      outcome.specs.length === 0 &&
      outcome.waits.length === 0 &&
      mapSpecs.length === 0 &&
      !waitsOnAny(tx, run.mapId)
    ) {
      return refuse(actor, tx, run, contentInvalid("The run wrote no spec and named no wait"));
    }
    const named = new Map<number, TargetSpec>();
    for (const [index, written] of outcome.specs.entries()) {
      const label = `Spec ${String(index + 1)}`;
      let earlier: SpecRevisionContent[] = [];
      let noted = false;
      if (written.specNumber !== null) {
        const target = writableSpec(tx, run, projectSpecs, open, written.specNumber);
        if (target === null || named.has(target.number)) {
          return refuse(
            actor,
            tx,
            run,
            contentInvalid(
              `${label} names spec ${String(written.specNumber)}, which is neither an unapproved spec of the map nor an unheld spec whose latest revision is approved, or is named twice`,
            ),
          );
        }
        named.set(target.number, target);
        earlier = target.revisions.map((revision) => revision.content);
        noted = target.noted;
      }
      const problem =
        revisionProblem(written.content, resolved, earlier, noted) ??
        declarationsProblem(tx, run.mapId, written.content);
      if (problem !== null) {
        return refuse(actor, tx, run, {
          code: problem.code,
          message: `${label}: ${problem.message}`,
        });
      }
    }
    const left = open.find((spec) => !named.has(spec.number));
    if (left !== undefined) {
      return refuse(
        actor,
        tx,
        run,
        contentInvalid(
          `Spec ${String(left.number)}'s latest revision is unapproved, but the run wrote no next revision of it`,
        ),
      );
    }
    const waits: { specificationId: string; note: string; hold: SpecHold }[] = [];
    for (const [index, wait] of outcome.waits.entries()) {
      const label = `Wait ${String(index + 1)}`;
      const spec = projectSpecs.find((candidate) => candidate.number === wait.specNumber);
      if (
        spec === undefined ||
        named.has(wait.specNumber) ||
        waits.some((other) => other.specificationId === spec.id)
      ) {
        return refuse(
          actor,
          tx,
          run,
          contentInvalid(
            `${label} names spec ${String(wait.specNumber)}, which is not a spec of the project, or is named twice`,
          ),
        );
      }
      const hold = specHold(tx, spec.id, run.mapId);
      if (hold === null) {
        return refuse(
          actor,
          tx,
          run,
          contentInvalid(
            `${label} names spec ${String(wait.specNumber)}, which nothing holds: write its next revision instead`,
          ),
        );
      }
      waits.push({ specificationId: spec.id, note: wait.note, hold });
    }
    // Specs number per project from 1.
    let number = Math.max(0, ...projectSpecs.map((spec) => spec.number));
    const at = now();
    for (const written of outcome.specs) {
      const target = written.specNumber === null ? undefined : named.get(written.specNumber);
      if (target !== undefined) {
        writeNextRevision(tx, run, target.latest, written.content, null, at);
        continue;
      }
      number += 1;
      const specificationId = uuidv7();
      tx.insert(specifications).values({ id: specificationId, projectId, number }).run();
      tx.insert(specRevisions)
        .values({
          id: uuidv7(),
          specificationId,
          revision: 1,
          mapId: run.mapId,
          writtenByRun: run.id,
          content: written.content,
          removed: null,
          createdAt: at,
          approvedAt: null,
          supersededAt: null,
          rejectionReason: null,
        })
        .run();
    }
    for (const wait of waits) {
      recordWait(tx, { mapId: run.mapId, hatchMessageId: null, ...wait }, at);
    }
    endRun(tx, run.id, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}

/**
 * The spec numbered `specNumber` when the run may write its next revision, else null: one of the
 * map's `open` specs, or a project spec whose latest revision is approved (on any map, this map's
 * included) and which nothing holds against this map.
 */
function writableSpec(
  tx: Tx,
  run: PlanningRun,
  projectSpecs: readonly StoredSpec[],
  open: readonly TargetSpec[],
  specNumber: number,
): TargetSpec | null {
  const draft = open.find((spec) => spec.number === specNumber);
  if (draft !== undefined) {
    return draft;
  }
  const spec = projectSpecs.find((candidate) => candidate.number === specNumber);
  if (spec === undefined) {
    return null;
  }
  const target = targetOf(tx, spec);
  return target.latest.approvedAt !== null && specHold(tx, spec.id, run.mapId) === null
    ? target
    : null;
}

/**
 * Records a spec-scoped `to_spec` run's revision: the spec's next revision from the run's map. A
 * repair's latest is the map's own unapproved revision, which it supersedes (a rejected or noted
 * latest is already superseded); the new revision is then reviewed. A release run (the wait its
 * `released_by_run` names) or a note run on an approved spec (it carries a message) writes after
 * the latest revision, approved on any map, superseding nothing; it re-reads `specHold` first, and
 * when the spec is held by then (a delivery started) it saves nothing, its wait is open (a release
 * run's reopened, a note run's recorded with the note and the hold seen now) and the run ends
 * completed. Ids are checked against every revision of the spec. Output breaking the schema or the
 * id rules, citing a note on a spec with no note-directed revision and no note on this run, or
 * whose `removed` is not exactly the ids it drops from the latest (`removalsProblem`), fails the
 * run `spec_content_invalid`; the revision is stored with its `removed`.
 * A run the re-clear or a reopen ended saves nothing.
 */
export function recordRevision(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: ReviseSpecOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      return ok(null);
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "to_spec" || run.specificationId === null) {
      throw new Error(`Planning run ${runId} is not a spec-scoped to_spec run`);
    }
    const { revisions } = runSpec(tx, run);
    const latest = latestOf(revisions);
    const release = releasedWaitOf(tx, run.id);
    const repair =
      release === undefined && latest.mapId === run.mapId && latest.approvedAt === null;
    if (!repair) {
      if (release === undefined && run.hatchMessageId === null) {
        throw new Error(
          `Run ${runId}'s spec has no unapproved revision of its map, and it is no release or note run`,
        );
      }
      const hold = specHold(tx, run.specificationId, run.mapId);
      if (hold !== null) {
        if (release !== undefined) {
          reopenWait(tx, release.id);
        } else {
          const messageId = present(run.hatchMessageId, `Note run ${run.id}'s message`);
          recordWait(
            tx,
            {
              mapId: run.mapId,
              specificationId: run.specificationId,
              note: readNoteText(tx, messageId),
              hatchMessageId: messageId,
              hold,
            },
            now(),
          );
        }
        endRun(tx, run.id, { state: "completed" });
        planAndRelease(actor, tx, run.mapId);
        return ok(null);
      }
      if (latest.approvedAt === null) {
        throw new Error(
          `Run ${runId}'s spec ${run.specificationId} is unheld with an unapproved latest revision of another map`,
        );
      }
    }
    const problem = revisionProblem(
      outcome.revision,
      resolvedNumbers(readWaypoints(tx, run.mapId)),
      revisions.map((revision) => revision.content),
      isNoted(tx, latest) || (!repair && run.hatchMessageId !== null),
    );
    // The id rules first, then the declared removals against the latest revision, then
    // what each clause relies on and adds.
    const failure =
      problem ??
      removalsProblem(outcome.removed, latest.content, outcome.revision) ??
      declarationsProblem(tx, run.mapId, outcome.revision);
    if (failure !== null) {
      return refuse(actor, tx, run, failure);
    }
    writeNextRevision(tx, run, latest, outcome.revision, outcome.removed, now());
    endRun(tx, run.id, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}

/** The folder of the map's project, as core reads its files. */
export function mapProjectFolder(db: Reader, mapId: string): string {
  const projectId = mapProjectId(db, mapId);
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (project === undefined) {
    throw new Error(`Map ${mapId} references missing project ${projectId}`);
  }
  return project.folderPath;
}

/**
 * The problem of a written revision's clause declarations against the map's survey and its
 * project's files (`referencesProblem`), refused as `spec_content_invalid`, or null.
 */
function declarationsProblem(
  db: Reader,
  mapId: string,
  content: SpecRevisionContent,
): RunFailure | null {
  const problem = referencesProblem(
    content,
    readCodeSurvey(db, mapId),
    mapProjectFolder(db, mapId),
  );
  return problem === null ? null : contentInvalid(problem);
}

function mapProjectId(db: Reader, mapId: string): string {
  const row = db.select({ projectId: maps.projectId }).from(maps).where(eq(maps.id, mapId)).get();
  if (row === undefined) {
    throw new Error(`No map with id ${mapId}`);
  }
  return row.projectId;
}

/** The map's closed waypoints as a review read them: resolved or out of scope, with when. */
function reviewSources(db: Reader, mapId: string): SpecReviewSource[] {
  const exclusions = readExclusions(db, mapId);
  return readWaypoints(db, mapId).flatMap((waypoint): SpecReviewSource[] => {
    if (waypoint.status === "resolved") {
      return [
        {
          waypointId: waypoint.id,
          outcome: "resolved",
          closedAt: present(waypoint.resolvedAt, `Waypoint ${waypoint.id}'s resolved_at`),
        },
      ];
    }
    if (waypoint.status === "out_of_scope") {
      const exclusion = exclusions.find((candidate) => candidate.waypointId === waypoint.id);
      if (exclusion === undefined) {
        throw new Error(`Out-of-scope waypoint ${waypoint.id} has no exclusion`);
      }
      const ruling = db
        .select({ endedAt: planningRuns.endedAt })
        .from(planningRuns)
        .where(eq(planningRuns.id, exclusion.createdByRun))
        .get();
      if (ruling?.endedAt == null) {
        throw new Error(`Ruling run ${exclusion.createdByRun} has not ended`);
      }
      return [{ waypointId: waypoint.id, outcome: "out_of_scope", closedAt: ruling.endedAt }];
    }
    return [];
  });
}

/**
 * Records a `spec_review` run's outcome pinned to the reviewed revision: `passed` exactly
 * when it has no finding. A finding naming a clause or criterion the revision lacks, or a waypoint
 * not resolved on the map, fails the run `review_reference_unknown` and writes nothing.
 * Its escalated findings each open (or link) a Grilling waypoint in the same transaction
 * (`escalatedPositions`, never a waypoint another finding of the same review went to); past
 * `SPEC_REVIEW_FAILED_CAP` every finding escalates at once, the `decision` ones to the person, and
 * past `SPEC_REVIEW_PERSON_CAP` all of them; a failed, unescalated, revise-only review makes a
 * repair due.
 */
export function recordSpecReview(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: SpecReviewOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      // A review a reopen cancelled saves nothing and is not retried.
      return ok(null);
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "spec_review") {
      throw new Error(`Planning run ${runId} is a ${run.purpose} run, not spec_review`);
    }
    const revision = reviewedRevision(tx, run);
    const ids = elementIds(revision.content);
    const resolved = resolvedNumbers(readWaypoints(tx, run.mapId));
    for (const [index, finding] of outcome.findings.entries()) {
      const unknownId = finding.elementIds.find((id) => !ids.has(id));
      const unknownWaypoint = finding.waypointNumbers.find((number) => !resolved.has(number));
      if (unknownId !== undefined || unknownWaypoint !== undefined) {
        return refuse(actor, tx, run, {
          code: "review_reference_unknown",
          message:
            unknownId === undefined
              ? `Finding ${String(index + 1)} names waypoint ${String(unknownWaypoint)}, which is not resolved on the map`
              : `Finding ${String(index + 1)} names ${unknownId}, which the revision does not have`,
        });
      }
    }
    const unverifiable = readCodeSurvey(tx, run.mapId)?.unverifiable;
    const folder = mapProjectFolder(tx, run.mapId);
    for (const [index, check] of outcome.verified.entries()) {
      const where = `Verified item ${String(index + 1)} (U${String(check.item)})`;
      if (unverifiable === undefined || check.item > unverifiable.length) {
        return refuse(actor, tx, run, {
          code: "review_reference_unknown",
          message: `${where} names an unverifiable item the map's survey does not have`,
        });
      }
      const problem = sourceLineProblem(folder, check.path, check.line);
      if (problem !== null) {
        return refuse(actor, tx, run, {
          code: "review_reference_unknown",
          message: `${where} ${problem}`,
        });
      }
    }
    if (readReview(tx, revision) !== null) {
      throw new Error(`Revision ${revision.id} already has a review`);
    }
    const sources = reviewSources(tx, run.mapId);
    const escalation = escalatedPositions(tx, revision, outcome.findings);
    const reviewId = uuidv7();
    tx.insert(specReviews)
      .values({
        id: reviewId,
        specRevisionId: revision.id,
        runId: run.id,
        passed: outcome.findings.length === 0,
        summary: outcome.summary,
        sources,
        verified: outcome.verified,
      })
      .run();
    const openedByReview = new Set<string>();
    for (const [index, finding] of outcome.findings.entries()) {
      // Inserted one by one; a finding links an earlier review's waypoint, never this review's.
      const waypointId = escalation.positions.has(index)
        ? escalationWaypoint(
            tx,
            run,
            revision,
            finding,
            escalation.personDecides.has(index),
            openedByReview,
          )
        : null;
      if (waypointId !== null) {
        openedByReview.add(waypointId);
      }
      tx.insert(specReviewFindings)
        .values({
          reviewId,
          position: index + 1,
          ...finding,
          escalated: waypointId !== null,
          waypointId,
        })
        .run();
    }
    endRun(tx, run.id, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}
