import { err, HATCH_STAGES_WITHOUT_SPEC, ok } from "@zenorm/contracts";
import type {
  Actor,
  HatchStage,
  MapOverviewDetail,
  MapSpec,
  Result,
  SendHatchMessageError,
  SendHatchMessageInput,
} from "@zenorm/contracts";
import { hatchMessages } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { v7 as uuidv7 } from "uuid";

import { getMapOverview } from "./map-overview.ts";
import type { RunnerStates } from "./map-overview.ts";
import { now } from "./planning-runs.ts";
import { planAndRelease, waitsOn } from "./spec-holds.ts";
import { readProjectSpecs } from "./specs.ts";
import { write } from "./writes.ts";

/** The stages whose messages name the spec on screen. */
type SpecStage = Exclude<HatchStage, "idea" | "wayfinding">;

function hasSpec(stage: HatchStage): stage is SpecStage {
  return !HATCH_STAGES_WITHOUT_SPEC.includes(stage);
}

/**
 * The spec a message names: none on Idea and Wayfinding; on Spec and Tickets the number the page
 * sent, which is the spec it shows (`map.overview` decides the stage's default, the web renders
 * it); null when the page showed none.
 */
function messageSpec(
  db: ZeNormDatabase,
  overview: MapOverviewDetail,
  input: SendHatchMessageInput,
): Result<MapSpec | null, SendHatchMessageError> {
  const { stage, specNumber, mapId } = input;
  if (!hasSpec(stage)) {
    if (specNumber !== null) {
      throw new Error(`A ${stage} message names spec ${String(specNumber)}`);
    }
    return ok(null);
  }
  if (specNumber === null) {
    return ok(null);
  }
  const spec = overview.specs.find((candidate) => candidate.number === specNumber);
  if (spec === undefined) {
    // A map that only waits on the spec wrote no revision of it.
    const waited = readProjectSpecs(db, overview.project.id).find(
      (candidate) => candidate.number === specNumber,
    );
    if (waited !== undefined && waitsOn(db, mapId, waited.id)) {
      return err({
        code: "spec_waiting",
        message: `Map ${mapId} waits on spec ${String(specNumber)} and wrote no revision of it`,
        data: { mapId, specNumber },
      });
    }
    return err({
      code: "spec_not_found",
      message: `Map ${mapId} wrote no revision of spec ${String(specNumber)}`,
      data: { mapId, specNumber },
    });
  }
  return ok(spec);
}

/**
 * `hatch.send`: stores the message with its map, stage, spec and trimmed text and, as every write
 * does, starts what is due in the same transaction (its `hatch` run when the queue allows); it is
 * never refused for what is in flight. Refused `map_not_found`, then `hatch_message_empty` for
 * blank text, then, for a spec the map wrote no revision of, `spec_waiting` when the map waits on
 * it, else `spec_not_found`; each writes nothing. Returns the map's overview, whose messages list
 * it queued.
 */
export async function sendHatchMessage(
  actor: Actor,
  db: ZeNormDatabase,
  input: SendHatchMessageInput,
  runners: RunnerStates,
): Promise<Result<MapOverviewDetail, SendHatchMessageError>> {
  const { mapId } = input;
  const before = await getMapOverview(db, mapId, runners);
  if (!before.ok) {
    return before;
  }
  const text = input.text.trim();
  if (text === "") {
    return err({
      code: "hatch_message_empty",
      message: "A message needs some text",
      data: { mapId },
    });
  }
  const spec = messageSpec(db, before.value, input);
  if (!spec.ok) {
    return spec;
  }
  // The write starts the map's due runs, the message's `hatch` run among them.
  write(db, actor, (tx) => {
    tx.insert(hatchMessages)
      .values({
        id: uuidv7(),
        mapId,
        stage: input.stage,
        specificationId: spec.value === null ? null : spec.value.id,
        text,
        sentAt: now(),
        runId: null,
        reply: null,
        refusal: null,
        change: null,
        repliedAt: null,
      })
      .run();
    planAndRelease(actor, tx, mapId);
  });
  const after = await getMapOverview(db, mapId, runners);
  if (!after.ok) {
    throw new Error(`Map ${mapId} vanished after a message was stored on it`);
  }
  return ok(after.value);
}
