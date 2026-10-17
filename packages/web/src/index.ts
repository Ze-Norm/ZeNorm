import { fileURLToPath } from "node:url";

/** Absolute path of the built web app (`vite build` output). Node-safe: imports no React. */
export const webDistDir = fileURLToPath(new URL("../dist", import.meta.url));

/**
 * `createWebApp({ plugins })` (S9-18) is the browser entry, exported as `@zenorm/web/app`: it
 * imports React, CSS and fonts, which Node (`apps/zenorm`'s `main.ts`, importing `webDistDir`
 * from here) cannot load, so it is not re-exported from this Node-safe entry.
 */
