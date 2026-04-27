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
codebox --remote azureuser@dev-1
codebox --remote azureuser@dev-1 --exclude '.android-sdk-fixed' --exclude '.gradle-home'
codebox --remote azureuser@dev-1 --opencode-repo-url https://github.com/dzianisv/opencode.git --opencode-ref dev
codebox --remote azureuser@dev-1 --opencode-src ~/workspace/opencode
codebox --resync --dry-run
codebox --resync --repo codebox
```

Quick SSH access to the synced repo on remote:

```sh
codebox ssh azureuser@dev-1
codebox ssh azureuser@dev-1 -- git status -sb
codebox ssh -L 4097:127.0.0.1:4097 -N
```

If you don't pass `--remote`, remembered targets are loaded from:

```
~/.config/codebox.json
```

If the current repo already has remembered VM targets, `codebox` picks from those first. In a TTY it shows a numbered chooser; in non-interactive mode it falls back to the most recent remembered target.

Dedicated tunnel command (starts/reuses background tunnel and returns):

```sh
codebox tunnel
codebox tunnel --opencode-local-port 4097 --opencode-remote-port 4097
codebox tunnel --repo termux-app
codebox tunnel --list
codebox tunnel --all
```

## Notes

- Requires `bun` (the CLI uses a `#!/usr/bin/env bun` shebang).
- Uses `rsync` and `ssh` under the hood.
- `codebox ssh` auto-enters `$BASE/<current-folder>` on remote when that directory exists.
- In `codebox ssh` mode, unknown flags are passed through to `ssh` (for example `-L`, `-R`, `-D`, `-N`, `-p`, `-i`).
- `codebox tunnel` is the simplest way to pin the OpenCode tunnel in the background.
- `codebox tunnel --repo <name>` lets you target a remembered repo from any working directory instead of implicitly using the current folder name.
- `codebox --resync` replays repo sync for remembered targets from `~/.config/codebox.json` (optionally filtered with `--repo <name>`).
- In `--resync` mode, sibling repos are discovered as `<cwd-parent>/<repo>`; missing local paths are skipped with a clear message.
- `codebox` now remembers synced/tunneled remote targets in `~/.config/codebox.json`, including VM hostname, repo, SSH opts, and the localhost OpenCode port mapping.
- `codebox tunnel --list` shows remembered targets with VM name, repo, localhost URL, remote port, and current status.
- `codebox tunnel --all` reconciles background OpenCode tunnels for every remembered target instead of only the most recent one.
- Syncs `.git` by default so the remote is a real git repo.
- Excludes `codex-rs/target*`, `node_modules`, `dist`, `.venv` by default.
- Supports repeatable `--exclude` flags for repo-local heavyweight directories that should stay local.
- Syncs env vars into a managed remote shell/OpenCode env file and wires remote `~/.bashrc` to source it (defaults include `GITHUB_TOKEN`, `OPENAI_*`, `AZURE_OPENAI_*`, `OPENCODE_*`, `CODEX_*`, and any `*_TOKEN`). Use `--no-env`, `--env`, `--env-prefix` to control.
- Prompts before syncing secrets or `~/.ssh` unless `--yes` is provided.
- Use `-v/--verbose` for rsync progress output.
- Sync mode now ensures OpenCode is running on remote (`127.0.0.1:4096`) and starts a background local SSH tunnel by default:
  - `localhost:4096 -> remote:127.0.0.1:4096`
  - disable with `--no-opencode-tunnel`
  - override ports with `--opencode-local-port <n>` and `--opencode-remote-port <n>`
  - when the preferred local port is already occupied, `codebox` automatically picks the next free localhost port and remembers it for that remote target
- The default OpenCode deployment source is the managed remote checkout of `https://github.com/dzianisv/opencode.git` at ref `dev`.
- Use `--opencode-ref <branch|sha>` to deploy another branch or commit from that fork.
- Use `--opencode-src <path>` only when you intentionally want a local checkout to override the managed remote checkout. If you do, its `origin` must still point at the same fork unless you intentionally override `--opencode-repo-url`.
- When the fork checkout exposes an `install:local` hook, `codebox` installs that build on the VM and prefers `~/.local/bin/opencode` before any downloaded `~/.opencode/bin/opencode` channel binary.
- Remote OpenCode startup defaults `OPENCODE_DISABLE_CHANNEL_DB=1` unless you override it, so switching between downloaded and repo-local builds keeps using the shared `opencode.db` state.
- When OpenCode config sync is enabled, `codebox` also syncs `~/.local/share/opencode/auth.json` so GitHub Copilot-backed remote sessions keep working.
- Remote OpenCode supervision defaults to `systemd`; use `--opencode-supervisor auto|nohup|systemd` to override:
  - `systemd` installs/refreshes `opencode-serve.service`, runs it from the remote OpenCode checkout, stops it before reinstalling `opencode`, and tries to enable user lingering
  - `auto` prefers `systemd --user` and falls back to `nohup`
  - `nohup` keeps the one-shot background behavior, but still starts from the remote OpenCode checkout so repo-built frontend assets are served

Install Jetify `devbox` CLI into your Bun local bin path:

```sh
bun run install:devbox
# optional
bun run install:devbox -- --dry-run
bun run install:devbox -- --version 0.17.0
```
