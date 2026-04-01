# AGENTS

## Project Overview
codebox is a Bun-powered CLI that rsyncs a local workspace to a remote host and bootstraps Codex/OpenCode tooling using Devbox. It also syncs optional configs (Codex, OpenCode, GH, SSH) and environment variables.

## Key Files
- `codebox.ts` - main CLI implementation, rsync/ssh orchestration, env sync, and remote bootstrap script.
- `bin/codebox` - npm-installed CLI entrypoint (Bun shebang).
- `package.json` - npm metadata, bin mapping, and test script.
- `tests/integration/install.test.mjs` - integration test that verifies install exposes `codebox` on PATH.
- `README.md` - installation and usage documentation.
- `LICENSE` - license.

## How To Test
- `npm test`
