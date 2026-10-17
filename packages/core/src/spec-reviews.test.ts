import type { PlanningRun, Project, SpecReviewFinding, SpecRemovals } from "@zenorm/contracts";
import { codeSurveys, planningRuns, specReviews, specRevisions } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import { approveSpecRevision, rejectSpecRevision } from "./planning.ts";
import {
  failRun,
  isSupersededStop,
  readClearing,
  readMap,
  readMapRuns,
  readWaypoints,
  recordGrill,
  sweepInterruptedRuns,
  tryAgain,
} from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import { SPEC_REVIEW_FAILED_CAP, SPEC_REVIEW_PERSON_CAP, sameProblem } from "./spec-escalation.ts";
import {
  recordRevision,
  recordSpecReview,
  recordSpecs,
  removalsProblem,
  revisionProblem,
} from "./spec-runs.ts";
import { recordTicketSet } from "./ticket-set-runs.ts";
import {
  earlierReviews,
  readMapSpecs,
  readReview,
  readSpecRevisions,
  retiredIds,
} from "./specs.ts";
import type { StoredRevision } from "./specs.ts";
import {
  addProject,
  cleanPass,
  clearedMap,
  closeTestContext,
  draftedSpec,
  grillingRun,
  NO_MAP_CHANGES,
  openTestContext,
  PASSED_REVIEW,
  recordRunningTicketsReview,
  resolve,
  REVISE_FINDING,
  reviewedSpec,
  runningMapRun,
  runningSpecRun,
  runsOf,
  SPEC,
  SURVEY,
  TICKETS,
  waypointOf,
  writeTestData,
} from "./test-support.ts";
import type { TestContext, DraftContent } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-spec-reviews-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/** A decision finding (S7-9): the person must decide. */
const DECISION: SpecReviewFinding = {
  kind: "undefined_term",
  route: "decision",
  title: "Which records?",
  explanation: "C1 says 'every record', which no source defines.",
  question: "Which records does the export cover?",
  elementIds: ["C1"],
  waypointNumbers: [],
};

/** A second revise finding, of another kind, so it opens its own waypoint. */
const OTHER_REVISE: SpecReviewFinding = {
  ...REVISE_FINDING,
  kind: "unverifiable",
  title: "Unverifiable criterion",
};

/** SPEC with a new title: every id kept, so no clause needs a source (S7-5). */
function kept(title: string): DraftContent {
  return {
    ...SPEC,
    title,
    clauses: SPEC.clauses.map((clause) => ({ ...clause, sources: [] })),
  };
}

/** The list's item at `index`; a missing one fails the test. */
function at<T>(list: readonly T[], index: number): T {
  const item = list.at(index);
  if (item === undefined) throw new Error(`No item at ${String(index)}`);
  return item;
}

function specificationOf(run: PlanningRun): string {
  if (run.specificationId === null) throw new Error(`Run ${run.id} is not spec-scoped`);
  return run.specificationId;
}

function revisions(specificationId: string): StoredRevision[] {
  return readSpecRevisions(context.db, specificationId);
}

function latest(specificationId: string): StoredRevision {
  const found = revisions(specificationId).at(-1);
  if (found === undefined) throw new Error("no revision");
  return found;
}

function running(mapId: string): PlanningRun[] {
  return runsOf(context, mapId).filter((run) => run.state === "running");
}

/** The running run of `purpose` scoped to the spec; anything else throws. */
function specRun(mapId: string, specificationId: string, purpose: PlanningRun["purpose"]) {
  const runs = running(mapId).filter(
    (run) => run.specificationId === specificationId && run.purpose === purpose,
  );
  const [run] = runs;
  if (run === undefined || runs.length !== 1) {
    throw new Error(`${String(runs.length)} running ${purpose} runs on the spec`);
  }
  return run;
}

