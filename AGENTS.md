# ZeNorm

Local web workspace: a person adds a project (a git repository), plans changes in maps with a planning agent, and gets them delivered as reviewed branches ready to merge.

## Packages

All packages are `@zenorm/<dir>`, ESM, exporting TypeScript source, except the published `@ze-norm/cli`. "→" lists what each may import from the workspace; keep each package's `dependencies` within it.

- `packages/contracts` → none. Zod schemas, oRPC contract, `Result`, error codes, config schema, seam signatures.
- `packages/db` → contracts. Drizzle schema, migrations, change-feed triggers.
- `packages/core` → contracts, db. Domain functions, git and check commands, `write` (every write names its Actor), `ChangeBus`, seams. No HTTP, no React.
- `packages/agent` → contracts. Every Claude Code CLI session (planning, spec, tickets, delivery). No HTTP, no database.
- `packages/server` → contracts, core, db, plugin-sdk. Hono app (request guard, `/rpc`, `/events`, plugins, executor registry), in-process runners.
- `packages/web` → contracts, plugin-sdk. Vite, React, TanStack Router and Query, Tailwind v4, shadcn. The `.` entry stays Node-safe; the app is at `@zenorm/web/app`.
- `packages/plugin-sdk` → contracts.
- `apps/zenorm` → contracts, agent, db, server, web (only `webDistDir`). The app entry and its Playwright e2e.
- `examples/plugin-example` → plugin-sdk, contracts. Exercises every extension point; `examples/bad-plugins/` has one bad plugin per startup error code.
- `apps/zenorm-example` → contracts, server, web, plugin-sdk, the example plugin, apps/zenorm.
- `apps/cli` → contracts, agent, apps/zenorm, web (only `webDistDir`, at build time). The published `zenorm` command. `COMMANDS` in `src/commands.ts` is the one command table; read `buildProgram`'s comment in `src/cli.ts` before touching commander. better-sqlite3 and playwright-core (the screenshot capture's Playwright MCP server) are its only `dependencies` entries; everything else it imports, workspace or not, is a devDependency the esbuild bundle inlines.

`skills/` and `CONTEXT.md` are outside the workspace and every check.

## Rules

- No silent defaults: missing config or data is a coded error, never a fallback value, so a gap fails at its source. `pnpm lint` catches the common forms, not all of them.
- Expected failures return a `Result` with a stable error code; only programmer errors throw. Tests assert codes, never message text.
- Use shadcn components over bespoke Tailwind.
- `CONTEXT.md` glossary terms are the identifiers (`Project`, not `Repo`).
- Server-side code runs on Node type stripping: relative imports end in `.ts` (`.tsx` in the web entries).
- Packages log through the `log` function the app passes in, never `console`.

## Checks

`pnpm check` is the gate (prettier, typecheck, lint, test, e2e); `pnpm format` fixes formatting. CI runs on Linux without e2e, so run `pnpm check` locally before pushing. Setup, the dev server and the opt-in live test are in `DEVELOPING.md`; config keys in `SETUP.md`. Releases go only through `.github/workflows/publish.yml`, on a `v<version>` tag; never publish by hand.
