import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the annotation widget's notes land on disk, at the demo root.
 * This file is the source of truth the agent reads between annotation rounds.
 * The widget keeps a browser copy too, so notes survive if the demo is served
 * without this plugin (a static build, for example).
 */
const ANNOTATIONS_FILE = path.resolve(dirname, "annotations.json");

/**
 * Dev-only middleware behind the annotation widget. `GET` returns the notes,
 * `POST` replaces them, so a browser can hand structured feedback to an agent
 * that only reads files.
 */
function annotationFile(endpoint: string): Plugin {
  const respond = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  return {
    name: "demo-annotation-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(endpoint, (req, res) => {
        if (req.method === "GET") {
          try {
            const raw = fs.existsSync(ANNOTATIONS_FILE)
              ? fs.readFileSync(ANNOTATIONS_FILE, "utf8").trim()
              : "";
            respond(res, 200, raw ? JSON.parse(raw) : []);
          } catch (error) {
            respond(res, 500, { error: String(error) });
          }
          return;
        }

        if (req.method === "POST") {
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
          });
          req.on("end", () => {
            try {
              const notes = JSON.parse(raw);
              if (!Array.isArray(notes)) throw new Error("expected an array of annotations");
              fs.writeFileSync(ANNOTATIONS_FILE, `${JSON.stringify(notes, null, 2)}\n`);
              respond(res, 200, { ok: true, file: path.basename(ANNOTATIONS_FILE) });
            } catch (error) {
              respond(res, 400, { ok: false, error: String(error) });
            }
          });
          return;
        }

        respond(res, 405, { ok: false, error: `${req.method} not allowed` });
      });
    },
  };
}

// Throwaway demo host. One command: `pnpm dev`.
// Simulated functionality only: no backend, no tests, no error handling past runnable.
export default defineConfig({
  plugins: [react(), tailwindcss(), annotationFile("/__annotations")],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  server: {
    watch: {
      // The widget rewrites this file every time the user saves a note. Without
      // this, Vite treats it as a project change and reloads the page, throwing
      // away the panel and the note being composed.
      ignored: ["**/annotations.json"],
    },
  },
});
