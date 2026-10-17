import { describe, expect, it } from "vitest";

import { laterRevisionsLine, touchOrigin } from "./touches.ts";

describe("the Touches card's lines", () => {
  it("names the map that wrote the touched revision and whether it is delivered", () => {
    expect(touchOrigin({ writerMapTitle: "Real URL slugs", delivered: true })).toBe(
      "Its current revision came from “Real URL slugs” and is delivered.",
    );
    expect(touchOrigin({ writerMapTitle: "Real URL slugs", delivered: false })).toBe(
      "Its current revision came from “Real URL slugs” and isn't delivered yet.",
    );
  });

  it("counts the later revisions, none giving no line", () => {
    expect(laterRevisionsLine(0)).toBeNull();
    expect(laterRevisionsLine(1)).toBe("1 later revision exists already.");
    expect(laterRevisionsLine(2)).toBe("2 later revisions exist already.");
  });
});
