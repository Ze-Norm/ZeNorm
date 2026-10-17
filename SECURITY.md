# Security policy

ZeNorm is pre-release. Only the latest `main` is supported: fixes land there, and there are no backports.

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open the repository's [Security tab and choose "Report a vulnerability"](https://github.com/Ze-Norm/ZeNorm/security/advisories/new). Please don't open a public issue, pull request or discussion for it.

Include what you found, how to reproduce it, the ZeNorm version or commit, and what an attacker could do with it. We'll reply on the advisory and keep you updated there until it's fixed.

## What ZeNorm exposes

ZeNorm runs on your machine. Its web app listens on the host and port in your config (`server.host` and `server.port`); the config `zenorm init` writes uses `127.0.0.1` and `4310`, so only your machine can reach it. The server refuses a request whose `Host` is not that host and port, `localhost`, `127.0.0.1` or `[::1]`, and refuses a call to its API from another site's page.

The agents ZeNorm runs are Claude Code sessions on your machine, working in your project with your user's permissions. Its records stay in a local SQLite database in its data folder. [SETUP.md](SETUP.md) describes the config.
