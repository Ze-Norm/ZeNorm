import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentText, IdeaText } from "./AgentText.tsx";

const SPEC_PAGE = "/maps/01a13c3d-5793-7224-8cbe-ebd162ca7eb3/spec/2";

function html(text: string): string {
  return renderToStaticMarkup(createElement(AgentText, { text }));
}

describe("AgentText", () => {
  it("renders a code span without its backticks", () => {
    const out = html("Run `pnpm check` before merging.");
    expect(out).toContain("<code");
    expect(out).toContain("pnpm check</code>");
    expect(out).not.toContain("`");
  });

  it("renders emphasis and strong", () => {
    const out = html("An *exact* match is **required**.");
    expect(out).toContain("<em>exact</em>");
    expect(out).toContain(">required</strong>");
  });

  it("keeps one line inline, with no paragraph element", () => {
    expect(html("A plain line.")).not.toMatch(/<p|<div/);
  });

  it("renders a list after a line as list items, the line as its own block", () => {
    const out = html("I decided these details:\n- One `bin`\n- A light CLI");
    expect(out).toMatch(/^<span class="block[^"]*">I decided these details:<\/span>/);
    expect(out.match(/class="list-item"/g)).toHaveLength(2);
    expect(out).not.toContain("- ");
  });

  it("renders a numbered list as list items", () => {
    expect(html("Steps:\n\n1. Init\n2. Run").match(/class="list-item"/g)).toHaveLength(2);
  });

  it("shows raw HTML as text, never as markup", () => {
    expect(html("A <b>bold</b> claim.")).not.toContain("<b>");
  });

  it("shows a link's text only, even a spec page's, unless the caller allows spec links", () => {
    const out = html(`See [the PR spec](${SPEC_PAGE}) and [docs](https://example.com).`);
    expect(out).toBe("<span>See the PR spec and docs.</span>");
  });

  it("with spec links, still shows any other link's text only", () => {
    const out = renderToStaticMarkup(
      createElement(AgentText, {
        text: "See [docs](https://example.com) and [a map](/maps/x/spec/2).",
        specLinks: true,
      }),
    );
    expect(out).toBe("<span>See docs and a map.</span>");
  });
});

describe("IdeaText", () => {
  function idea(text: string): string {
    return renderToStaticMarkup(createElement(IdeaText, { text }));
  }

  it("renders code spans without their backticks", () => {
    const out = idea("Run `pnpm install && pnpm dev` with `--config`.");
    expect(out).toContain("pnpm install &amp;&amp; pnpm dev</code>");
    expect(out).toContain("--config</code>");
    expect(out).not.toContain("`");
  });

  it("keeps line breaks and list markers as written", () => {
    expect(idea("What I want:\n- One `bin`\n- A *light* CLI")).toMatch(
      /^What I want:\n- One <code[^>]*>bin<\/code>\n- A \*light\* CLI$/,
    );
  });

  it("closes a span only on a run of its own length, as CommonMark", () => {
    expect(idea("Run ``a `b` c`` now")).toMatch(/^Run <code[^>]*>a `b` c<\/code> now$/);
    expect(idea("Run `` `x` `` now")).toMatch(/^Run <code[^>]*>`x`<\/code> now$/);
  });

  it("leaves unmatched backticks and spans across lines as text", () => {
    expect(idea("Empty `` pair and `x`")).toMatch(/^Empty `` pair and <code[^>]*>x<\/code>$/);
    expect(idea("One ` alone")).toBe("One ` alone");
    expect(idea("Across `two\nlines`")).toBe("Across `two\nlines`");
  });
});