function review(mapId: string, specificationId: string, findings: SpecReviewFinding[]): void {
  const recorded = recordSpecReview(
    context.user,
    context.db,
    specRun(mapId, specificationId, "spec_review").id,
    {
      summary: PASSED_REVIEW.summary,
      findings,
      verified: [],
    },
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** Records the running repair's revision; it drops no id. */
function repair(mapId: string, specificationId: string, content: DraftContent): void {
  repairRemoving(mapId, specificationId, content, []);
}

/** Records the running repair's revision, declaring the ids it drops. */
function repairRemoving(
  mapId: string,
  specificationId: string,
  content: DraftContent,
  removed: SpecRemovals,
): void {
  const recorded = recordRevision(
    context.user,
    context.db,
    specRun(mapId, specificationId, "to_spec").id,
    {
      revision: content,
      removed,
    },
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

function findingsOf(revision: StoredRevision) {
  const stored = readReview(context.db, revision);
  if (stored === null) throw new Error(`Revision ${String(revision.revision)} has no review`);
  return stored.findings;
}

function clearedNow(mapId: string): boolean {
  const map = readMap(context.db, mapId);
  const clearing = readClearing(context.db, map, readMapRuns(context.db, mapId));
  return clearing.waypoints.every((w) => w.status === "resolved" || w.status === "out_of_scope");
}

/** A cleared map whose first To Spec wrote `count` specs; each review runs. Returns the spec ids. */
async function specsOnMap(count: number): Promise<{ mapId: string; specIds: string[] }> {
  const mapId = await clearedMap(context, project);
  const recorded = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
    specs: Array.from({ length: count }, (_, index) => ({
      specNumber: null,
      content: { ...SPEC, title: `Spec ${String(index + 1)}` },
    })),
    waits: [],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
  return { mapId, specIds: readMapSpecs(context.db, mapId).map((spec) => spec.id) };
}

/** Fails the running run twice (first attempt and retry) so its scope stops (S6a-12). */
function stop(run: PlanningRun): PlanningRun {
  failRun(context.user, context.db, run.id, { code: "agent_run_failed", message: "first" });
  const retry = runsOf(context, run.mapId).find((other) => other.retryOfRunId === run.id);
  if (retry === undefined) throw new Error("no retry");
  failRun(context.user, context.db, retry.id, { code: "agent_run_failed", message: "second" });
  const stopped = runsOf(context, run.mapId).find((other) => other.id === retry.id);
  if (stopped === undefined) throw new Error("no stopped run");
  return stopped;
}

/** Records the map's running re-clear To Spec with the given specs. */
function reclear(mapId: string, specs: { specNumber: number | null; content: DraftContent }[]) {
  return recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
    specs,
    waits: [],
  });
}

describe("ids across revisions (S7-5, B43)", () => {
  const r1 = SPEC;
  const r2: DraftContent = {
    ...kept("r2"),
    clauses: [{ ...at(kept("r2").clauses, 0), criteria: [{ id: "1.1", text: "A CSV file." }] }],
  };

  test("a retired id reused is refused", () => {
    const r3 = { ...kept("r3") };
    expect(revisionProblem(r3, new Set(), [r1, r2], false)).toMatchObject({
      code: "spec_content_invalid",
    });
  });

  test("the retired ids a run is told are the ids revisionProblem refuses (E-3)", () => {
    expect(retiredIds([r1, r2])).toEqual(["1.2"]);
    expect(retiredIds([r1])).toEqual([]);
    const wide: DraftContent = {
      ...r1,
      clauses: [
        { ...at(r1.clauses, 0), id: "C3", criteria: [{ id: "3.10", text: "Ten." }] },
        { ...at(r1.clauses, 0), id: "C2", criteria: [{ id: "2.2", text: "Two." }] },
      ],
    };
    // Ordered by clause, then criterion number, a clause before its criteria; none of r2's kept.
    expect(retiredIds([wide, r2])).toEqual(["C2", "2.2", "C3", "3.10"]);
    for (const id of retiredIds([wide, r2])) {
      const clause = id.startsWith("C") ? id : `C${String(id.split(".")[0])}`;
      const reuse: DraftContent = {
        ...r2,
        clauses: [
          ...r2.clauses,
          {
            ...at(r1.clauses, 0),
            id: clause,
            criteria: [{ id: id.startsWith("C") ? `${id.slice(1)}.9` : id, text: "Back." }],
          },
        ],
      };
      expect(revisionProblem(reuse, new Set(), [wide, r2], false)).toMatchObject({
        code: "spec_content_invalid",
      });
    }
  });

  test("was naming an id the revision before did not have, or one this revision keeps, is refused", () => {
    const missing: DraftContent = {
      ...r2,
      clauses: [
        { ...at(r2.clauses, 0), criteria: [{ id: "1.1", text: "A CSV file.", was: "1.9" }] },
      ],
    };
    const keptWas: DraftContent = {
      ...kept("r2"),
      clauses: [
        {
          ...at(kept("r2").clauses, 0),
          criteria: [
            { id: "1.1", text: "A CSV file." },
            { id: "1.2", text: "Every row.", was: "1.1" },
          ],
        },
      ],
    };
    expect(revisionProblem(missing, new Set(), [r1], false)).toMatchObject({
      code: "spec_content_invalid",
    });
    expect(revisionProblem(keptWas, new Set(), [r1], false)).toMatchObject({
      code: "spec_content_invalid",
    });
  });

  test("was naming a dropped id, and a kept id with new wording and no source, pass", () => {
    const moved: DraftContent = {
      ...r2,
      clauses: [
        {
          ...at(r2.clauses, 0),
          text: "Every record exports, reworded.",
          criteria: [
            { id: "1.1", text: "A CSV file, reworded." },
            { id: "1.3", text: "Every row.", was: "1.2" },
          ],
        },
      ],
    };
    expect(revisionProblem(moved, new Set(), [r1], false)).toBeNull();
  });

  test("a clause new in the revision needs a source", () => {
    const added: DraftContent = {
      ...kept("r2"),
      clauses: [
        ...kept("r2").clauses,
        {
          id: "C2",
          title: "New",
          text: "New clause.",
          criteria: [{ id: "2.1", text: "New." }],
          sources: [],
          reliesOn: [],
          adds: ["new behaviour"],
        },
      ],
    };
    expect(revisionProblem(added, new Set(), [r1], false)).toMatchObject({
      code: "spec_content_invalid",
    });
    const sourced = {
      ...added,
      clauses: added.clauses.map((clause) =>
        clause.id === "C2" ? { ...clause, sources: [{ kind: "destination" as const }] } : clause,
      ),
    };
    expect(revisionProblem(sourced, new Set(), [r1], false)).toBeNull();
  });

  test("a repair's clause citing a note fails spec_content_invalid only while no revision is note-directed (S7b-11)", () => {
    const noted: DraftContent = {
      ...kept("r2"),
      clauses: [
        ...kept("r2").clauses,
        {
          id: "C2",
          title: "New",
          text: "New clause.",
          criteria: [{ id: "2.1", text: "New." }],
          sources: [{ kind: "note" }],
          reliesOn: [],
          adds: ["new behaviour"],
        },
      ],
    };
    expect(revisionProblem(noted, new Set(), [r1], false)).toMatchObject({
      code: "spec_content_invalid",
    }); // Once a revision of the spec is note-directed, it and later ones may cite the note (L151).
    expect(revisionProblem(noted, new Set(), [r1], true)).toBeNull();
  });

  test("a repair rewrites the draft in place (L241): an id only a rewritten draft dropped is not retired", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    repairRemoving(mapId, specificationId, r2, [{ id: "1.2", reason: "Merged into 1.1." }]);
    review(mapId, specificationId, [REVISE_FINDING]);
    repair(mapId, specificationId, kept("r3"));
    expect(revisions(specificationId)).toMatchObject([
      { revision: 1, supersededAt: null, removed: null, content: kept("r3") },
    ]);
  });

  test("a repair reusing an id the revision before the draft retired fails spec_content_invalid and writes nothing", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project);
    const rejected = rejectSpecRevision(context.user, context.db, {
      specRevisionId: latest(specificationId).id,
      reason: "Drop 1.2.",
    });
    if (!rejected.ok) throw new Error(rejected.error.code);
    repairRemoving(mapId, specificationId, r2, [{ id: "1.2", reason: "Merged into 1.1." }]);
    review(mapId, specificationId, [REVISE_FINDING]);
    const run = specRun(mapId, specificationId, "to_spec");
    expect(
      recordRevision(context.user, context.db, run.id, { revision: kept("r3"), removed: [] }),
    ).toMatchObject({
      ok: false,
      error: { code: "spec_content_invalid" },
    });
    expect(revisions(specificationId).map((revision) => revision.revision)).toEqual([1, 2]);
    expect(latest(specificationId).content).toEqual(r2);
  });

  test("a rewrite in place keeps was and removed against the revision before the draft (L241)", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project);
    const rejected = rejectSpecRevision(context.user, context.db, {
      specRevisionId: latest(specificationId).id,
      reason: "Rework 1.2.",
    });
    if (!rejected.ok) throw new Error(rejected.error.code);
    // r2 moves 1.2 to 1.3 and adds 1.4 (from a waypoint-free kept clause, so no source needed).
    const moved: DraftContent = {
      ...kept("r2"),
      clauses: [
        {
          ...at(kept("r2").clauses, 0),
          criteria: [
            { id: "1.1", text: "A CSV file." },
            { id: "1.3", text: "Every row.", was: "1.2" },
            { id: "1.4", text: "A header row." },
          ],
        },
      ],
    };
    const movedAway = { id: "1.2", reason: "Moved to 1.3." };
    repairRemoving(mapId, specificationId, moved, [movedAway]);
    review(mapId, specificationId, [REVISE_FINDING]);
    // The repair, written against the draft, moves 1.3 to 1.5 and drops 1.4: as the revision
    // before it (r1) sees it, 1.5 was 1.2, and 1.2 is still the one id removed.
    const again: DraftContent = {
      ...moved,
      title: "r2 again",
      clauses: [
        {
          ...at(moved.clauses, 0),
          criteria: [
            { id: "1.1", text: "A CSV file." },
            { id: "1.5", text: "Every row, again.", was: "1.3" },
          ],
        },
      ],
    };
    repairRemoving(mapId, specificationId, again, [
      { id: "1.3", reason: "Moved to 1.5." },
      { id: "1.4", reason: "Not needed." },
    ]);
    expect(revisions(specificationId)).toHaveLength(2);
    const r2Stored = latest(specificationId);
    expect(r2Stored.removed).toEqual([movedAway]);
    expect(at(at(r2Stored.content.clauses, 0).criteria, 1)).toEqual({
      id: "1.5",
      text: "Every row, again.",
      was: "1.2",
    });
    // The rewrite left 1.2 out with no was of its own: it keeps the draft's.
    review(mapId, specificationId, [REVISE_FINDING]);
    const third: DraftContent = {
      ...again,
      title: "r2 third",
      clauses: [
        {
          ...at(again.clauses, 0),
          criteria: [
            { id: "1.1", text: "A CSV file." },
            { id: "1.5", text: "Every row, third." },
          ],
        },
      ],
    };
    repairRemoving(mapId, specificationId, third, []);
    expect(latest(specificationId)).toMatchObject({ revision: 2, removed: [movedAway] });
    expect(at(at(latest(specificationId).content.clauses, 0).criteria, 1)).toEqual({
      id: "1.5",
      text: "Every row, third.",
      was: "1.2",
    });
  });

  test("removed must be exactly the ids dropped from the revision before (RC4), either way", () => {
    const merged = { id: "1.2", reason: "Merged into 1.1." };
    expect(removalsProblem([merged], r1, r2)).toBeNull();
    expect(removalsProblem([], r1, r1)).toBeNull();
    // A dropped id left undeclared.
    expect(removalsProblem([], r1, r2)).toMatchObject({ code: "spec_content_invalid" });
    expect(removalsProblem([], r1, r2)?.message).toContain("1.2");
    // A declared id the revision still has, or the revision before never had.
    expect(removalsProblem([{ ...merged, id: "1.1" }, merged], r1, r2)?.message).toContain("1.1");
    expect(removalsProblem([merged], r1, r1)).toMatchObject({ code: "spec_content_invalid" });
    expect(removalsProblem([{ ...merged, id: "C9" }, merged], r1, r2)?.message).toContain("C9");
    // A dropped clause declares itself and each of its criteria.
    const two = {
      ...r1,
      clauses: [
        ...r1.clauses,
        { ...at(r1.clauses, 0), id: "C2", criteria: [{ id: "2.1", text: "X." }] },
      ],
    };
    expect(removalsProblem([{ ...merged, id: "C2" }], two, r1)?.message).toContain("2.1");
    expect(
      removalsProblem(
        [
          { ...merged, id: "C2" },
          { ...merged, id: "2.1" },
        ],
        two,
        r1,
      ),
    ).toBeNull();
  });

  test("a repair whose removed differs from its drops fails spec_content_invalid and writes nothing; a matching one is stored and shown to the review", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    const undeclared = recordRevision(
      context.user,
      context.db,
      specRun(mapId, specificationId, "to_spec").id,
      {
        revision: r2,
        removed: [],
      },
    );
    expect(undeclared.ok ? null : undeclared.error.code).toBe("spec_content_invalid");
    const retry = specRun(mapId, specificationId, "to_spec");
    const overDeclared = recordRevision(context.user, context.db, retry.id, {
      revision: kept("r2"),
      removed: [{ id: "1.2", reason: "Dropped." }],
    });
    expect(overDeclared.ok ? null : overDeclared.error.code).toBe("spec_content_invalid");
    expect(revisions(specificationId).map((revision) => revision.revision)).toEqual([1]);
    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    const removed = [{ id: "1.2", reason: "Merged into 1.1." }];
    repairRemoving(mapId, specificationId, r2, removed);
    // A repair of revision 1 rewrites it in place (L241): nothing comes before it to remove from.
    expect(latest(specificationId)).toMatchObject({ revision: 1, removed: null, content: r2 });
    const work = await prepareRun(context.db, specRun(mapId, specificationId, "spec_review").id);
    expect(work.ok && work.value.request).toMatchObject({ removed: null });
  });

  test("a repair's retry, and its Try again, carry the problem core refused it for (L141)", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    repairRemoving(mapId, specificationId, r2, [{ id: "1.2", reason: "Merged into 1.1." }]);
    review(mapId, specificationId, [REVISE_FINDING]);
    const refusedFor = async (runId: string) => {
      const work = await prepareRun(context.db, runId);
      if (!work.ok || work.value.purpose !== "to_spec" || work.value.scope !== "spec") {
        throw new Error("not a repair");
      }
      return work.value.request.refusedAttempt;
    };
    const stored = (runId: string) => {
      const found = runsOf(context, mapId).find((candidate) => candidate.id === runId);
      if (found?.errorMessage == null) throw new Error("no stored message");
      return found.errorMessage;
    };
    // A removal of an id the draft never had is refused (RC4).
    const BOGUS = { id: "C9", reason: "Never there." };
    const first = specRun(mapId, specificationId, "to_spec");
    expect(await refusedFor(first.id)).toBeNull();
    expect(
      recordRevision(context.user, context.db, first.id, { revision: kept("r3"), removed: [BOGUS] })
        .ok,
    ).toBe(false);
    const retry = specRun(mapId, specificationId, "to_spec");
    expect(retry.retryOfRunId).toBe(first.id);
    expect(await refusedFor(retry.id)).toEqual({ problem: stored(first.id) });
    expect(
      recordRevision(context.user, context.db, retry.id, { revision: kept("r3"), removed: [BOGUS] })
        .ok,
    ).toBe(false);
    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    const again = specRun(mapId, specificationId, "to_spec");
    expect(await refusedFor(again.id)).toEqual({ problem: stored(retry.id) });
  });
});

