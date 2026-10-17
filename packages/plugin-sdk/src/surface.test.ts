import { readFile } from "node:fs/promises";

import ts from "typescript";
import { expect, test } from "vitest";

import * as sdk from "./index.ts";

/**
 * The SDK's public surface (S9-18; SDK §6): its runtime exports, their values where they are data,
 * and the declarations of every exported type, so any change to the surface shows in review as a
 * snapshot diff.
 */
test("the exported names and values", () => {
  expect(Object.keys(sdk).sort()).toMatchInlineSnapshot(`
    [
      "DeliveryAgentErrorCode",
      "ImplementEvent",
      "ImplementRequest",
      "PullRequestRequest",
      "ReviewRequest",
      "SDK_VERSION",
      "SEAM_NAMES",
      "SLOT_NAMES",
      "Verdict",
      "definePlugin",
      "defineWebPlugin",
      "err",
      "gitIdentityEnv",
      "ok",
      "ticketBranchName",
    ]
  `);
  expect(sdk.SDK_VERSION).toBe("0.1.0");
  expect({ slots: sdk.SLOT_NAMES, seams: sdk.SEAM_NAMES }).toMatchInlineSnapshot(`
    {
      "seams": [
        "identify",
        "checkAccess",
        "checkout",
        "executorEnv",
        "admitRun",
      ],
      "slots": [
        "header.end",
        "project.page.sections",
        "map.workspace.aside",
      ],
    }
  `);
});

test("the exported declarations", async () => {
  const source = await readFile(new URL("index.ts", import.meta.url), "utf8");
  const { outputText, diagnostics } = ts.transpileDeclaration(source, {
    compilerOptions: { removeComments: true },
  });
  expect(diagnostics).toEqual([]);
  await expect(outputText).toMatchFileSnapshot("__snapshots__/index.d.ts.snap");
});
