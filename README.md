# codebox

Devbox-powered workspace sync and bootstrap for remote Codex/OpenCode.

## Install (one line)

```sh
curl -fsSL https://bun.sh/install | bash && npm install -g @dzianisv/codebox
```

## Install (local repo)

```sh
cd /Users/engineer/workspace/codebox
npm install -g .
```

## Usage

```sh
codebox --remote azureuser@dev-1 --base '$HOME/workspace'
```

Quick SSH access to the synced repo on remote:

```sh
codebox ssh azureuser@dev-1
codebox ssh azureuser@dev-1 -- git status -sb
codebox ssh -L 4097:127.0.0.1:4097 -N
```

If you don't pass `--remote`, the last used remote is loaded from:

```
~/.config/codebox.json
```

## Notes

- Requires `bun` (the CLI uses a `#!/usr/bin/env bun` shebang).
- Uses `rsync` and `ssh` under the hood.
- `codebox ssh` auto-enters `$BASE/<current-folder>` on remote when that directory exists.
- In `codebox ssh` mode, unknown flags are passed through to `ssh` (for example `-L`, `-R`, `-D`, `-N`, `-p`, `-i`).
- Syncs `.git` by default so the remote is a real git repo.
- Excludes `codex-rs/target*`, `node_modules`, `dist`, `.venv` by default.
- Syncs env vars into remote `~/.bashrc` (defaults include `GITHUB_TOKEN`, `OPENAI_*`, `AZURE_OPENAI_*`, `OPENCODE_*`, `CODEX_*`, and any `*_TOKEN`). Use `--no-env`, `--env`, `--env-prefix` to control.
- Prompts before syncing secrets or `~/.ssh` unless `--yes` is provided.
- Use `-v/--verbose` for rsync progress output.
- Sync mode now ensures OpenCode is running on remote (`127.0.0.1:5551`) and starts a background local SSH tunnel by default:
  - `localhost:5551 -> remote:127.0.0.1:5551`
  - disable with `--no-opencode-tunnel`
  - override ports with `--opencode-local-port <n>` and `--opencode-remote-port <n>`

Install Jetify `devbox` CLI into your Bun local bin path:

```sh
bun run install:devbox
# optional
bun run install:devbox -- --dry-run
bun run install:devbox -- --version 0.17.0
```
