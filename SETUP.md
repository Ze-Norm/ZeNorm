# Setting up ZeNorm

This guide covers installing the `zenorm` command, writing its config file and running it. The [README](README.md) has the overview.

> **Pre-release.** Expect breaking changes, including to saved data.

## Requirements

- macOS or Linux. On Windows, use WSL 2; ZeNorm refuses to run on native Windows.
- Node.js 26.11.1 or later. Node 26 is the Current release line, not yet LTS, so an LTS installer gives you Node 24; install 26 with `nvm install 26` (or `fnm install 26`).
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and on your `PATH`. ZeNorm runs it for planning and delivery; `zenorm init` signs it in if it isn't.
- git

## Install

```sh
npm install -g @ze-norm/cli
```

This installs the `zenorm` command. To upgrade later, run the same command again.

## Configure

```sh
zenorm init
```

`zenorm init` asks which model to plan and deliver with (Sonnet 5.5, Haiku 5.5, Opus 5.5, Opus 5.5 in fast mode, Fable 5.1 or any other model id), hands you to Claude Code's own sign-in if it isn't signed in, and writes `~/.config/zenorm/config.json`. If a config is already there, it asks before replacing it and keeps the old file as a backup. The config it writes sets:

- `dataDir`: the `data` folder beside the config (`~/.config/zenorm/data`), created if missing. The database lives at `<dataDir>/zenorm.sqlite`, delivery runs work in `<dataDir>/runs`, and session records go in `<dataDir>/sessions`.
- `agent.claudePath`: the absolute path of the `claude` it found on your `PATH`. ZeNorm runs only the `claude` this key names, never one it finds on `PATH`, so if you move or reinstall Claude Code, update this key (or rerun `zenorm init`).
- `server.host` and `server.port`: `127.0.0.1` and `4310`.

Claude Code's sign-in opens a browser. On a machine without one (SSH, WSL, a container), run `claude auth login` before `zenorm init` and follow its instructions, or set `ANTHROPIC_API_KEY` in the environment you run `zenorm` from: ZeNorm passes its environment on to every Claude Code session, and `zenorm doctor` then reports it signed in (`api_key`).

Every command reads its config from `--config <path>`, else `ZENORM_CONFIG`, else `~/.config/zenorm/config.json`. You can edit the file by hand; [`config.example.json`](config.example.json) lists every key. Every key but `fastMode` is required: ZeNorm refuses to start if a key is missing or unknown, rather than guess a default.

### Keys

| Key                                              | What it does                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.host`, `server.port`                     | Where the web app listens.                                                                                                                                                                                                                                                                                                                                                            |
| `agent.wayfindingModel`                          | Runs the map's charting, questions, research and tasks.                                                                                                                                                                                                                                                                                                                               |
| `agent.specModel`                                | Drafts and reviews the spec and ticket set.                                                                                                                                                                                                                                                                                                                                           |
| `agent.models`                                   | One entry per planning model, giving the length the agent aims for (`aim`) and the most it may write (`max`) in each field it drafts. Both planning models need an entry. The example's values suit Sonnet; for Opus, `zenorm init` writes Opus's own (`OPUS_LIMITS`), and for any other model Sonnet's. The caps are in [`model-limits.ts`](packages/contracts/src/model-limits.ts). |
| `agent.effort`, `agent.maxTurns`                 | Effort and turn budget for each planning run.                                                                                                                                                                                                                                                                                                                                         |
| `agent.timeoutSeconds`                           | How long one planning run may take.                                                                                                                                                                                                                                                                                                                                                   |
| `delivery.model`, `delivery.effort`              | The model and effort for delivery runs.                                                                                                                                                                                                                                                                                                                                               |
| `agent.fastMode`, `delivery.fastMode`            | Optional, `false` when absent. `true` runs those sessions in Claude Code's [fast mode](https://code.claude.com/docs/en/fast-mode): the same Opus model, faster. Needs an Opus model.                                                                                                                                                                                                  |
| `delivery.*MaxTurns`, `delivery.*TimeoutMinutes` | Turn and time budgets for the delivery orchestrator, the reviewer session and your checks.                                                                                                                                                                                                                                                                                            |
| `delivery.executor`                              | Who runs deliveries: `"local"` is Claude Code on this machine; a plugin can register others.                                                                                                                                                                                                                                                                                          |
| `plugins`                                        | One section per plugin, keyed by its id; `{}` for none.                                                                                                                                                                                                                                                                                                                               |

The full schema is in [`packages/contracts/src/config.ts`](packages/contracts/src/config.ts).

## Run

```sh
zenorm run
```

Then open the host and port from your config (`http://127.0.0.1:4310` with the one `zenorm init` writes). Add a project by pointing ZeNorm at a git repository on your machine, then start a map for the change you have in mind.

If ZeNorm won't start, run `zenorm doctor`. It checks Node, the platform, the config, the data folder, Claude Code and its sign-in, git, the web build and the database, changes nothing, and lists every failing check with its code.

## Plugins

A plugin is one package with a server entry and, when it renders anything, a web entry, built on [`@zenorm/plugin-sdk`](packages/plugin-sdk). The [example plugin](examples/plugin-example) exercises every extension point, including its own delivery executor. The `zenorm` command runs without plugins. To compose one, run ZeNorm from a checkout of this repository ([DEVELOPING.md](DEVELOPING.md)): `pnpm dev:example` serves ZeNorm composed with the example plugin; its config needs a `plugins.example` section.