describe("repair (S7-7, B16)", () => {
  test("a revise-only failure starts a ReviseSpec repair; it rewrites r1 in place (L241), and the new content is reviewed", async () => {
    const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project, [
      REVISE_FINDING,
    ]);
    const work = await prepareRun(context.db, specRun(mapId, specificationId, "to_spec").id);
    expect(work.ok && work.value.purpose === "to_spec" && work.value.scope).toBe("spec");
    expect(work.ok && work.value.request).toMatchObject({
      latest: { specNumber: 1, revision: 1 },
      feedback: { kind: "review", findings: [{ title: REVISE_FINDING.title }] },
    });
    const before = latest(specificationId);
    const repairRun = specRun(mapId, specificationId, "to_spec");
    repair(mapId, specificationId, kept("r2"));
    expect(revisions(specificationId)).toEqual([
      {
        ...before,
        id: specRevisionId,
        content: kept("r2"),
        writtenByRun: repairRun.id,
        supersededAt: null,
        approvedAt: null,
      },
    ]);
    // The failed review stays, an earlier review; the rewritten content has none yet.
    expect(readReview(context.db, latest(specificationId))).toBeNull();
    expect(earlierReviews(context.db, latest(specificationId))).toHaveLength(1);
    review(mapId, specificationId, []);
    expect(readReview(context.db, latest(specificationId))?.review.passed).toBe(true);
    expect(earlierReviews(context.db, latest(specificationId))).toHaveLength(1);
  });

  test("the repair and the review carry each earlier failed review's findings, by revision", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    const request = async (purpose: "to_spec" | "spec_review") => {
      const work = await prepareRun(context.db, specRun(mapId, specificationId, purpose).id);
      if (
        !work.ok ||
        work.value.purpose !== purpose ||
        !("earlierFindings" in work.value.request)
      ) {
        throw new Error(`not a spec-scoped ${purpose}`);
      }
      return work.value.request.earlierFindings;
    };
    const brief = (finding: SpecReviewFinding) => ({
      kind: finding.kind,
      elementIds: finding.elementIds,
      explanation: finding.explanation,
    });
    // r1's own review is the first repair's feedback, not an earlier finding.
    expect(await request("to_spec")).toEqual([]);
    repair(mapId, specificationId, kept("r2"));
    const first = { revision: 1, findings: [brief(REVISE_FINDING)] };
    expect(await request("spec_review")).toEqual([first]);
    review(mapId, specificationId, [OTHER_REVISE]);
    expect(await request("to_spec")).toEqual([first]);
    repair(mapId, specificationId, kept("r3"));
    // Each review of the draft's earlier content, oldest first, under the one revision (L241).
    expect(await request("spec_review")).toEqual([
      first,
      { revision: 1, findings: [brief(OTHER_REVISE)] },
    ]);
  });
  test("an approval closes the findings before it: a later revision's review carries only those after it (slice 8b)", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    repair(mapId, specificationId, kept("r2"));
    review(mapId, specificationId, []);
    const approved = approveSpecRevision(context.user, context.db, {
      specRevisionId: latest(specificationId).id,
    });
    if (!approved.ok) throw new Error(approved.error.code);
    const tickets = recordTicketSet(
      context.user,
      context.db,
      runningSpecRun(context, mapId, "to_tickets").id,
      TICKETS,
    );
    if (!tickets.ok) throw new Error(tickets.error.code);
    recordRunningTicketsReview(context, mapId);
    const later = await clearedMap(context, project);
    expect(reclear(later, [{ specNumber: 1, content: kept("r3") }])).toMatchObject({ ok: true });
    const request = async (purpose: "to_spec" | "spec_review") => {
      const work = await prepareRun(context.db, specRun(later, specificationId, purpose).id);
      if (
        !work.ok ||
        work.value.purpose !== purpose ||
        !("earlierFindings" in work.value.request)
      ) {
        throw new Error(`not a spec-scoped ${purpose}`);
      }
      return work.value.request.earlierFindings;
    };
    // r1's failed review came before r1's approval: it is closed.
    expect(await request("spec_review")).toEqual([]);
    review(later, specificationId, [OTHER_REVISE]);
    repair(later, specificationId, kept("r4"));
    expect(revisions(specificationId).map((revision) => revision.revision)).toEqual([1, 2]);
    expect(await request("spec_review")).toEqual([
      {
        revision: 2,
        findings: [
          {
            kind: OTHER_REVISE.kind,
            elementIds: OTHER_REVISE.elementIds,
            explanation: OTHER_REVISE.explanation,
          },
        ],
      },
    ]);
  });
});

