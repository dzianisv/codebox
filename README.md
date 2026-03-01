# codebox

Devbox-powered workspace sync and bootstrap for remote Codex/OpenCode.

## Install (one line)

```sh
curl -fsSL https://bun.sh/install | bash && npm install -g @dzianisv/codebox
```

## Usage

```sh
codebox --remote azureuser@dev-1 --base '$HOME/workspace'
```

If you don't pass `--remote`, the last used remote is loaded from:

```
~/.config/codebox.json
```

## Notes

- Requires `bun` (the CLI uses a `#!/usr/bin/env bun` shebang).
- Uses `rsync` and `ssh` under the hood.
- Syncs `.git` by default so the remote is a real git repo.
- Excludes `codex-rs/target*`, `node_modules`, `dist`, `.venv` by default.
- Syncs env vars into remote `~/.bashrc` (defaults include `GITHUB_TOKEN`, `OPENAI_*`, `AZURE_OPENAI_*`, `OPENCODE_*`, `CODEX_*`, and any `*_TOKEN`). Use `--no-env`, `--env`, `--env-prefix` to control.
