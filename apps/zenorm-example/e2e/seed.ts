import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SOURCE_ASSETS } from "@zenorm/zenorm/source-assets";
import { startZeNorm } from "@zenorm/zenorm/startup";

import { SEEDED_FILE } from "./fixture.ts";

/**
 * Run by `playwright.config.ts` before the server starts: as `apps/zenorm` with no plugin, adds
 * the project at `<deniedRepo>` and one map in it, then closes. The example server then starts on
 * the same data with `denied-repo` in `deniedProjectNames`, so a map of a denied project exists, as
 * when a config denies a project that already has maps. Writes `{ projectId, mapId }` to
 * `<root>/seeded.json`.
 */
const [configPath, webDistDir, deniedRepo] = process.argv.slice(2);
if (configPath === undefined || webDistDir === undefined || deniedRepo === undefined) {
  throw new Error("seed.ts <config.json> <webDistDir> <denied repo>");
}

const started = await startZeNorm({
  args: ["--config", configPath],
  // The config comes from --config alone, whatever this shell sets; `PATH` is only for the
  // stand-in claude's `#!/usr/bin/env node`, run by the sign-in check.
  env: { PATH: process.env.PATH },
  webDistDir,
  ...SOURCE_ASSETS,
  standardConfigPath: null,
  log: (line) => {
    console.log(line);
  },
  logError: (message, error) => {
    console.error(message, error);
  },
  plugins: [],
});
if (!started.ok) throw new Error(JSON.stringify(started.error));
const { app, db, config } = started.value;
app.launch();
// The Host the server accepts: the config's host and port.
const host = `${config.server.host}:${String(config.server.port)}`;

async function rpc(path: string, input: unknown): Promise<unknown> {
  const response = await app.fetch(
    new Request(`http://${host}/rpc/${path}`, {
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ json: input, meta: [] }),
    }),
  );
  const body: unknown = await response.json();
  if (!response.ok || typeof body !== "object" || body === null || !("json" in body)) {
    throw new Error(`/rpc/${path} answered ${String(response.status)}: ${JSON.stringify(body)}`);
  }
  return body.json;
}

function idOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    throw new Error(`No id in ${JSON.stringify(value)}`);
  }
  return String(value.id);
}

const projectId = idOf(await rpc("project/create", { folderPath: deniedRepo, baseBranch: "main" }));
const created = await rpc("map/create", { projectId, idea: "A map the example plugin denies" });
if (typeof created !== "object" || created === null || !("map" in created)) {
  throw new Error(`map.create answered ${JSON.stringify(created)}`);
}
const mapId = idOf(created.map);
await Promise.all([app.stopPlanningRuns(), app.stopDeliveryRuns()]);
await app.stopPlugins();
db.$client.close();
writeFileSync(join(dirname(configPath), SEEDED_FILE), JSON.stringify({ projectId, mapId }));