describe("the survey items a review settled (RC2)", () => {
  test("are stored; an item the survey lacks or a line its file lacks fails review_reference_unknown", async () => {
    const { mapId, specificationId } = await draftedSpec(context, project);
    const run = specRun(mapId, specificationId, "spec_review");
    const settle = (item: number, line: number) =>
      recordSpecReview(context.user, context.db, run.id, {
        ...PASSED_REVIEW,
        verified: [{ item, answer: "It does.", path: "README.md", line }],
      });
    // The test survey lists no unverifiable item.
    const refused = settle(1, 1);
    expect(refused.ok ? null : refused.error.code).toBe("review_reference_unknown");
    expect(readReview(context.db, latest(specificationId))).toBeNull();

    const { mapId: other, specificationId: otherSpec } = await draftedSpec(context, project);
    writeTestData(context, (tx) =>
      tx
        .update(codeSurveys)
        .set({ content: { ...SURVEY, unverifiable: ["Whether the readme has a heading."] } })
        .where(eq(codeSurveys.mapId, other))
        .run(),
    );
    const review = specRun(other, otherSpec, "spec_review");
    const at = (line: number) =>
      recordSpecReview(context.user, context.db, review.id, {
        ...PASSED_REVIEW,
        verified: [{ item: 1, answer: "It has one.", path: "README.md", line }],
      });
    const pastTheFile = at(2);
    expect(pastTheFile.ok ? null : pastTheFile.error.code).toBe("review_reference_unknown");
    const retry = specRun(other, otherSpec, "spec_review");
    const stored = recordSpecReview(context.user, context.db, retry.id, {
      ...PASSED_REVIEW,
      verified: [{ item: 1, answer: "It has one.", path: "README.md", line: 1 }],
    });
    expect(stored.ok).toBe(true);
    const row = context.db.select().from(specReviews).where(eq(specReviews.runId, retry.id)).get();
    expect(row?.verified).toEqual([{ item: 1, answer: "It has one.", path: "README.md", line: 1 }]);
  });
});

