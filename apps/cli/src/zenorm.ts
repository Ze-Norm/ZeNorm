import { dirname } from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { refusalReporter, runCli } from "./cli.ts";
import { COMMANDS } from "./commands.ts";
import { packagedAssets } from "./packaged.ts";

// The `zenorm` bin. The build bundles this file to `dist/zenorm.js`, beside the skills, migrations
// and web build it copies in, so the bundle's own folder is where the assets are.
const distDir = dirname(fileURLToPath(import.meta.url));

const ended = await runCli(
  {
    argv: process.argv.slice(2),
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    assets: packagedAssets(distDir),
    writeOut: (text) => {
      process.stdout.write(text);
    },
  },
  COMMANDS,
  // Readable refusals at a terminal; one JSON line each when standard error is piped (C7).
  refusalReporter(isatty(2)),
);
// `run` keeps the process open while it serves; it exits on SIGTERM or SIGINT.
if (ended !== "serving") {
  process.exit(ended);
}
