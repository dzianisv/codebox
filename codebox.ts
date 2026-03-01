#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

type Options = {
  remote: string;
  sshOpts: string;
  base: string;
  opencodeSrc?: string;
  syncGit: boolean;
  syncCodexConfig: boolean;
  syncOpencodeConfig: boolean;
  syncGhConfig: boolean;
  syncSshKeys: boolean;
  includeCodexHistory: boolean;
  syncEnv: boolean;
  envVars: Record<string, string>;
  assumeYes: boolean;
  verbose: boolean;
  dryRun: boolean;
  configPath: string;
};

function usage(): string {
  return `Usage:
  ./codebox.ts --remote <user@host> [options]

Options:
  --remote <user@host>        Required SSH target
  --ssh-opts <string>         SSH options (default: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes")
  --base <path>               Remote base dir (default: "$HOME/workspace")
  --opencode-src <path>       Local opencode repo path (default: ~/workspace/opencode if exists)
  --no-git                    Do NOT sync .git (default: sync .git)
  --no-codex-config           Skip syncing ~/.codex
  --no-opencode-config        Skip syncing ~/.config/opencode and ~/.opencode
  --no-gh-config              Skip syncing ~/.config/gh
  --sync-ssh                  Sync ~/.ssh (includes private keys) [off by default]
  --include-codex-history     Include ~/.codex/history.jsonl (default: excluded)
  --no-env                    Do NOT sync env vars to remote ~/.bashrc
  --env <NAME>                Also sync a specific env var (repeatable)
  --env-prefix <PREFIX>       Sync env vars with this prefix (repeatable)
  --yes                       Assume yes for prompts (env/ssh sync)
  -v, --verbose               Verbose rsync output (progress)
  --dry-run                   Print actions without executing

Example:
  ./codebox.ts --remote azureuser@dev-1 --base '$HOME/workspace'
`;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function argValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

function readConfig(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeConfig(path: string, data: Record<string, unknown>) {
  const dir = path.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function bashQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");
  return `$'${escaped}'`;
}

function collectEnvVars(args: string[]): Record<string, string> {
  const defaults = [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_ORG_ID",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_VERSION",
    "OPENCODE_API_KEY",
    "CODEX_API_KEY",
  ];
  const prefixes = [
    "OPENAI_",
    "AZURE_OPENAI_",
    "OPENCODE_",
    "CODEX_",
  ];
  const extraNames = argValues(args, "--env");
  const extraPrefixes = argValues(args, "--env-prefix");

  const allow = new Set<string>([...defaults, ...extraNames]);
  const allPrefixes = [...prefixes, ...extraPrefixes];

  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val == null || val === "") continue;
    if (allow.has(key)) {
      out[key] = val;
      continue;
    }
    if (allPrefixes.some((p) => key.startsWith(p))) {
      out[key] = val;
      continue;
    }
    if (key.endsWith("_TOKEN")) {
      out[key] = val;
    }
  }
  return out;
}

function validateRemote(remote: string) {
  if (/\s/.test(remote)) {
    throw new Error("Remote must not contain whitespace.");
  }
  if (remote.startsWith("-")) {
    throw new Error("Remote must not start with '-'.");
  }
}

function expandTildeArg(arg: string): string {
  if (arg.startsWith("~")) {
    return expandHome(arg);
  }
  if (arg.includes("=~")) {
    return arg.replace("=~", `=${os.homedir()}/`);
  }
  return arg;
}

function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | "\"" | null = null;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      if (ch === "\\" && quote === "\"") {
        const next = input[i + 1];
        if (next) {
          cur += next;
          i += 2;
          continue;
        }
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      cur += input[i + 1];
      i += 2;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (quote) {
    throw new Error("Unterminated quote in --ssh-opts.");
  }
  if (cur) out.push(cur);
  return out;
}

async function promptYes(message: string, assumeYes: boolean): Promise<void> {
  if (assumeYes) return;
  if (!process.stdin.isTTY) {
    throw new Error(`${message} Use --yes to proceed or disable the option.`);
  }
  process.stderr.write(`${message} Type 'yes' to continue: `);
  process.stdin.setEncoding("utf8");
  const input = await new Promise<string>((resolve) => {
    process.stdin.once("data", (data) => resolve(String(data)));
  });
  if (input.trim().toLowerCase() !== "yes") {
    throw new Error("Aborted.");
  }
}

async function run(cmd: string[], opts?: { cwd?: string; stdin?: Uint8Array }) {
  if (opts?.stdin) {
    const proc = Bun.spawn({
      cmd,
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
      cwd: opts?.cwd,
    });
    const writer = proc.stdin!.getWriter();
    await writer.write(opts.stdin);
    await writer.close();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Command failed (${code}): ${cmd.join(" ")}`);
    }
    return;
  }

  const proc = Bun.spawn({
    cmd,
    stdout: "inherit",
    stderr: "inherit",
    cwd: opts?.cwd,
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}`);
  }
}

