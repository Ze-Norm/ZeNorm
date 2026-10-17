import { webDistDir } from "@zenorm/web";

import { serveZeNorm } from "./serve.ts";
import { SOURCE_ASSETS } from "./source-assets.ts";

// The open-source app composes no plugin. It runs from source with the repository's
// assets, and requires --config or ZENORM_CONFIG: no standard config path.
await serveZeNorm({
  args: process.argv.slice(2),
  webDistDir,
  ...SOURCE_ASSETS,
  standardConfigPath: null,
  plugins: [],
});
