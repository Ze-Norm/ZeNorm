import { defineWebPlugin, SDK_VERSION } from "@zenorm/plugin-sdk";
import type { WebPlugin } from "@zenorm/plugin-sdk";
import { describe, expect, it } from "vitest";

import { checkSlotNames, checkWebPlugins, comparePluginSets, parsePluginList } from "./plugins.ts";

const sdk = `^${SDK_VERSION}`;
const Nothing = () => null;

function plugin(id: string, version: string): WebPlugin {
  return defineWebPlugin({ id, version, sdk, slots: { "header.end": Nothing } });
}

/** A plugin built outside the type check, with a slot key the SDK does not have. */
function pluginWithSlot(id: string, slot: string): WebPlugin {
  return { kind: "web", id, version: "1.0.0", sdk, slots: { [slot]: Nothing } };
}

function answer(body: unknown, status: number): () => Promise<Response> {
  return () => Promise.resolve(Response.json(body, { status }));
}

describe("comparePluginSets (S9-18, D16)", () => {
  it("passes with no plugins on either side", () => {
    expect(comparePluginSets([], [])).toEqual({ ok: true, value: null });
  });

  it("passes when ids and versions match in order", () => {
    const result = comparePluginSets(
      [
        { id: "a", version: "1.0.0" },
        { id: "b", version: "2.1.0" },
      ],
      [plugin("a", "1.0.0"), plugin("b", "2.1.0")],
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a plugin only the server runs", [{ id: "a", version: "1.0.0" }], []],
    ["a plugin only the web runs", [], [plugin("a", "1.0.0")]],
    ["a different version", [{ id: "a", version: "1.0.1" }], [plugin("a", "1.0.0")]],
    ["a different id", [{ id: "b", version: "1.0.0" }], [plugin("a", "1.0.0")]],
    [
      "a different order",
      [
        { id: "b", version: "1.0.0" },
        { id: "a", version: "1.0.0" },
      ],
      [plugin("a", "1.0.0"), plugin("b", "1.0.0")],
    ],
  ])("refuses %s with plugin_set_mismatch", (_case, server, web) => {
    const result = comparePluginSets(server, web);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("plugin_set_mismatch");
      expect(result.error.data.server).toEqual(server);
    }
  });
});

describe("checkSlotNames (D16)", () => {
  it("passes every SDK slot", () => {
    const all = defineWebPlugin({
      id: "a",
      version: "1.0.0",
      sdk,
      slots: {
        "header.end": Nothing,
        "project.page.sections": Nothing,
        "map.workspace.aside": Nothing,
      },
    });
    expect(checkSlotNames([all]).ok).toBe(true);
  });

  it("refuses an unknown slot key with plugin_slot_unknown, naming the plugin and the slot", () => {
    const result = checkSlotNames([plugin("a", "1.0.0"), pluginWithSlot("b", "activity.footer")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("plugin_slot_unknown");
      expect(result.error.data).toEqual({ pluginId: "b", slot: "activity.footer" });
    }
  });
});

describe("checkWebPlugins", () => {
  it("passes no plugins against an empty server list", async () => {
    expect(await checkWebPlugins([], answer([], 200))).toEqual({ ok: true, value: null });
  });

  it("checks the slot names before asking the server", async () => {
    let asked = false;
    const result = await checkWebPlugins([pluginWithSlot("a", "nowhere")], () => {
      asked = true;
      return Promise.resolve(Response.json([]));
    });
    expect(result.ok ? null : result.error.code).toBe("plugin_slot_unknown");
    expect(asked).toBe(false);
  });

  it("refuses a server list that differs with plugin_set_mismatch", async () => {
    const result = await checkWebPlugins([], answer([{ id: "a", version: "1.0.0" }], 200));
    expect(result.ok ? null : result.error.code).toBe("plugin_set_mismatch");
  });

  it.each([
    ["a non-2xx status", answer([], 500)],
    ["a body that is not a list", answer({ plugins: [] }, 200)],
    ["a failed request", () => Promise.reject(new Error("offline"))],
  ])("refuses %s with plugin_list_unreadable", async (_case, fetchList) => {
    const result = await checkWebPlugins([], fetchList);
    expect(result.ok ? null : result.error.code).toBe("plugin_list_unreadable");
  });
});

describe("parsePluginList", () => {
  it("parses the contract's list", () => {
    expect(parsePluginList([{ id: "a", version: "1.0.0" }])).toEqual({
      ok: true,
      value: [{ id: "a", version: "1.0.0" }],
    });
  });
});
