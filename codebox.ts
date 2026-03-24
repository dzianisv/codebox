#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

type Options = {
  remote: string;
  sshOpts: string;
  base: string;
  opencodeSrc?: string;
  opencodeTunnel: boolean;
  opencodeLocalPort: number;
  opencodeRemotePort: number;
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
  ./codebox.ts ssh [<user@host>] [options] [ssh-options] [-- <remote command...>]
  ./codebox.ts tunnel [<user@host>] [options]

Options:
  --remote <user@host>        SSH target (required for sync mode)
  --ssh-opts <string>         SSH options (default: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes")
  --base <path>               Remote base dir (default: "$HOME/workspace")
  --opencode-src <path>       Local opencode repo path (default: ~/workspace/opencode if exists)
  --no-opencode-tunnel        Skip auto-starting localhost SSH tunnel to remote OpenCode
  --opencode-local-port <n>   Local forwarded port (default: 5551)
  --opencode-remote-port <n>  Remote OpenCode port (default: 5551)
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

SSH mode:
  Unrecognized ssh-mode flags are passed through to ssh (for example: -L, -R, -D, -N, -p, -i).

Example:
  ./codebox.ts --remote azureuser@dev-1 --base '$HOME/workspace'
  ./codebox.ts ssh azureuser@dev-1
  ./codebox.ts ssh -L 4097:127.0.0.1:4097 -N
  ./codebox.ts tunnel
  ./codebox.ts tunnel azureuser@dev-1 --opencode-local-port 4097 --opencode-remote-port 4097
  ./codebox.ts ssh --remote azureuser@dev-1 -- git status -sb
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

  const skip = new Set<string>([
    "OPENCODE_PID",
    "OPENCODE_SESSION",
    "CODEX_PID",
  ]);

  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val == null || val === "") continue;
    if (skip.has(key)) continue;
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

function parsePort(raw: string | undefined, name: string, fallback: number): number {
  const text = (raw ?? `${fallback}`).trim();
  const value = Number.parseInt(text, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${name}: "${text}" (expected 1-65535)`);
  }
  return value;
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

function findPositionalRemote(args: string[]): string | undefined {
  const takesValue = new Set([
    "--remote",
    "--ssh-opts",
    "--base",
    "--opencode-src",
    "--opencode-local-port",
    "--opencode-remote-port",
    "--config",
    "--env",
    "--env-prefix",
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (takesValue.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

type ParsedSshModeArgs = {
  args: string[];
  positionalRemote?: string;
  sshPassthroughArgs: string[];
  sshExecArgs: string[];
};

function parseSshModeArgs(rawArgs: string[]): ParsedSshModeArgs {
  const commandSep = rawArgs.indexOf("--");
  const args = commandSep === -1 ? rawArgs : rawArgs.slice(0, commandSep);
  const explicitExecArgs = commandSep === -1 ? [] : rawArgs.slice(commandSep + 1);

  const takesValue = new Set([
    "--remote",
    "--ssh-opts",
    "--base",
    "--opencode-src",
    "--opencode-local-port",
    "--opencode-remote-port",
    "--config",
    "--env",
    "--env-prefix",
  ]);
  const boolFlags = new Set([
    "--no-opencode-tunnel",
    "--no-git",
    "--no-codex-config",
    "--no-opencode-config",
    "--no-gh-config",
    "--sync-ssh",
    "--include-codex-history",
    "--no-env",
    "--yes",
    "--verbose",
    "-v",
    "--dry-run",
  ]);
  const sshFlagsWithValue = new Set([
    "-B",
    "-b",
    "-c",
    "-D",
    "-E",
    "-F",
    "-I",
    "-i",
    "-J",
    "-L",
    "-l",
    "-m",
    "-O",
    "-o",
    "-p",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
  ]);

  const sshPassthroughArgs: string[] = [];
  const implicitExecArgs: string[] = [];
  let positionalRemote: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (takesValue.has(arg)) {
      i += 1;
      continue;
    }
    if (boolFlags.has(arg)) {
      continue;
    }
    if (arg.startsWith("--")) {
      sshPassthroughArgs.push(arg);
      continue;
    }
    if (arg.startsWith("-")) {
      sshPassthroughArgs.push(arg);
      if (sshFlagsWithValue.has(arg) && args[i + 1]) {
        sshPassthroughArgs.push(args[i + 1]);
        i += 1;
      }
      continue;
    }

    if (!positionalRemote) {
      positionalRemote = arg;
      continue;
    }
    implicitExecArgs.push(arg);
  }

  const sshExecArgs = explicitExecArgs.length > 0 ? explicitExecArgs : implicitExecArgs;
  return { args, positionalRemote, sshPassthroughArgs, sshExecArgs };
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
    const stdin = proc.stdin as unknown as {
      write?: (chunk: Uint8Array) => unknown;
      end?: () => unknown;
      getWriter?: () => WritableStreamDefaultWriter<Uint8Array>;
    };
    if (stdin && typeof stdin.write === "function") {
      stdin.write(opts.stdin);
      if (typeof stdin.end === "function") {
        stdin.end();
      }
    } else if (stdin && typeof stdin.getWriter === "function") {
      const writer = stdin.getWriter();
      await writer.write(opts.stdin);
      await writer.close();
    } else {
      throw new Error(`Unable to pipe stdin for command: ${cmd.join(" ")}`);
    }
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

async function runCapture(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function listListeningPids(port: number): Promise<number[]> {
  const result = await runCapture([
    "lsof",
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  if (result.code !== 0) return [];
  return result.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function describePid(pid: number): Promise<string> {
  const result = await runCapture(["ps", "-p", `${pid}`, "-o", "command="]);
  const command = result.stdout.trim();
  if (!command) return `pid=${pid}`;
  return `pid=${pid} cmd=${command}`;
}

async function getPortUsageSummary(port: number): Promise<string | null> {
  const pids = await listListeningPids(port);
  if (pids.length === 0) return null;
  const details: string[] = [];
  for (const pid of pids) {
    details.push(await describePid(pid));
  }
  return details.join(" | ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTunnelCommand(params: {
  remote: string;
  sshOpts: string;
  localPort: number;
  remotePort: number;
}): string[] {
  const sshArgs = shellSplit(params.sshOpts).map(expandTildeArg);
  return [
    "ssh",
    ...sshArgs,
    "-f",
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `${params.localPort}:127.0.0.1:${params.remotePort}`,
    params.remote,
  ];
}

async function ensureBackgroundTunnel(params: {
  remote: string;
  sshOpts: string;
  localPort: number;
  remotePort: number;
}): Promise<void> {
  const pids = await listListeningPids(params.localPort);
  if (pids.length > 0) {
    let hasExpectedTunnel = false;
    for (const pid of pids) {
      const desc = await describePid(pid);
      const isSshProcess = /\bssh\b/.test(desc);
      if (
        isSshProcess &&
        desc.includes(params.remote) &&
        desc.includes(`${params.localPort}:127.0.0.1:${params.remotePort}`)
      ) {
        hasExpectedTunnel = true;
        break;
      }
    }
    if (hasExpectedTunnel) {
      console.log(
        `[codebox] Reusing existing OpenCode tunnel on localhost:${params.localPort}`,
      );
      return;
    }
    const usage = await getPortUsageSummary(params.localPort);
    throw new Error(
      `Cannot start OpenCode tunnel: localhost:${params.localPort} is already in use (${usage ?? "unknown process"}).`,
    );
  }

  await run(buildTunnelCommand(params));

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const usage = await getPortUsageSummary(params.localPort);
    if (usage) return;
    await sleep(200);
  }

  throw new Error(
    `SSH tunnel command returned but localhost:${params.localPort} is not listening.`,
  );
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
    cmd.push("-v", "--progress");
  }
  cmd.push("-e", `ssh ${sshOpts}`);
  for (const ex of excludes) {
    cmd.push("--exclude", ex);
  }
  cmd.push(src, dest);
  return cmd;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const mode = rawArgs[0] === "ssh" ? "ssh" : rawArgs[0] === "tunnel" ? "tunnel" : "sync";
  let args = (mode === "ssh" || mode === "tunnel") ? rawArgs.slice(1) : rawArgs;
  let sshExecArgs: string[] = [];
  let sshPassthroughArgs: string[] = [];
  let positionalRemote: string | undefined = findPositionalRemote(args);
  if (mode === "ssh") {
    const parsedSshArgs = parseSshModeArgs(args);
    args = parsedSshArgs.args;
    sshExecArgs = parsedSshArgs.sshExecArgs;
    sshPassthroughArgs = parsedSshArgs.sshPassthroughArgs;
    positionalRemote = parsedSshArgs.positionalRemote;
  }

  if (args.includes("-h") || args.includes("--help")) {
    console.log(usage());
    process.exit(0);
  }

  const configPath =
    argValue(args, "--config") ??
    process.env.CODEBOX_CONFIG ??
    expandHome("~/.config/codebox.json");
  const existingConfig = readConfig(configPath);

  if (mode === "sync") {
    positionalRemote = undefined;
  }
  const remote =
    argValue(args, "--remote") ??
    positionalRemote ??
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

  const base =
    argValue(args, "--base") ??
    process.env.BASE ??
    (typeof existingConfig.last_base === "string" ? existingConfig.last_base : undefined) ??
    "$HOME/workspace";
  const opencodeSrcArg = argValue(args, "--opencode-src") ?? process.env.OPENCODE_SRC;
  const opencodeSrcDefault = resolve(expandHome("~/workspace/opencode"));
  const opencodeSrc =
    opencodeSrcArg ?? (existsSync(opencodeSrcDefault) ? opencodeSrcDefault : undefined);
  const opencodeLocalPort = parsePort(
    argValue(args, "--opencode-local-port") ?? process.env.OPENCODE_LOCAL_PORT,
    "--opencode-local-port",
    5551,
  );
  const opencodeRemotePort = parsePort(
    argValue(args, "--opencode-remote-port") ?? process.env.OPENCODE_REMOTE_PORT,
    "--opencode-remote-port",
    5551,
  );

  const opts: Options = {
    remote,
    sshOpts,
    base,
    opencodeSrc,
    opencodeTunnel: !hasFlag(args, "--no-opencode-tunnel"),
    opencodeLocalPort,
    opencodeRemotePort,
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

  if (mode === "ssh") {
    const remoteTarget = `${opts.base}/${repoName}`;
    const remoteCd = `if [ -d ${remoteTarget} ]; then cd ${remoteTarget}; fi`;
    const remoteCommand =
      sshExecArgs.length > 0
        ? `${remoteCd}; exec ${sshExecArgs.map((part) => bashQuote(part)).join(" ")}`
        : `${remoteCd}; exec bash -l`;
    const sshArgs = [
      ...shellSplit(opts.sshOpts).map(expandTildeArg),
      ...sshPassthroughArgs.map(expandTildeArg),
    ];
    const disableRemoteCommand = sshArgs.includes("-N");
    const disableTty = sshArgs.includes("-T");
    if (disableRemoteCommand && sshExecArgs.length > 0) {
      throw new Error("Cannot combine -N with a remote command.");
    }
    const remoteInvocation = `bash -lc ${bashQuote(remoteCommand)}`;
    const sshCmd = ["ssh", ...sshArgs];
    if (disableRemoteCommand) {
      sshCmd.push(opts.remote);
    } else {
      if (sshExecArgs.length === 0 && !disableTty) {
        sshCmd.push("-t");
      }
      sshCmd.push(opts.remote, remoteInvocation);
    }

    if (opts.dryRun) {
      console.log(`[dry-run] ${sshCmd.join(" ")}`);
      return;
    }

    writeConfig(opts.configPath, {
      ...existingConfig,
      last_remote: opts.remote,
      last_base: opts.base,
      last_repo: repoName,
      updated_at: new Date().toISOString(),
    });
    await run(sshCmd);
    return;
  }

  if (mode === "tunnel") {
    const tunnelCmd = buildTunnelCommand({
      remote: opts.remote,
      sshOpts: opts.sshOpts,
      localPort: opts.opencodeLocalPort,
      remotePort: opts.opencodeRemotePort,
    });
    if (opts.dryRun) {
      console.log(`[dry-run] ${tunnelCmd.join(" ")}`);
      return;
    }

    writeConfig(opts.configPath, {
      ...existingConfig,
      last_remote: opts.remote,
      last_base: opts.base,
      last_repo: repoName,
      updated_at: new Date().toISOString(),
    });

    await ensureBackgroundTunnel({
      remote: opts.remote,
      sshOpts: opts.sshOpts,
      localPort: opts.opencodeLocalPort,
      remotePort: opts.opencodeRemotePort,
    });
    console.log(
      `[codebox] Tunnel ready: http://127.0.0.1:${opts.opencodeLocalPort} -> ${opts.remote}:127.0.0.1:${opts.opencodeRemotePort}`,
    );
    return;
  }

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

BASE_INPUT=${bashQuote(opts.base)}
case "$BASE_INPUT" in
  '$HOME') REMOTE_BASE="$HOME" ;;
  '$HOME'/*) REMOTE_BASE="$HOME/\${BASE_INPUT:6}" ;;
  "~") REMOTE_BASE="$HOME" ;;
  "~/"*) REMOTE_BASE="$HOME/\${BASE_INPUT#~/}" ;;
  *) REMOTE_BASE="$BASE_INPUT" ;;
esac
REPO_NAME=${bashQuote(repoName)}
REPO_DIR="$REMOTE_BASE/$REPO_NAME"
OPENCODE_DIR="$REMOTE_BASE/opencode"
OPENCODE_PORT=${bashQuote(String(opts.opencodeRemotePort))}

is_port_listening() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$1 )" 2>/dev/null | grep -q LISTEN
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1$"
    return $?
  fi
  return 1
}

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
if [ -f "$REPO_DIR/codex-rs/Cargo.toml" ]; then
  devbox run -- bash -lc "export RUSTFLAGS='-C linker=cc'; cargo build -p codex-cli --manifest-path codex-rs/Cargo.toml"
  ln -sf "$REPO_DIR/codex-rs/target/debug/codex" ~/.local/bin/codex
else
  echo "Info: skipping codex-cli build; codex-rs/Cargo.toml not found in $REPO_DIR"
fi

if [ -d "$OPENCODE_DIR" ]; then
  cd "$OPENCODE_DIR"
  devbox install
  if [ -x "./scripts/install-local.sh" ]; then
    if grep -qE '^(<<<<<<< |=======|>>>>>>> )' ./scripts/install-local.sh; then
      echo "Warning: skipping ./scripts/install-local.sh due to merge-conflict markers."
    else
      if ! devbox run -- bash -lc "./scripts/install-local.sh"; then
        echo "Warning: ./scripts/install-local.sh failed; continuing bootstrap."
      fi
    fi
  fi
fi

if command -v opencode >/dev/null 2>&1; then
  if is_port_listening "$OPENCODE_PORT"; then
    echo "Info: OpenCode already listening on 127.0.0.1:$OPENCODE_PORT"
  else
    mkdir -p "$HOME/.cache/codebox"
    nohup opencode serve --hostname 127.0.0.1 --port "$OPENCODE_PORT" \
      > "$HOME/.cache/codebox/opencode-serve.log" 2>&1 &
    echo "Info: started OpenCode serve on 127.0.0.1:$OPENCODE_PORT (log: ~/.cache/codebox/opencode-serve.log)"
  fi

  for _ in $(seq 1 25); do
    if is_port_listening "$OPENCODE_PORT"; then
      break
    fi
    sleep 1
  done

  if ! is_port_listening "$OPENCODE_PORT"; then
    echo "Warning: OpenCode did not become ready on port $OPENCODE_PORT"
  fi
else
  echo "Warning: opencode CLI not found on remote; skipping OpenCode serve startup."
fi
`;

  if (opts.dryRun) {
    for (const a of actions) {
      console.log(`[dry-run] ${a.label}: ${a.cmd.join(" ")}`);
    }
    console.log("[dry-run] remote script:\n" + remoteScript);
    if (opts.opencodeTunnel) {
      const tunnelCmd = buildTunnelCommand({
        remote: opts.remote,
        sshOpts: opts.sshOpts,
        localPort: opts.opencodeLocalPort,
        remotePort: opts.opencodeRemotePort,
      });
      console.log(`[dry-run] start OpenCode tunnel: ${tunnelCmd.join(" ")}`);
    }
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

  if (opts.opencodeTunnel) {
    await ensureBackgroundTunnel({
      remote: opts.remote,
      sshOpts: opts.sshOpts,
      localPort: opts.opencodeLocalPort,
      remotePort: opts.opencodeRemotePort,
    });
    console.log(
      `[codebox] OpenCode tunnel ready: http://127.0.0.1:${opts.opencodeLocalPort} -> ${opts.remote}:127.0.0.1:${opts.opencodeRemotePort}`,
    );
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
