import { fileURLToPath } from "node:url";

import { createExamplePlugin } from "@zenorm/plugin-example/server";
import { serveZeNorm } from "@zenorm/zenorm/serve";
import { SOURCE_ASSETS } from "@zenorm/zenorm/source-assets";

/** This app's own web build, composed with the example plugin (`vite build`). */
const webDistDir = fileURLToPath(new URL("../dist", import.meta.url));

// `apps/zenorm` composed with the example plugin; its executor sits beside `"local"`, and the
// config's `delivery.executor` chooses. It runs from source with the repository's skills and
// migrations, and requires --config or ZENORM_CONFIG.
await serveZeNorm({
  args: process.argv.slice(2),
  webDistDir,
  ...SOURCE_ASSETS,
  standardConfigPath: null,
  plugins: [createExamplePlugin()],
});
