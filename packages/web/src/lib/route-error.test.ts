import { ORPCError } from "@orpc/client";
import { SearchParamError } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { describeQueryRefusal, describeRouteError, type RouteErrorPlace } from "./route-error.ts";

const MAP = "01a1313b-beeb-7609-9cc5-389d81762036";
const PROJECT = "01a1312d-46c1-749f-ac5c-729ab1043e20";

const nowhere: RouteErrorPlace = {
  mapId: undefined,
  projectId: undefined,
  stage: undefined,
  specNumber: undefined,
  number: undefined,
  ticketId: undefined,
  search: {},
};

function at(place: Partial<RouteErrorPlace>): RouteErrorPlace {
  return { ...nowhere, ...place };
}

function zodFailure(): Error {
  const result = z.uuid().safeParse("nope");
  if (result.success) throw new Error("A uuid schema accepted 'nope'");
  return result.error;
}

describe("the route error page's sentence and links", () => {
  it("names a search key that belongs to another stage and links both stages", () => {
    const view = describeRouteError(
      new Error("?revision= belongs to the spec stage, not tickets"),
      at({ mapId: MAP, stage: "tickets", search: { revision: 1 } }),
    );
    expect(view.sentence).toBe(
      "?revision= names a spec revision, which the Spec stage shows, not Tickets.",
    );
    expect(view.detail).toBe("?revision= belongs to the spec stage, not tickets");
    expect(view.links).toEqual([
      {
        label: "Open Spec revision 1",
        to: "stage",
        mapId: MAP,
        stage: "spec",
        specNumber: null,
        search: { revision: 1 },
      },
      {
        label: "Open Tickets",
        to: "stage",
        mapId: MAP,
        stage: "tickets",
        specNumber: null,
        search: {},
      },
      { label: "Back to the inbox", to: "inbox" },
    ]);
  });

  it("says which record the map lacks and links the stage's latest, keeping the spec number", () => {
    const view = describeRouteError(
      new Error("This map has no ticket set version 9"),
      at({ mapId: MAP, stage: "tickets", specNumber: 2, search: { version: 9 } }),
    );
    expect(view.sentence).toBe("This map has no ticket set version 9.");
    expect(view.links[0]).toEqual({
      label: "Open the latest ticket set version",
      to: "stage",
      mapId: MAP,
      stage: "tickets",
      specNumber: 2,
      search: {},
    });
  });

  it("links Wayfinding for a waypoint the map does not have", () => {
    const view = describeRouteError(
      new Error(`Map ${MAP} has no waypoint 99`),
      at({ mapId: MAP, number: 99 }),
    );
    expect(view.sentence).toBe("This map has no waypoint 99.");
    expect(view.links.map((link) => link.label)).toEqual(["Open Wayfinding", "Back to the inbox"]);
  });

  it("links the stage's default spec for a spec the map did not write", () => {
    const view = describeRouteError(
      new Error("This map wrote no spec 9"),
      at({ mapId: MAP, stage: "spec", specNumber: 9 }),
    );
    expect(view.sentence).toBe("This map wrote no spec 9.");
    expect(view.links[0]).toEqual({
      label: "Open Spec",
      to: "stage",
      mapId: MAP,
      stage: "spec",
      specNumber: null,
      search: {},
    });
  });

  it("links Delivery for a ticket no run of the spec carries, with or without ?run=", () => {
    const latest = describeRouteError(
      new Error("This map has no delivery run"),
      at({ mapId: MAP, specNumber: 1, ticketId: "T9" }),
    );
    expect(latest.sentence).toBe("No delivery run of spec 1 on this map carries ticket T9.");
    expect(latest.links[0]).toMatchObject({ to: "stage", stage: "delivery", specNumber: null });
    const numbered = describeRouteError(
      new Error("Run 2 has no ticket T9"),
      at({ mapId: MAP, specNumber: 1, ticketId: "T9", search: { run: 2 } }),
    );
    expect(numbered.sentence).toBe(
      "Delivery run 2 of spec 1 on this map has no ticket T9, or there is no such run.",
    );
  });

  it("treats a param or search that failed to parse as an unopenable address", () => {
    const wrapped = new Error("Invalid input", { cause: zodFailure() });
    const view = describeRouteError(wrapped, at({ mapId: MAP, stage: "nope" }));
    expect(view.sentence).toBe("This address is not one ZeNorm can open.");
    expect(view.detail).toBe("Invalid UUID");
    expect(view.links.map((link) => link.label)).toEqual(["Open the map", "Back to the inbox"]);

    const search = describeRouteError(
      new SearchParamError("Unrecognized key"),
      at({ projectId: PROJECT }),
    );
    expect(search.links.map((link) => link.label)).toEqual([
      "Open the project",
      "Back to the inbox",
    ]);

    // A raw param that did not parse is not offered as a link.
    const rawMap = describeRouteError(zodFailure(), at({ mapId: "not-a-uuid" }));
    expect(rawMap.links).toEqual([{ label: "Back to the inbox", to: "inbox" }]);
  });

  it("falls back to the stage, the map, the project or the inbox for any other error", () => {
    expect(
      describeRouteError(new Error("Map has no next action"), at({ mapId: MAP, stage: "idea" })),
    ).toMatchObject({
      sentence: "Idea could not be shown.",
      detail: "Map has no next action",
      links: [{ label: "Open Idea" }, { label: "Back to the inbox" }],
    });
    expect(describeRouteError(new Error("x"), at({ mapId: MAP })).sentence).toBe(
      "This map's page could not be shown.",
    );
    expect(describeRouteError(new Error("x"), at({ projectId: PROJECT })).sentence).toBe(
      "This project's page could not be shown.",
    );
    expect(describeRouteError("boom", nowhere)).toEqual({
      title: "Could not open this page",
      sentence: "This page could not be shown.",
      detail: "boom",
      links: [{ label: "Back to the inbox", to: "inbox" }],
    });
    expect(describeRouteError(new Error(""), nowhere).detail).toBeNull();
  });

  it("drops the detail line when it only repeats the sentence", () => {
    const repeat = describeRouteError(
      new Error("This map has no spec revision 9"),
      at({ mapId: MAP, stage: "spec", search: { revision: 9 } }),
    );
    expect(repeat.sentence).toBe("This map has no spec revision 9.");
    expect(repeat.detail).toBeNull();
    const other = describeRouteError(
      new Error("Revision 9 is past the latest, 2"),
      at({ mapId: MAP, stage: "spec", search: { revision: 9 } }),
    );
    expect(other.detail).toBe("Revision 9 is past the latest, 2");
  });
});