describe("escalation (S7-8, RC4)", () => {
  test(`r1 and r2 failing repair; r3 failing past SPEC_REVIEW_FAILED_CAP (${String(SPEC_REVIEW_FAILED_CAP)}) escalates every finding at once, no repair; only decisions go to the person`, async () => {
    expect(SPEC_REVIEW_FAILED_CAP).toBe(2);
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    repair(mapId, specificationId, kept("r2"));
    review(mapId, specificationId, [REVISE_FINDING]);
    expect(findingsOf(latest(specificationId)).map((f) => f.escalated)).toEqual([false]);
    repair(mapId, specificationId, kept("r3"));
    review(mapId, specificationId, [REVISE_FINDING, OTHER_REVISE, DECISION]);
    const findings = findingsOf(latest(specificationId));
    expect(findings.map((f) => f.escalated)).toEqual([true, true, true]);
    const opened = readWaypoints(context.db, mapId);
    expect(opened.map((w) => [w.number, w.kind, w.title])).toEqual([
      [1, "grilling", REVISE_FINDING.title],
      [2, "grilling", OTHER_REVISE.title],
      [3, "grilling", DECISION.title],
    ]);
    expect(findings.map((f) => f.waypointId)).toEqual(opened.map((w) => w.id));
    // The revise findings' grillings may settle them from the sources; the decision is the person's.
    expect(opened.map((w) => w.personDecides)).toEqual([false, false, true]);
    // All are grilled at once; no repair runs.
    expect(running(mapId).map((run) => run.purpose)).toEqual(["grilling", "grilling", "grilling"]);
    // Both repairs rewrote the draft in place (L241): still revision 1, its three reviews counted.
    expect(revisions(specificationId)).toMatchObject([{ revision: 1, supersededAt: null }]);
    const overview = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    expect(overview.ok).toBe(true);
  });

  test(`a failed review past SPEC_REVIEW_PERSON_CAP (${String(SPEC_REVIEW_PERSON_CAP)}) sends every finding to the person`, async () => {
    expect(SPEC_REVIEW_PERSON_CAP).toBe(3);
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    repair(mapId, specificationId, kept("r2"));
    review(mapId, specificationId, [REVISE_FINDING]);
    repair(mapId, specificationId, kept("r3"));
    review(mapId, specificationId, [REVISE_FINDING]);
    expect(waypointOf(context, mapId, 1).personDecides).toBe(false);
    // The agent settles it; the re-clear's revision fails its review again.
    resolve(context, mapId, 1);
    expect(reclear(mapId, [{ specNumber: 1, content: kept("r4") }]).ok).toBe(true);
    review(mapId, specificationId, [REVISE_FINDING]);
    expect(findingsOf(latest(specificationId)).map((f) => f.escalated)).toEqual([true]);
    expect(waypointOf(context, mapId, 2).personDecides).toBe(true);
  });

  test("a rejection between does not restart the count", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    repair(mapId, specificationId, kept("r2"));
    review(mapId, specificationId, []);
    const specRevisionId = latest(specificationId).id;
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId, reason: "Split it" }).ok,
    ).toBe(true);
    repair(mapId, specificationId, kept("r3"));
    review(mapId, specificationId, [REVISE_FINDING]);
    expect(findingsOf(latest(specificationId)).map((f) => f.escalated)).toEqual([false]);
    repair(mapId, specificationId, kept("r4"));
    review(mapId, specificationId, [REVISE_FINDING]);
    // r1's first review and r2's first failed before r2's second, the rejection of r1 between them
    // notwithstanding (the first repair rewrote r1 in place; the rejection's repair wrote r2).
    expect(findingsOf(latest(specificationId)).map((f) => f.escalated)).toEqual([true]);
  });

  test("a decision-escalated review counts, and a re-clear does not restart the count", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [DECISION]);
    expect(findingsOf(latest(specificationId)).map((f) => f.escalated)).toEqual([true]);
    resolve(context, mapId, 1);
    expect(reclear(mapId, [{ specNumber: 1, content: kept("r2") }]).ok).toBe(true);
    review(mapId, specificationId, [REVISE_FINDING]);
    expect(findingsOf(latest(specificationId)).map((f) => f.escalated)).toEqual([false]);
    repair(mapId, specificationId, kept("r3"));
    review(mapId, specificationId, [REVISE_FINDING]);
    expect(findingsOf(latest(specificationId)).map((f) => f.escalated)).toEqual([true]);
    // The person settles it; the re-clear's revision failing again goes straight to them.
    resolve(context, mapId, 2);
    cleanPass(context, mapId);
    expect(reclear(mapId, [{ specNumber: 1, content: kept("r4") }]).ok).toBe(true);
    review(mapId, specificationId, [OTHER_REVISE]);
    const findings = findingsOf(latest(specificationId));
    expect(findings.map((f) => f.escalated)).toEqual([true]);
    // r1, r2 and r3 failed: past SPEC_REVIEW_PERSON_CAP, a revise finding is the person's too.
    expect(waypointOf(context, mapId, 3).personDecides).toBe(true);
    expect(running(mapId).map((run) => run.purpose)).toEqual(["grilling"]);
    // The re-clears and the repair rewrote the draft in place (L241).
    expect(latest(specificationId).revision).toBe(1);
  });

  test("an approval restarts the count: a later map's first failed review repairs", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    repair(mapId, specificationId, kept("r2"));
    review(mapId, specificationId, [REVISE_FINDING]);
    repair(mapId, specificationId, kept("r3"));
    review(mapId, specificationId, []);
    const approved = approveSpecRevision(context.user, context.db, {
      specRevisionId: latest(specificationId).id,
    });
    if (!approved.ok) throw new Error(approved.error.code);
    const tickets = recordTicketSet(
      context.user,
      context.db,
      runningSpecRun(context, mapId, "to_tickets").id,
      TICKETS,
    );
    if (!tickets.ok) throw new Error(tickets.error.code);
    recordRunningTicketsReview(context, mapId);
    const later = await clearedMap(context, project);
    expect(reclear(later, [{ specNumber: 1, content: kept("r4") }]).ok).toBe(true);
    review(later, specificationId, [REVISE_FINDING]);
    expect(findingsOf(latest(specificationId)).map((f) => f.escalated)).toEqual([false]);
    expect(specRun(later, specificationId, "to_spec")).toBeDefined();
  });
});

describe("decision findings (S7-9)", () => {
  test("a decision on a first review opens a waypoint, starts no repair; its revise finding reaches the re-clear", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [
      DECISION,
      REVISE_FINDING,
    ]);
    const findings = findingsOf(latest(specificationId));
    expect(findings.map((f) => [f.route, f.escalated])).toEqual([
      ["decision", true],
      ["revise", false],
    ]);
    expect(running(mapId).map((run) => run.purpose)).toEqual(["grilling"]);
    resolve(context, mapId, 1);
    const reclearRun = runningMapRun(context, mapId);
    expect(reclearRun.purpose).toBe("to_spec");
    const work = await prepareRun(context.db, reclearRun.id);
    expect(work.ok && work.value.request).toMatchObject({
      specs: [
        {
          latest: { specNumber: 1, revision: 1 },
          approved: false,
          feedback: {
            kind: "review",
            findings: [{ route: "decision" }, { route: "revise", title: REVISE_FINDING.title }],
          },
        },
      ],
    });
  });

  test("findings of one review never share a waypoint; a later review's finding raising the same problem links it (RC3)", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    review(mapId, one, [DECISION, { ...DECISION, title: "Same decision, again" }]);
    const opened = readWaypoints(context.db, mapId);
    expect(opened).toHaveLength(2);
    expect(findingsOf(latest(one)).map((f) => f.waypointId)).toEqual(opened.map((w) => w.id));
    // Spec 2's C1 is another clause than spec 1's: no link, a waypoint of its own.
    review(mapId, two, [DECISION]);
    expect(readWaypoints(context.db, mapId)).toHaveLength(3);
  });

  test("the same problem (of one kind): the same resolved waypoints, or a shared id of the same spec", () => {
    const earlier = { waypointNumbers: [], elementIds: ["C1", "1.2"], specificationId: "s1" };
    expect(sameProblem(earlier, { ...DECISION, elementIds: ["1.2"] }, "s1")).toBe(true);
    expect(sameProblem(earlier, { ...DECISION, elementIds: ["1.2"] }, "s2")).toBe(false);
    expect(sameProblem(earlier, { ...DECISION, elementIds: ["C2"] }, "s1")).toBe(false);
    expect(sameProblem({ ...earlier, elementIds: [] }, { ...DECISION, elementIds: [] }, "s1")).toBe(
      false,
    );
    const numbered = { ...earlier, waypointNumbers: [2, 1] };
    expect(sameProblem(numbered, { ...DECISION, waypointNumbers: [1, 2] }, "s2")).toBe(true);
    expect(sameProblem(numbered, { ...DECISION, waypointNumbers: [1] }, "s1")).toBe(false);
  });

  test("both findings of one review reach their grillings (RC3)", async () => {
    const { mapId } = await reviewedSpec(context, project, [
      DECISION,
      {
        ...DECISION,
        title: "Which fields?",
        explanation: "C1 names no fields.",
        elementIds: ["C1", "1.1"],
      },
    ]);
    const explanations = await Promise.all(
      [1, 2].map(async (number) => {
        const work = await prepareRun(context.db, grillingRun(context, mapId, number).id);
        if (!work.ok || work.value.purpose !== "grilling") throw new Error("not a grilling");
        return work.value.request.reviewFindings.map((finding) => finding.explanation);
      }),
    );
    expect(explanations).toEqual([[DECISION.explanation], ["C1 names no fields."]]);
  });
});

