import type { Project } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMap, listMaps } from "./map.ts";
import {
  addProject,
  closeTestContext,
  newMap,
  openTestContext,
  propose,
  PROPOSAL,
  UNKNOWN_ID,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-map-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

describe("listMaps", () => {
  test("project_not_found for an unknown project", async () => {
    const result = await listMaps(context.db, UNKNOWN_ID);
    expect(!result.ok && result.error.code).toBe("project_not_found");
  });

  test("is empty for a project without maps", async () => {
    expect(await listMaps(context.db, project.id)).toEqual({ ok: true, value: [] });
  });

  test("returns only the project's maps, oldest first", async () => {
    const other = await addProject(context, "other");
    const first = await newMap(context, project, "First");
    await newMap(context, other, "Elsewhere");
    const second = await newMap(context, project, "Second");
    const listed = await listMaps(context.db, project.id);
    expect(listed.ok && listed.value.map((map) => map.id)).toEqual([first, second]);
  });
});

describe("getMap", () => {
  test("returns the map with its project, and its reading once charted", async () => {
    const mapId = await newMap(context, project, "Export data");
    const before = await getMap(context.db, mapId);
    expect(before.ok && before.value).toMatchObject({
      map: { id: mapId, idea: "Export data", title: null },
      project: { id: project.id },
    });
    propose(context, mapId);
    const after = await getMap(context.db, mapId);
    expect(after.ok && after.value.map.title).toBe(PROPOSAL.title);
  });

  test("map_not_found for an unknown map", async () => {
    const result = await getMap(context.db, UNKNOWN_ID);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "map_not_found", data: { mapId: UNKNOWN_ID } },
    });
  });
});