describe("a refused read's page", () => {
  it("is what the route error boundary shows for a thrown map_not_found", () => {
    const thrown = new ORPCError("map_not_found", {
      message: `No map with id ${MAP}`,
      data: { mapId: MAP },
      defined: true,
    });
    const view = describeRouteError(thrown, at({ mapId: MAP, stage: "idea" }));
    expect(view.title).toBe("Map not found");
    expect(view.detail).toBe(MAP);
    expect(view.links).toEqual([{ label: "Back to the inbox", to: "inbox" }]);
  });

  it("names the missing map or project with its id as the detail and leads to the inbox", () => {
    const map = describeQueryRefusal({ code: "map_not_found", message: "", data: { mapId: MAP } });
    expect(map.title).toBe("Map not found");
    expect(map.detail).toBe(MAP);
    expect(map.links).toEqual([{ label: "Back to the inbox", to: "inbox" }]);
    const project = describeQueryRefusal({
      code: "project_not_found",
      message: "",
      data: { projectId: PROJECT },
    });
    expect(project.title).toBe("Project not found");
    expect(project.detail).toBe(PROJECT);
  });

  it("says the access check refused the project", () => {
    const view = describeQueryRefusal({
      code: "access_denied",
      message: "",
      data: { projectId: PROJECT, action: "read" },
    });
    expect(view.title).toBe("Access denied");
    expect(view.sentence).toContain(PROJECT);
    expect(view.detail).toBeNull();
  });
});