describe("a decision finding's waypoint is the person's to decide", () => {
  test("it is personDecides; a capped revise finding's waypoint is not", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    review(mapId, one, [REVISE_FINDING]);
    repair(mapId, one, { ...kept("r2"), title: "Spec 1 r2" });
    review(mapId, one, [REVISE_FINDING]);
    repair(mapId, one, { ...kept("r3"), title: "Spec 1 r3" });
    review(mapId, one, [REVISE_FINDING]);
    expect(readWaypoints(context.db, mapId).map((w) => w.personDecides)).toEqual([false]);
    review(mapId, two, [{ ...REVISE_FINDING, route: "decision" }]);
    expect(readWaypoints(context.db, mapId).map((w) => w.personDecides)).toEqual([false, true]);
  });

  test("its grilling may not resolve or rule it out before an answered round: agent_output_invalid", async () => {
    const { mapId } = await reviewedSpec(context, project, [DECISION]);
    expect(waypointOf(context, mapId, 1).personDecides).toBe(true);
    const first = grillingRun(context, mapId, 1);
    const work = await prepareRun(context.db, first.id);
    expect(work.ok && work.value.request).toMatchObject({ waypoint: { personDecides: true } });

    const resolved = recordGrill(context.user, context.db, first.id, {
      round: null,
      resolution: { resolution: "Decided alone.", gist: "Decided alone", agentDecided: [] },
      outOfScope: null,
      mapChanges: NO_MAP_CHANGES,
    });
    expect(resolved.ok ? null : resolved.error.code).toBe("agent_output_invalid");
    expect(waypointOf(context, mapId, 1).status).toBe("claimed");

    const retry = grillingRun(context, mapId, 1);
    expect(retry.retryOfRunId).toBe(first.id);
    const ruled = recordGrill(context.user, context.db, retry.id, {
      round: null,
      resolution: null,
      outOfScope: { reason: "Not needed." },
      mapChanges: NO_MAP_CHANGES,
    });
    expect(ruled.ok ? null : ruled.error.code).toBe("agent_output_invalid");
    // The retry failed too, so the scope stopped and the waypoint went back to open.
    expect(waypointOf(context, mapId, 1).status).toBe("open");

    const tried = tryAgain(context.user, context.db, retry.id);
    if (!tried.ok) throw new Error(tried.error.code);
    // `resolve` asks a round and answers it first; the resolution is then accepted.
    resolve(context, mapId, 1);
    expect(waypointOf(context, mapId, 1).status).toBe("resolved");
  });
});