function rsyncCmd(
  sshOpts: string,
  src: string,
  dest: string,
  excludes: string[] = [],
  verbose = false,
) {
  const cmd = [
    "rsync",
    "-az",
    "--delete",
    "--human-readable",
    "--stats",
  ];
  if (verbose) {
    cmd.push("-v", "--info=progress2");
  }
  cmd.push("-e", `ssh ${sshOpts}`);
  for (const ex of excludes) {
    cmd.push("--exclude", ex);
  }
  cmd.push(src, dest);
  return cmd;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(usage());
    process.exit(0);
  }

  const configPath =
    argValue(args, "--config") ??
    process.env.CODEBOX_CONFIG ??
    expandHome("~/.config/codebox.json");
  const existingConfig = readConfig(configPath);

  const remote =
    argValue(args, "--remote") ??
    process.env.REMOTE ??
    (typeof existingConfig.last_remote === "string" ? existingConfig.last_remote : undefined);
  if (!remote) {
    console.error("Missing --remote");
    console.log(usage());
    process.exit(2);
  }
  validateRemote(remote);

  const sshOpts =
    argValue(args, "--ssh-opts") ??
    process.env.SSH_OPTS ??
    "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes";

  const assumeYes = hasFlag(args, "--yes");
  const verbose = hasFlag(args, "--verbose") || hasFlag(args, "-v");

  const base = argValue(args, "--base") ?? process.env.BASE ?? "$HOME/workspace";
  const opencodeSrcArg = argValue(args, "--opencode-src") ?? process.env.OPENCODE_SRC;
  const opencodeSrcDefault = resolve(expandHome("~/workspace/opencode"));
  const opencodeSrc =
    opencodeSrcArg ?? (existsSync(opencodeSrcDefault) ? opencodeSrcDefault : undefined);

  const opts: Options = {
    remote,
    sshOpts,
    base,
    opencodeSrc,
    syncGit: !hasFlag(args, "--no-git"),
    syncCodexConfig: !hasFlag(args, "--no-codex-config"),
    syncOpencodeConfig: !hasFlag(args, "--no-opencode-config"),
    syncGhConfig: !hasFlag(args, "--no-gh-config"),
    syncSshKeys: hasFlag(args, "--sync-ssh"),
    includeCodexHistory: hasFlag(args, "--include-codex-history"),
    syncEnv: !hasFlag(args, "--no-env"),
    envVars: {},
    assumeYes,
    verbose,
    dryRun: hasFlag(args, "--dry-run"),
    configPath,
  };

  if (opts.syncSshKeys) {
    await promptYes(
      "About to sync ~/.ssh (includes private keys) to the remote.",
      opts.assumeYes,
    );
  }

  const repoRoot = resolve(process.cwd());
  const repoName = basename(repoRoot);
  const remoteRepo = `${opts.base}/${repoName}`;

  const repoExcludes = [
    "codex-rs/target*",
    "node_modules",
    "dist",
    ".venv",
  ];
  if (!opts.syncGit) {
    repoExcludes.unshift(".git");
  }

  const actions: Array<{ label: string; cmd: string[]; stdin?: string }> = [];

  actions.push({
    label: "sync repo",
    cmd: rsyncCmd(
      opts.sshOpts,
      `${repoRoot}/`,
      `${opts.remote}:${remoteRepo}/`,
      repoExcludes,
      opts.verbose,
    ),
  });

  if (opts.opencodeSrc && existsSync(opts.opencodeSrc)) {
    actions.push({
      label: "sync opencode repo",
      cmd: rsyncCmd(
        opts.sshOpts,
        `${opts.opencodeSrc}/`,
        `${opts.remote}:${opts.base}/opencode/`,
        [".git", "node_modules", "dist", ".venv"],
        opts.verbose,
      ),
    });
  }

  if (opts.syncCodexConfig) {
    const codexDir = resolve(os.homedir(), ".codex");
    if (existsSync(codexDir)) {
      const excludes = opts.includeCodexHistory ? [] : ["history.jsonl"];
      actions.push({
        label: "sync ~/.codex",
        cmd: rsyncCmd(
          opts.sshOpts,
          `${codexDir}/`,
          `${opts.remote}:~/.codex/`,
          excludes,
          opts.verbose,
        ),
      });
    }
  }

  if (opts.syncOpencodeConfig) {
    const opencodeConfig = resolve(os.homedir(), ".config/opencode");
    const opencodeHome = resolve(os.homedir(), ".opencode");
    if (existsSync(opencodeConfig)) {
      actions.push({
        label: "sync ~/.config/opencode",
        cmd: rsyncCmd(
          opts.sshOpts,
          `${opencodeConfig}/`,
          `${opts.remote}:~/.config/opencode/`,
          [],
          opts.verbose,
        ),
      });
    }
    if (existsSync(opencodeHome)) {
      actions.push({
        label: "sync ~/.opencode",
        cmd: rsyncCmd(
          opts.sshOpts,
          `${opencodeHome}/`,
          `${opts.remote}:~/.opencode/`,
          [],
          opts.verbose,
        ),
      });
    }
  }

  if (opts.syncGhConfig) {
    const ghConfig = resolve(os.homedir(), ".config/gh");
    if (existsSync(ghConfig)) {
      actions.push({
        label: "sync ~/.config/gh",
        cmd: rsyncCmd(
          opts.sshOpts,
          `${ghConfig}/`,
          `${opts.remote}:~/.config/gh/`,
          [],
          opts.verbose,
        ),
      });
    }
  }

  if (opts.syncSshKeys) {
    const sshDir = resolve(os.homedir(), ".ssh");
    if (existsSync(sshDir)) {
      actions.push({
        label: "sync ~/.ssh (includes private keys)",
        cmd: rsyncCmd(opts.sshOpts, `${sshDir}/`, `${opts.remote}:~/.ssh/`, [
          "authorized_keys",
        ], opts.verbose),
      });
    }
  }

  if (opts.syncEnv) {
    opts.envVars = collectEnvVars(args);
    const envKeys = Object.keys(opts.envVars).sort();
    if (envKeys.length > 0) {
      const shown = envKeys.slice(0, 10);
      const suffix = envKeys.length > 10 ? ` (+${envKeys.length - 10} more)` : "";
      await promptYes(
        `About to sync ${envKeys.length} env vars to remote ~/.bashrc: ${shown.join(", ")}${suffix}.`,
        opts.assumeYes,
      );
    }
  }

  const devboxCodexJson = `{
  "packages": ["git","rustc","cargo","pkg-config","openssl","libcap","gcc","bun"]
}\n`;
  const devboxOpencodeJson = `{
  "packages": ["git","bun"]
}\n`;

  const envLines = Object.entries(opts.envVars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `export ${k}=${bashQuote(v)}`);
  const envBlock = envLines.length
    ? `# >>> codebox env >>>\n${envLines.join("\n")}\n# <<< codebox env <<<\n`
    : "";
  const envDelimiter = `CODEBOX_ENV_${Math.random().toString(36).slice(2)}`;
  const envSetup = envBlock
    ? `BASHRC="$HOME/.bashrc"
TMP_BASHRC="$(mktemp)"
if [ -f "$BASHRC" ]; then
  awk 'BEGIN{skip=0}
    /# >>> codebox env >>>/ {skip=1}
    /# <<< codebox env <<</ {skip=0; next}
    !skip {print}' "$BASHRC" > "$TMP_BASHRC"
else
  : > "$TMP_BASHRC"
fi
cat >> "$TMP_BASHRC" <<'${envDelimiter}'
${envBlock}${envDelimiter}
mv "$TMP_BASHRC" "$BASHRC"

`
    : "";

  const remoteScript = `#!/usr/bin/env bash
set -euo pipefail

REMOTE_BASE=${bashQuote(opts.base)}
REPO_NAME=${bashQuote(repoName)}
REPO_DIR="$REMOTE_BASE/$REPO_NAME"
OPENCODE_DIR="$REMOTE_BASE/opencode"

${envSetup}if ! command -v devbox >/dev/null 2>&1; then
  curl -fsSL https://get.jetpack.io/devbox | bash -s -- -f
fi

mkdir -p "$REPO_DIR" "$OPENCODE_DIR" ~/.config/opencode ~/.opencode ~/.codex ~/.config/gh ~/.local/bin

cat > "$REPO_DIR/devbox.json" <<'EOF'
${devboxCodexJson}
EOF

cat > "$OPENCODE_DIR/devbox.json" <<'EOF'
${devboxOpencodeJson}
EOF

cd "$REPO_DIR"
devbox install
devbox run -- bash -lc "export RUSTFLAGS='-C linker=cc'; cargo build -p codex-cli"
ln -sf "$REPO_DIR/codex-rs/target/debug/codex" ~/.local/bin/codex

if [ -d "$OPENCODE_DIR" ]; then
  cd "$OPENCODE_DIR"
  devbox install
  if [ -x "./scripts/install-local.sh" ]; then
    devbox run -- bash -lc "./scripts/install-local.sh"
  fi
fi
`;

  if (opts.dryRun) {
    for (const a of actions) {
      console.log(`[dry-run] ${a.label}: ${a.cmd.join(" ")}`);
    }
    console.log("[dry-run] remote script:\n" + remoteScript);
    return;
  }

  writeConfig(opts.configPath, {
    ...existingConfig,
    last_remote: opts.remote,
    last_base: opts.base,
    last_repo: repoName,
    updated_at: new Date().toISOString(),
  });

  for (const a of actions) {
    await run(a.cmd);
  }

  const encoder = new TextEncoder();
  const sshArgs = shellSplit(opts.sshOpts).map(expandTildeArg);
  const sshCmd = ["ssh", ...sshArgs, opts.remote, "bash", "-s"];
  await run(sshCmd, { stdin: encoder.encode(remoteScript) });
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
