# Developing ZeNorm

How to work on ZeNorm itself. To install and run it, see [SETUP.md](SETUP.md).

## Running from a checkout

You need Node.js 26.11.1 or later (pinned in [`.nvmrc`](.nvmrc)), pnpm 10.33.2 (`packageManager` in [`package.json`](package.json); for example `npm install -g pnpm@10.33.2`), git, and Claude Code installed and signed in.

```sh
git clone https://github.com/Ze-Norm/ZeNorm.git zenorm
cd zenorm
pnpm install
mkdir ~/zenorm-data
cp config.example.json ~/zenorm-config.json   # set dataDir, agent.claudePath
ZENORM_CONFIG=~/zenorm-config.json pnpm dev
```

Keep the config outside the checkout. `dataDir` must be an existing directory, and `agent.claudePath` the absolute path to `claude` (the output of `command -v claude`); [SETUP.md](SETUP.md) explains every key. Open the host and port from the config (`http://127.0.0.1:4310` with the example).

## Checks

```sh
pnpm exec playwright install chromium   # once
pnpm check                              # prettier, then typecheck, lint, test and e2e
pnpm format                             # fix formatting
```

`pnpm check` never runs the real Claude Code CLI; the end-to-end tests use a scripted stand-in. An opt-in live test runs against the real CLI:

```sh
ZENORM_LIVE_CLAUDE_PATH="$(command -v claude)" pnpm --filter @zenorm/agent test:live
```

Changes to the CLI, its packing or the assets it ships also need the install smoke test, which packs the CLI, installs it with npm outside the repository and drives it end to end. It is outside `pnpm check` (it installs from the npm registry); CI runs it:

```sh
pnpm exec turbo run pack --filter=@ze-norm/cli && pnpm --filter @ze-norm/cli smoke
```

## Plugins

`pnpm dev:example` serves ZeNorm composed with the [example plugin](examples/plugin-example), which exercises every extension point; its config needs a `plugins.example` section. [`examples/bad-plugins`](examples/bad-plugins) has one broken plugin per startup error.

## Where things are

- [`AGENTS.md`](AGENTS.md): the packages, what each may import, and the rules the code follows (no silent defaults, coded errors, shadcn over bespoke Tailwind).
- [`CONTEXT.md`](CONTEXT.md): the glossary. Its terms are the identifiers in the code.
- [`skills/`](skills/README.md): the skills ZeNorm's agents follow at run time, and the ones used to develop ZeNorm.