describe("un-cleared map and re-clear (S7-10, D6, L125 (3))", () => {
  test("on an un-cleared map approve and reject refuse map_uncleared and no review or repair starts", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    review(mapId, one, [DECISION]);
    expect(clearedNow(mapId)).toBe(false);
    const specRevisionId = latest(one).id;
    expect(approveSpecRevision(context.user, context.db, { specRevisionId })).toMatchObject({
      ok: false,
      error: { code: "map_uncleared" },
    });
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId, reason: "No" }),
    ).toMatchObject({
      ok: false,
      error: { code: "map_uncleared" },
    });
    // Spec 2's running review finishes; failing revise-only on the un-cleared map, it repairs nothing.
    review(mapId, two, [REVISE_FINDING]);
    expect(findingsOf(latest(two)).map((f) => f.escalated)).toEqual([false]);
    expect(running(mapId).map((run) => run.purpose)).toEqual(["grilling"]);
  });

  test("re-clear rewrites every unapproved draft in place (L241), may add a spec, leaves an approved one", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    review(mapId, one, []);
    expect(
      approveSpecRevision(context.user, context.db, { specRevisionId: latest(one).id }).ok,
    ).toBe(true);
    review(mapId, two, [DECISION]);
    resolve(context, mapId, 1);
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    expect(
      work.ok &&
        work.value.purpose === "to_spec" &&
        work.value.scope === "map" &&
        work.value.request.specs.map((spec) => [spec.latest.specNumber, spec.approved]),
    ).toEqual([
      [1, true],
      [2, false],
    ]);
    // Naming a spec twice, or leaving out an unapproved one, is refused: the run's first attempt
    // and its retry fail, and Try again starts it afresh. (Naming the approved spec revises it,
    // slice 8b S8b-3, L125 (3): `revising.test.ts`.)
    expect(
      reclear(mapId, [
        { specNumber: 2, content: kept("two") },
        { specNumber: 2, content: kept("two") },
      ]),
    ).toMatchObject({ ok: false, error: { code: "spec_content_invalid" } });
    expect(reclear(mapId, [{ specNumber: null, content: SPEC }])).toMatchObject({
      ok: false,
      error: { code: "spec_content_invalid" },
    });
    const stopped = runsOf(context, mapId).at(-1);
    expect(stopped).toMatchObject({ purpose: "to_spec", state: "failed" });
    expect(tryAgain(context.user, context.db, at(runsOf(context, mapId), -1).id).ok).toBe(true);
    expect(
      reclear(mapId, [
        { specNumber: 2, content: kept("two, r2") },
        { specNumber: null, content: { ...SPEC, title: "Spec 3" } },
      ]).ok,
    ).toBe(true);
    expect(revisions(one).map((r) => [r.revision, r.approvedAt !== null])).toEqual([[1, true]]);
    // The unapproved draft is rewritten in place (L241).
    expect(revisions(two)).toMatchObject([
      { revision: 1, supersededAt: null, content: kept("two, r2") },
    ]);
    expect(readMapSpecs(context.db, mapId).map((spec) => spec.number)).toEqual([1, 2, 3]);
  });

  test("while the map's re-clear is stopped, a passed draft is not approvable or rejectable: map_uncleared", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    review(mapId, one, []);
    review(mapId, two, [DECISION]);
    resolve(context, mapId, 1);
    stop(runningMapRun(context, mapId));
    expect(clearedNow(mapId)).toBe(true);
    const specRevisionId = latest(one).id;
    expect(approveSpecRevision(context.user, context.db, { specRevisionId })).toMatchObject({
      ok: false,
      error: { code: "map_uncleared" },
    });
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId, reason: "No" }),
    ).toMatchObject({
      ok: false,
      error: { code: "map_uncleared" },
    });
    expect(latest(one)).toMatchObject({ approvedAt: null, supersededAt: null });
  });

  test("a review running when the re-clear rewrites its draft in place saves nothing (L241); one failing during a re-clear starts no repair", async () => {
    const { mapId, specIds } = await specsOnMap(3);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    const three = at(specIds, 2);
    review(mapId, one, [DECISION]);
    resolve(context, mapId, 1);
    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
    // Spec 3's review fails during the re-clear: saved, no repair, no escalation.
    review(mapId, three, [REVISE_FINDING]);
    expect(findingsOf(latest(three)).map((f) => f.escalated)).toEqual([false]);
    expect(running(mapId).filter((run) => run.specificationId === three)).toEqual([]);
    const staleReview = specRun(mapId, two, "spec_review");
    expect(
      reclear(mapId, [
        { specNumber: 1, content: kept("one, r2") },
        { specNumber: 2, content: kept("two, r2") },
        { specNumber: 3, content: kept("three, r2") },
      ]).ok,
    ).toBe(true);
    // Every draft is rewritten in place: no spec gains a revision.
    for (const id of specIds) {
      expect(revisions(id).map((r) => [r.revision, r.supersededAt])).toEqual([[1, null]]);
    }
    expect(runsOf(context, mapId).find((run) => run.id === staleReview.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "replaced",
    });
    // Its late result saves nothing; spec 3's review of the content the re-clear replaced stays.
    expect(
      recordSpecReview(context.user, context.db, staleReview.id, {
        summary: PASSED_REVIEW.summary,
        findings: [DECISION],
        verified: [],
      }),
    ).toEqual({ ok: true, value: null });
    expect(earlierReviews(context.db, latest(two))).toEqual([]);
    expect(earlierReviews(context.db, latest(three))).toHaveLength(1);
    expect(readReview(context.db, latest(three))).toBeNull();
    expect(readWaypoints(context.db, mapId)).toHaveLength(1);
    // Every spec's rewritten draft is now reviewed in turn.
    expect(
      running(mapId)
        .map((run) => {
          if (run.specificationId === null) throw new Error("a spec review run names its spec");
          return [run.purpose, specIds.indexOf(run.specificationId)];
        })
        .sort(),
    ).toEqual([
      ["spec_review", 0],
      ["spec_review", 1],
      ["spec_review", 2],
    ]);
    const overview = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    expect(overview.ok).toBe(true);
  });
});

describe("spec.reject (S7-11 as extended by L127 (3), S7-12, B14)", () => {
  test("applies the first three refusals in order", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    const first = latest(one).id;
    // Review running: review_in_flight.
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId: first, reason: "x" }),
    ).toMatchObject({
      ok: false,
      error: { code: "review_in_flight" },
    });
    review(mapId, one, []);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId: first }).ok).toBe(true);
    // Approved: spec_revision_decided, before any other refusal.
    review(mapId, two, [DECISION]);
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId: first, reason: "x" }),
    ).toMatchObject({
      ok: false,
      error: { code: "spec_revision_decided" },
    });
    // Map un-cleared by the escalation: map_uncleared.
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId: latest(two).id, reason: "x" }),
    ).toMatchObject({ ok: false, error: { code: "map_uncleared" } });
  });

  test("stores the reason, supersedes the draft and starts a repair addressing it", async () => {
    const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project);
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId, reason: "Split it" }),
    ).toEqual({
      ok: true,
      value: mapId,
    });
    expect(latest(specificationId)).toMatchObject({ rejectionReason: "Split it" });
    const work = await prepareRun(context.db, specRun(mapId, specificationId, "to_spec").id);
    expect(work.ok && work.value.request).toMatchObject({
      feedback: { kind: "rejection", reason: "Split it" },
    });
    repair(mapId, specificationId, kept("r2"));
    expect(revisions(specificationId).map((r) => r.revision)).toEqual([1, 2]);
    // The review of r2 reads the reason, which outranks earlier resolutions (L141).
    const reviewed = await prepareRun(
      context.db,
      specRun(mapId, specificationId, "spec_review").id,
    );
    expect(reviewed.ok && reviewed.value.request).toMatchObject({
      rejection: { revision: 1, reason: "Split it" },
    });
  });

  test("review_in_flight while the draft's review is stopped; after Try again passes, the rejection repairs", async () => {
    const { mapId, specificationId, specRevisionId } = await draftedSpec(context, project);
    const stopped = stop(specRun(mapId, specificationId, "spec_review"));
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId, reason: "x" }),
    ).toMatchObject({
      ok: false,
      error: { code: "review_in_flight" },
    });
    expect(latest(specificationId)).toMatchObject({ supersededAt: null, rejectionReason: null });
    expect(tryAgain(context.user, context.db, stopped.id).ok).toBe(true);
    review(mapId, specificationId, []);
    expect(rejectSpecRevision(context.user, context.db, { specRevisionId, reason: "x" }).ok).toBe(
      true,
    );
    expect(specRun(mapId, specificationId, "to_spec")).toBeDefined();
  });

  test("review_in_flight while the draft's repair runs", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    expect(specRun(mapId, specificationId, "to_spec")).toBeDefined();
    expect(
      rejectSpecRevision(context.user, context.db, {
        specRevisionId: latest(specificationId).id,
        reason: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "review_in_flight" } });
  });
});

