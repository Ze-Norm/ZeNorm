import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The example composition's web build (S9-20): `src/web.tsx` composes `@zenorm/web/app` with the
 * example plugin. `tsconfigPaths` resolves each file's imports from its nearest tsconfig, so web's
 * `@/` alias reaches `packages/web/src`. One React and one Query client serve web and the plugin.
 */
export default defineConfig({
  plugins: [tailwindcss(), react()],
  // The favicon is web's own.
  publicDir: "../../packages/web/public",
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
});
