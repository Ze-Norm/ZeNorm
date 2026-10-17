import { rmSync } from "node:fs";

import { e2eRoot } from "./fixture.ts";

export default function globalTeardown(): void {
  rmSync(e2eRoot(), { recursive: true, force: true });
}