describe("concurrency and retries (S7-19)", () => {
  test("two specs' runs run at once; a second running run for one spec is never inserted", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    expect(running(mapId).map((run) => [run.purpose, run.specificationId])).toEqual(
      specIds.map((id) => ["spec_review", id]),
    );
    const one = at(specIds, 0);
    const insertSecond = () =>
      writeTestData(context, (tx) =>
        tx
          .insert(planningRuns)
          .values({
            userId: context.user.userId,
            ...specRun(mapId, one, "spec_review"),
            id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
          })
          .run(),
      );
    expect(insertSecond).toThrow();
    // Another write's planNext inserts no second run either.
    review(mapId, at(specIds, 1), []);
    expect(running(mapId).filter((run) => run.specificationId === one)).toHaveLength(1);
  });

  async function runOf(purpose: "to_spec" | "spec_review" | "to_tickets") {
    if (purpose === "spec_review") {
      const { mapId, specificationId } = await draftedSpec(context, project);
      return { mapId, run: specRun(mapId, specificationId, "spec_review") };
    }
    if (purpose === "to_spec") {
      const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
      return { mapId, run: specRun(mapId, specificationId, "to_spec") };
    }
    const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId }).ok).toBe(true);
    return { mapId, run: specRun(mapId, specificationId, "to_tickets") };
  }

  test.each(["to_spec", "spec_review", "to_tickets"] as const)(
    "%s scoped to a spec: retried once, stopped for Try again, swept at startup",
    async (purpose) => {
      const { mapId, run } = await runOf(purpose);
      sweepInterruptedRuns(context.db);
      const swept = runsOf(context, mapId).find((other) => other.id === run.id);
      expect(swept).toMatchObject({ state: "failed", errorCode: "planning_run_interrupted" });
      const retry = specRun(mapId, specificationOf(run), purpose);
      expect(retry.retryOfRunId).toBe(run.id);
      failRun(context.user, context.db, retry.id, { code: "agent_run_failed", message: "again" });
      expect(running(mapId).filter((r) => r.specificationId === run.specificationId)).toEqual([]);
      expect(tryAgain(context.user, context.db, retry.id)).toEqual({ ok: true, value: mapId });
      const fresh = specRun(mapId, specificationOf(run), purpose);
      expect(fresh.retryOfRunId).toBeNull();
      if (purpose === "to_tickets") {
        expect(recordTicketSet(context.user, context.db, fresh.id, TICKETS).ok).toBe(true);
      }
    },
  );
});

describe("re-clear replaces a repair (S7-25, L125 (1))", () => {
  test("re-clear during a running repair ends it cancelled, replaced; its later result writes nothing and is not retried", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    review(mapId, one, [REVISE_FINDING]);
    const repairRun = specRun(mapId, one, "to_spec");
    review(mapId, two, [DECISION]);
    resolve(context, mapId, 1);
    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
    const cancelled = runsOf(context, mapId).find((run) => run.id === repairRun.id);
    expect(cancelled).toMatchObject({ state: "cancelled", cancelReason: "replaced" });
    expect(cancelled?.endedAt).not.toBeNull();
    expect(
      recordRevision(context.user, context.db, repairRun.id, {
        revision: kept("late"),
        removed: [],
      }),
    ).toEqual({
      ok: true,
      value: null,
    });
    failRun(context.user, context.db, repairRun.id, { code: "agent_run_failed", message: "late" });
    expect(revisions(one).map((r) => r.revision)).toEqual([1]);
    expect(running(mapId).map((run) => run.purpose)).toEqual(["to_spec"]);
    expect(tryAgain(context.user, context.db, repairRun.id)).toMatchObject({
      ok: false,
      error: { code: "planning_run_not_stopped" },
    });
    const overview = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    expect(overview.ok).toBe(true);
  });

  test("a repair saved just before the re-clear is a draft the re-clear rewrites in place (L241)", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    review(mapId, one, [REVISE_FINDING]);
    review(mapId, two, [DECISION]);
    repair(mapId, one, kept("r2"));
    // Saved on the un-cleared map: a draft, not reviewed.
    expect(running(mapId).filter((run) => run.specificationId === one)).toEqual([]);
    resolve(context, mapId, 1);
    const reclearRun = runningMapRun(context, mapId);
    expect(
      reclear(mapId, [
        { specNumber: 1, content: kept("r3") },
        { specNumber: 2, content: kept("two, r2") },
      ]).ok,
    ).toBe(true);
    expect(revisions(one)).toMatchObject([
      { revision: 1, supersededAt: null, content: kept("r3"), writtenByRun: reclearRun.id },
    ]);
    expect(readReview(context.db, latest(one))).toBeNull();
    expect(specRun(mapId, one, "spec_review")).toBeDefined();
  });
});

describe("L121 for spec runs (S7-26, L127 (1))", () => {
  test("a stopped spec_review or to_spec on a map un-cleared by its pass does not block it; Try again refuses it", async () => {
    const { mapId, specIds } = await specsOnMap(3);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    const three = at(specIds, 2);
    const stoppedReview = stop(specRun(mapId, one, "spec_review"));
    review(mapId, two, [REVISE_FINDING]);
    const stoppedRepair = stop(specRun(mapId, two, "to_spec"));
    review(mapId, three, [DECISION, { ...OTHER_REVISE, route: "decision" }]);
    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    // Two resolved waypoints: the pass is due and runs, the stopped spec runs notwithstanding.
    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
    const clearing = readClearing(
      context.db,
      readMap(context.db, mapId),
      readMapRuns(context.db, mapId),
    );
    for (const stopped of [stoppedReview, stoppedRepair]) {
      expect(isSupersededStop(stopped, clearing)).toBe(true);
      expect(tryAgain(context.user, context.db, stopped.id)).toMatchObject({
        ok: false,
        error: { code: "planning_run_not_stopped" },
      });
    }
    cleanPass(context, mapId);
    expect(
      reclear(mapId, [
        { specNumber: 1, content: kept("one, r2") },
        { specNumber: 2, content: kept("two, r2") },
        { specNumber: 3, content: kept("three, r2") },
      ]).ok,
    ).toBe(true);
    // Each spec's new revision is reviewed: the stops no longer block their scopes.
    expect(running(mapId).map((run) => run.purpose)).toEqual([
      "spec_review",
      "spec_review",
      "spec_review",
    ]);
  });

  test("a stopped to_tickets on an approved spec keeps Try again while the map is un-cleared", async () => {
    const { mapId, specIds } = await specsOnMap(2);
    const one = at(specIds, 0);
    const two = at(specIds, 1);
    review(mapId, one, []);
    expect(
      approveSpecRevision(context.user, context.db, { specRevisionId: latest(one).id }).ok,
    ).toBe(true);
    const stopped = stop(specRun(mapId, one, "to_tickets"));
    review(mapId, two, [DECISION]);
    expect(clearedNow(mapId)).toBe(false);
    expect(tryAgain(context.user, context.db, stopped.id)).toEqual({ ok: true, value: mapId });
    expect(specRun(mapId, one, "to_tickets").retryOfRunId).toBeNull();
  });
});

test("a spec_review's request reads the revision pinned at its start", async () => {
  const { mapId, specificationId } = await draftedSpec(context, project);
  const work = await prepareRun(context.db, specRun(mapId, specificationId, "spec_review").id);
  expect(work.ok && work.value.request).toMatchObject({
    revision: { specNumber: 1, revision: 1 },
    before: null,
  });
  expect(context.db.select().from(specRevisions).all()).toHaveLength(1);
});
