#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";

type OpencodeSupervisor = "auto" | "nohup" | "systemd";
const DEFAULT_BASE = "$HOME/workspace";
const DEFAULT_OPENCODE_REPO_URL = "https://github.com/dzianisv/opencode.git";
const DEFAULT_PAPERCLIP_REPO_URL = "https://github.com/dzianisv/paperclip.git";
const DEFAULT_OPENCODE_REF = "dev";
const DEFAULT_OPENCODE_SUPERVISOR: OpencodeSupervisor = "systemd";

type Options = {
  remote: string;
  sshOpts: string;
  base: string;
  opencodeSrc?: string;
  opencodeRepoUrl: string;
  opencodeRef: string;
  repoExcludes: string[];
  opencodeTunnel: boolean;
  opencodeLocalPort: number;
  opencodeRemotePort: number;
  opencodeSupervisor: OpencodeSupervisor;
  syncRepo: boolean;
  syncGit: boolean;
  syncCodexConfig: boolean;
  syncOpencodeConfig: boolean;
  syncOpencodeAuth: boolean;
  syncGhConfig: boolean;
  syncCopilotConfig: boolean;
  syncKubeConfig: boolean;
  syncSshKeys: boolean;
  includeCodexHistory: boolean;
  syncEnv: boolean;
  envVars: Record<string, string>;
  reinstallOpencode: boolean;
  disableTailscale: boolean;
  assumeYes: boolean;
  verbose: boolean;
  dryRun: boolean;
  configPath: string;
  syncPaperclip: boolean;
  paperclipRepoUrl: string;
  chromeCdpPort: number;
  setupChromeCdp: boolean;
};

type CodeboxConfig = Record<string, unknown>;

type KnownTarget = {
  remote: string;
  remoteHost?: string;
  tailscaleIp?: string;
  publicIp?: string;
  sshOpts?: string;
  base: string;
  repo: string;
  remoteRepo: string;
  opencodeLocalPort: number;
  opencodeRemotePort: number;
  lastSyncedAt?: string;
  lastTunneledAt?: string;
  updatedAt?: string;
};

type TunnelPortInspection =
  | { state: "free" }
  | { state: "expected" }
  | { state: "occupied"; usage?: string };

type KnownTargetSelector = {
  repo?: string;
  remote?: string;
  base?: string;
};

function usage(): string {
  return `Usage:
  ./codebox.ts [--remote <user@host>] [options]
  ./codebox.ts ssh [<user@host>] [options] [ssh-options] [-- <remote command...>]
  ./codebox.ts list [--repo <name>]                List all remembered VM targets
  ./codebox.ts tunnel [<user@host>] [options]

Options:
  --remote <user@host>        SSH target (default: recent remembered target)
  --ssh-opts <string>         SSH options (default: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes")
  --base <path>               Remote base dir (default: "${DEFAULT_BASE}")
  --repo <name>               Tunnel/list/resync filter: remembered repo to target
  --resync                    Sync mode only: re-sync all remembered targets (optionally filtered by --repo)
  --opencode-src <path>       Optional local opencode repo path to sync instead of managed remote checkout
  --opencode-repo-url <url>   OpenCode git remote to anchor on the target (default: "${DEFAULT_OPENCODE_REPO_URL}")
  --opencode-ref <branch|sha> OpenCode branch or commit for the managed remote checkout (default: "${DEFAULT_OPENCODE_REF}")
  --exclude <pattern>         Extra repo rsync exclude pattern (repeatable)
  --no-opencode-tunnel        Skip auto-starting localhost SSH tunnel to remote OpenCode
  --disable-tailscale         Skip Tailscale setup; OpenCode serves on 127.0.0.1 only
  --opencode-local-port <n>   Local forwarded port (default: 4096)
  --opencode-remote-port <n>  Remote OpenCode port (default: 4096)
  --opencode-supervisor <m>   Remote OpenCode supervisor: auto|nohup|systemd (default: ${DEFAULT_OPENCODE_SUPERVISOR})
  --list                      Tunnel mode only: show remembered tunnel targets
  --all                       Tunnel mode only: start/reconcile all remembered tunnel targets
  --no-git                    Do NOT sync .git (default: sync .git)
  --no-repo                   Skip syncing the workspace repo entirely
  --no-codex-config           Skip syncing ~/.codex
  --no-opencode-config        Skip syncing ~/.config/opencode and ~/.opencode
  --no-opencode-auth          Skip syncing ~/.local/share/opencode auth state
  --no-gh-config              Skip syncing ~/.config/gh
  --no-copilot-config         Skip syncing ~/.config/github-copilot
  --no-kube-config            Skip syncing ~/.kube
  --sync-ssh                  Sync ~/.ssh (includes private keys) [off by default]
  --include-codex-history     Include ~/.codex/history.jsonl (default: excluded)
  --no-paperclip              Skip syncing ~/workspace/paperclip to the remote
  --paperclip-repo-url <url>  Paperclip git remote to clone on the target (default: "${DEFAULT_PAPERCLIP_REPO_URL}")
  --chrome-cdp-port <port>    CDP port for headless Chrome (default: 9222)
  --no-chrome-cdp             Skip Chrome CDP service setup
  --no-env                    Do NOT sync env vars to the remote shell/OpenCode env
  --env <NAME>                Also sync a specific env var (repeatable)
  --env-prefix <PREFIX>       Sync env vars with this prefix (repeatable)
  --reinstall-opencode        Force reinstall of OpenCode on the remote (stops service, re-runs install hooks)
  --yes                       Assume yes for prompts (env/ssh sync)
  -v, --verbose               Verbose rsync output (progress)
  --dry-run                   Print actions without executing

SSH mode:
  Unrecognized ssh-mode flags are passed through to ssh (for example: -L, -R, -D, -N, -p, -i).

Example:
  ./codebox.ts --remote azureuser@dev-1
  ./codebox.ts --remote azureuser@dev-1 --opencode-ref dev
  ./codebox.ts ssh azureuser@dev-1
  ./codebox.ts ssh
  ./codebox.ts ssh -L 4097:127.0.0.1:4097 -N
  ./codebox.ts tunnel
  ./codebox.ts tunnel azureuser@dev-1 --opencode-local-port 4097 --opencode-remote-port 4097
  ./codebox.ts tunnel --repo termux-app
  ./codebox.ts tunnel --list
  ./codebox.ts tunnel --all
  ./codebox.ts --resync
  ./codebox.ts --resync --repo termux-app --dry-run
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

function parseNonEmptyOption(
  value: string | undefined,
  name: string,
  fallback: string,
): string {
  const resolved = (value ?? fallback).trim();
  if (!resolved) {
    throw new Error(`${name} cannot be empty.`);
  }
  return resolved;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownTargetKey(remote: string, base: string, repo: string): string {
  return `${remote}::${base}::${repo}`;
}

function parseKnownTarget(value: unknown): KnownTarget | undefined {
  if (!isRecord(value)) return undefined;
  const remote = typeof value.remote === "string" ? value.remote : undefined;
  const base = typeof value.base === "string" ? value.base : undefined;
  const repo = typeof value.repo === "string" ? value.repo : undefined;
  const remoteRepo =
    typeof value.remoteRepo === "string" ? value.remoteRepo : undefined;
  const opencodeLocalPort =
    typeof value.opencodeLocalPort === "number" ? value.opencodeLocalPort : undefined;
  const opencodeRemotePort =
    typeof value.opencodeRemotePort === "number" ? value.opencodeRemotePort : undefined;

  if (
    !remote ||
    !base ||
    !repo ||
    !remoteRepo ||
    !Number.isInteger(opencodeLocalPort) ||
    !Number.isInteger(opencodeRemotePort)
  ) {
    return undefined;
  }

  return {
    remote,
    remoteHost: typeof value.remoteHost === "string" ? value.remoteHost : undefined,
    tailscaleIp: typeof value.tailscaleIp === "string" ? value.tailscaleIp : undefined,
    publicIp: typeof value.publicIp === "string" ? value.publicIp : undefined,
    sshOpts: typeof value.sshOpts === "string" ? value.sshOpts : undefined,
    base,
    repo,
    remoteRepo,
    opencodeLocalPort,
    opencodeRemotePort,
    lastSyncedAt:
      typeof value.lastSyncedAt === "string" ? value.lastSyncedAt : undefined,
    lastTunneledAt:
      typeof value.lastTunneledAt === "string" ? value.lastTunneledAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

function getKnownTargetMap(config: CodeboxConfig): Record<string, KnownTarget> {
  const raw = isRecord(config.known_targets) ? config.known_targets : {};
  const known: Record<string, KnownTarget> = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parseKnownTarget(value);
    if (parsed) {
      known[key] = parsed;
    }
  }
  return known;
}

function getKnownTargetEntries(config: CodeboxConfig): Array<[string, KnownTarget]> {
  return Object.entries(getKnownTargetMap(config));
}

function findKnownTarget(
  config: CodeboxConfig,
  remote: string,
  base: string,
  repo: string,
): { key: string; target: KnownTarget } | undefined {
  const key = knownTargetKey(remote, base, repo);
  const target = getKnownTargetMap(config)[key];
  return target ? { key, target } : undefined;
}

function selectKnownTargets(
  config: CodeboxConfig,
  selector: KnownTargetSelector,
): KnownTarget[] {
  return getKnownTargetEntries(config)
    .map(([, target]) => target)
    .filter((target) => {
      if (selector.repo && target.repo !== selector.repo) return false;
      if (selector.remote && target.remote !== selector.remote) return false;
      if (selector.base && target.base !== selector.base) return false;
      return true;
    })
    .sort((left, right) => {
      const a = knownTargetActivityStamp(left);
      const b = knownTargetActivityStamp(right);
      return b.localeCompare(a);
    });
}

function knownTargetActivityStamp(target: KnownTarget): string {
  return target.updatedAt ?? target.lastTunneledAt ?? target.lastSyncedAt ?? "";
}

function collapseKnownTargetsByRemote(targets: KnownTarget[]): KnownTarget[] {
  const seen = new Set<string>();
  const collapsed: KnownTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.remote)) continue;
    seen.add(target.remote);
    collapsed.push(target);
  }
  return collapsed;
}

function formatKnownTargetChoice(target: KnownTarget): string {
  const vmName = target.remoteHost ?? target.remote;
  const parts = [
    `vm=${vmName}`,
    `remote=${target.remote}`,
    `repo=${target.repo}`,
    `base=${target.base}`,
  ];
  const lastUsed = knownTargetActivityStamp(target);
  if (lastUsed) {
    parts.push(`last_used=${lastUsed}`);
  }
  return parts.join(" ");
}

async function promptLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  process.stdin.setEncoding("utf8");
  return await new Promise<string>((resolve) => {
    process.stdin.once("data", (data) => resolve(String(data)));
  });
}

async function chooseKnownTarget(
  promptMessage: string,
  targets: KnownTarget[],
): Promise<KnownTarget | undefined> {
  if (targets.length === 0) return undefined;
  if (targets.length === 1 || !process.stdin.isTTY) {
    return targets[0];
  }

  process.stderr.write(`${promptMessage}\n`);
  targets.forEach((target, index) => {
    process.stderr.write(`  ${index + 1}. ${formatKnownTargetChoice(target)}\n`);
  });

  while (true) {
    const input = (await promptLine(`Select target [1-${targets.length}] (default 1): `)).trim();
    if (input === "") return targets[0];
    if (/^\d+$/.test(input)) {
      const selected = Number.parseInt(input, 10);
      if (selected >= 1 && selected <= targets.length) {
        return targets[selected - 1];
      }
    }
    process.stderr.write(`Invalid selection: ${input || "(empty)"}\n`);
  }
}

async function resolveRememberedTarget(params: {
  config: CodeboxConfig;
  repo: string;
  remote?: string;
  base?: string;
  requireRepoMatch?: boolean;
}): Promise<KnownTarget | undefined> {
  const repoTargets = selectKnownTargets(params.config, {
    repo: params.repo,
    remote: params.remote,
    base: params.base,
  });

  if (params.requireRepoMatch) {
    return await chooseKnownTarget(
      `Select remembered target for repo "${params.repo}":`,
      repoTargets,
    );
  }

  if (params.remote) {
    return repoTargets[0];
  }

  const repoMatch = await chooseKnownTarget(
    `Select recent target for repo "${params.repo}":`,
    repoTargets,
  );
  if (repoMatch) return repoMatch;

  const recentRemoteTargets = collapseKnownTargetsByRemote(
    selectKnownTargets(params.config, { base: params.base }),
  );
  return await chooseKnownTarget("Select recent remote target:", recentRemoteTargets);
}

function canShareTunnel(a: KnownTarget, b: Pick<KnownTarget, "remote" | "opencodeRemotePort">): boolean {
  return a.remote === b.remote && a.opencodeRemotePort === b.opencodeRemotePort;
}

function findSharedTunnelTarget(
  config: CodeboxConfig,
  needle: Pick<KnownTarget, "remote" | "opencodeRemotePort">,
): KnownTarget | undefined {
  const entries = getKnownTargetEntries(config)
    .map(([, target]) => target)
    .filter((target) => canShareTunnel(target, needle))
    .sort((left, right) => {
      const a = left.lastTunneledAt ?? left.updatedAt ?? left.lastSyncedAt ?? "";
      const b = right.lastTunneledAt ?? right.updatedAt ?? right.lastSyncedAt ?? "";
      return b.localeCompare(a);
    });
  return entries[0];
}

function isReservedByOtherTarget(
  config: CodeboxConfig,
  port: number,
  current: Pick<KnownTarget, "remote" | "base" | "repo" | "opencodeRemotePort">,
): boolean {
  const currentKey = knownTargetKey(current.remote, current.base, current.repo);
  for (const [key, target] of getKnownTargetEntries(config)) {
    if (key === currentKey) continue;
    if (target.opencodeLocalPort !== port) continue;
    if (canShareTunnel(target, current)) continue;
    return true;
  }
  return false;
}

function choosePreferredTunnelLocalPort(params: {
  config: CodeboxConfig;
  remote: string;
  base: string;
  repo: string;
  remotePort: number;
  explicitLocalPort?: number;
  fallbackLocalPort: number;
}): number {
  if (params.explicitLocalPort != null) {
    return params.explicitLocalPort;
  }

  const current = findKnownTarget(params.config, params.remote, params.base, params.repo);
  if (current) {
    return current.target.opencodeLocalPort;
  }

  const shared = findSharedTunnelTarget(params.config, {
    remote: params.remote,
    opencodeRemotePort: params.remotePort,
  });
  if (shared) {
    return shared.opencodeLocalPort;
  }

  let candidate = params.fallbackLocalPort;
  while (
    isReservedByOtherTarget(params.config, candidate, {
      remote: params.remote,
      base: params.base,
      repo: params.repo,
      opencodeRemotePort: params.remotePort,
    })
  ) {
    candidate += 1;
  }
  return candidate;
}

function upsertKnownTarget(
  config: CodeboxConfig,
  target: KnownTarget,
  updatedAt: string,
): CodeboxConfig {
  const knownTargets = getKnownTargetMap(config);
  const key = knownTargetKey(target.remote, target.base, target.repo);
  knownTargets[key] = {
    ...knownTargets[key],
    ...target,
    updatedAt,
  };
  return {
    ...config,
    last_remote: target.remote,
    last_base: target.base,
    last_repo: target.repo,
    updated_at: updatedAt,
    known_targets: knownTargets,
  };
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

function parseOpencodeSupervisor(raw: string | undefined): OpencodeSupervisor {
  const text = (raw ?? DEFAULT_OPENCODE_SUPERVISOR).trim().toLowerCase();
  if (text === "" || text === DEFAULT_OPENCODE_SUPERVISOR) {
    return DEFAULT_OPENCODE_SUPERVISOR;
  }
  if (text === "auto") return "auto";
  if (text === "nohup") return "nohup";
  if (text === "systemd") return "systemd";
  throw new Error(
    `Invalid --opencode-supervisor: "${raw ?? ""}" (expected auto, nohup, or systemd)`,
  );
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
    "--repo",
    "--opencode-src",
    "--opencode-repo-url",
    "--opencode-ref",
    "--opencode-local-port",
    "--opencode-remote-port",
    "--opencode-supervisor",
    "--paperclip-repo-url",
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
    "--repo",
    "--opencode-src",
    "--opencode-repo-url",
    "--opencode-ref",
    "--opencode-local-port",
    "--opencode-remote-port",
    "--opencode-supervisor",
    "--paperclip-repo-url",
    "--config",
    "--env",
    "--env-prefix",
  ]);
  const boolFlags = new Set([
    "--no-opencode-tunnel",
    "--no-git",
    "--no-repo",
    "--no-codex-config",
    "--no-opencode-config",
    "--no-opencode-auth",
    "--no-gh-config",
    "--sync-ssh",
    "--include-codex-history",
    "--no-env",
    "--yes",
    "--verbose",
    "-v",
    "--dry-run",
    "--reinstall-opencode",
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
  const input = await promptLine(`${message} Type 'yes' to continue: `);
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

function canonicalGitRemoteUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (trimmed.startsWith("git@github.com:")) {
    return trimmed.slice("git@github.com:".length).toLowerCase();
  }
  if (trimmed.startsWith("ssh://git@github.com/")) {
    return trimmed.slice("ssh://git@github.com/".length).toLowerCase();
  }
  if (trimmed.startsWith("https://github.com/")) {
    return trimmed.slice("https://github.com/".length).toLowerCase();
  }
  return trimmed.toLowerCase();
}

async function readGitRemoteUrl(repoDir: string, remoteName: string): Promise<string | undefined> {
  const result = await runCapture(["git", "-C", repoDir, "remote", "get-url", remoteName]);
  if (result.code !== 0) return undefined;
  const url = result.stdout.trim();
  return url === "" ? undefined : url;
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

async function inspectTunnelPort(params: {
  remote: string;
  localPort: number;
  remotePort: number;
}): Promise<TunnelPortInspection> {
  const pids = await listListeningPids(params.localPort);
  if (pids.length === 0) {
    return { state: "free" };
  }

  for (const pid of pids) {
    const desc = await describePid(pid);
    const isSshProcess = /\bssh\b/.test(desc);
    if (
      isSshProcess &&
      desc.includes(params.remote) &&
      desc.includes(`${params.localPort}:127.0.0.1:${params.remotePort}`)
    ) {
      return { state: "expected" };
    }
  }

  return {
    state: "occupied",
    usage: (await getPortUsageSummary(params.localPort)) ?? undefined,
  };
}

async function resolveTunnelLocalPort(params: {
  config: CodeboxConfig;
  remote: string;
  base: string;
  repo: string;
  localPort: number;
  localPortExplicit: boolean;
  remotePort: number;
}): Promise<number> {
  let candidate = params.localPort;
  for (; candidate <= 65535; candidate += 1) {
    const inspection = await inspectTunnelPort({
      remote: params.remote,
      localPort: candidate,
      remotePort: params.remotePort,
    });
    if (inspection.state === "expected") {
      return candidate;
    }
    if (inspection.state === "occupied") {
      if (params.localPortExplicit) {
        throw new Error(
          `Cannot start OpenCode tunnel: localhost:${candidate} is already in use (${inspection.usage ?? "unknown process"}).`,
        );
      }
      continue;
    }
    if (
      !isReservedByOtherTarget(params.config, candidate, {
        remote: params.remote,
        base: params.base,
        repo: params.repo,
        opencodeRemotePort: params.remotePort,
      })
    ) {
      return candidate;
    }
  }
  throw new Error("Unable to find a free localhost port for the OpenCode tunnel.");
}

async function ensureBackgroundTunnel(params: {
  remote: string;
  sshOpts: string;
  localPort: number;
  remotePort: number;
}): Promise<"reused" | "started"> {
  const inspection = await inspectTunnelPort({
    remote: params.remote,
    localPort: params.localPort,
    remotePort: params.remotePort,
  });
  if (inspection.state === "expected") {
    console.log(
      `[codebox] Reusing existing OpenCode tunnel on localhost:${params.localPort}`,
    );
    return "reused";
  }
  if (inspection.state === "occupied") {
    throw new Error(
      `Cannot start OpenCode tunnel: localhost:${params.localPort} is already in use (${inspection.usage ?? "unknown process"}).`,
    );
  }

  await run(buildTunnelCommand(params));

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const usage = await getPortUsageSummary(params.localPort);
    if (usage) return "started";
    await sleep(200);
  }

  throw new Error(
    `SSH tunnel command returned but localhost:${params.localPort} is not listening.`,
  );
}

async function readRemoteHostname(
  remote: string,
  sshOpts: string,
): Promise<string | undefined> {
  const sshArgs = shellSplit(sshOpts).map(expandTildeArg);
  const result = await runCapture(["ssh", ...sshArgs, remote, "hostname"]);
  if (result.code !== 0) return undefined;
  const hostname = result.stdout.trim().split(/\s+/)[0];
  return hostname || undefined;
}

async function readRemoteTailscaleIp(
  remote: string,
  sshOpts: string,
): Promise<string | undefined> {
  const sshArgs = shellSplit(sshOpts).map(expandTildeArg);
  const result = await runCapture(["ssh", ...sshArgs, remote, "tailscale", "ip", "-4"]);
  if (result.code !== 0) return undefined;
  const ip = result.stdout.trim().split(/\s+/)[0];
  return ip || undefined;
}

async function readRemotePublicIp(
  remote: string,
  sshOpts: string,
): Promise<string | undefined> {
  const sshArgs = shellSplit(sshOpts).map(expandTildeArg);
  // Try hostname -I first (gets all IPs, first one is usually public), fall back to curl
  let result = await runCapture([
    "ssh",
    ...sshArgs,
    remote,
    "bash",
    "-c",
    "curl -sf --max-time 3 https://ifconfig.me || curl -sf --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}'",
  ]);
  if (result.code !== 0) return undefined;
  const ip = result.stdout.trim().split(/\s+/)[0];
  return ip || undefined;
}

function formatKnownTargetLine(params: {
  target: KnownTarget;
  status: "active" | "inactive" | "occupied";
  usage?: string;
}): string {
  const vmName = params.target.remoteHost ?? params.target.remote;
  const localUrl = `http://127.0.0.1:${params.target.opencodeLocalPort}`;
  const parts = [
    params.status,
    `vm=${vmName}`,
    `remote=${params.target.remote}`,
    `repo=${params.target.repo}`,
    `local=${localUrl}`,
    `remote_port=${params.target.opencodeRemotePort}`,
  ];
  if (params.usage) {
    parts.push(`usage=${JSON.stringify(params.usage)}`);
  }
  return parts.join(" ");
}

async function listKnownTargets(config: CodeboxConfig): Promise<string[]> {
  const targets = getKnownTargetEntries(config)
    .map(([, target]) => target)
    .sort((left, right) => {
      const a = knownTargetActivityStamp(left);
      const b = knownTargetActivityStamp(right);
      return b.localeCompare(a);
    });
  const lines: string[] = [];
  for (const target of targets) {
    const inspection = await inspectTunnelPort({
      remote: target.remote,
      localPort: target.opencodeLocalPort,
      remotePort: target.opencodeRemotePort,
    });
    if (inspection.state === "expected") {
      lines.push(formatKnownTargetLine({ target, status: "active" }));
      continue;
    }
    if (inspection.state === "occupied") {
      lines.push(
        formatKnownTargetLine({
          target,
          status: "occupied",
          usage: inspection.usage,
        }),
      );
      continue;
    }
    lines.push(formatKnownTargetLine({ target, status: "inactive" }));
  }
  return lines;
}

function rsyncCmd(
  sshOpts: string,
  src: string,
  dest: string,
  excludes: string[] = [],
  verbose = false,
  includes: string[] = [],
  userExcludes: string[] = [],
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
  // rsync uses first-match-wins, so ordering matters:
  //  1. User-provided excludes — explicit user intent always takes priority
  //     (e.g. --exclude .git/config must not be overridden by an include).
  //  2. Protective includes — guard paths like .git from built-in excludes
  //     and system-level filters.
  //  3. Built-in excludes — heavy dirs (node_modules, dist, …).
  for (const ex of userExcludes) {
    cmd.push("--exclude", ex);
  }
  for (const inc of includes) {
    cmd.push("--include", inc);
  }
  for (const ex of excludes) {
    cmd.push("--exclude", ex);
  }
  cmd.push(src, dest);
  return cmd;
}

function resolveResyncLocalRepoPath(params: {
  cwdRepoRoot: string;
  cwdRepoName: string;
  targetRepo: string;
}): { path: string; source: "cwd" | "sibling"; attempted?: string } | undefined {
  if (params.targetRepo === params.cwdRepoName) {
    return { path: params.cwdRepoRoot, source: "cwd" };
  }

  const siblingPath = resolve(params.cwdRepoRoot, "..", params.targetRepo);
  if (existsSync(siblingPath)) {
    try {
      if (statSync(siblingPath).isDirectory()) {
        return { path: siblingPath, source: "sibling" };
      }
    } catch {
      return undefined;
    }
  }
  return { path: siblingPath, source: "sibling", attempted: siblingPath };
}

async function runResync(params: {
  args: string[];
  config: CodeboxConfig;
  configPath: string;
  cwdRepoRoot: string;
  cwdRepoName: string;
  requestedRepo?: string;
  sshOpts: string;
  verbose: boolean;
}): Promise<void> {
  const targets = selectKnownTargets(params.config, { repo: params.requestedRepo });
  if (targets.length === 0) {
    const scope = params.requestedRepo ? ` for repo "${params.requestedRepo}"` : "";
    console.log(`[codebox] No remembered targets to resync${scope}.`);
    return;
  }

  const syncRepo = !hasFlag(params.args, "--no-repo");
  const syncGit = !hasFlag(params.args, "--no-git");
  const dryRun = hasFlag(params.args, "--dry-run");
  const repoExcludes = argValues(params.args, "--exclude");
  const builtinExcludes = [
    "codex-rs/target*",
    "node_modules",
    "dist",
    ".venv",
  ];
  const repoIncludes = syncGit ? [".git", ".git/**"] : [];
  const repoExcludesWithBuiltin = syncGit ? builtinExcludes : [".git", ...builtinExcludes];

  let nextConfig = params.config;
  for (const target of targets) {
    const localRepo = resolveResyncLocalRepoPath({
      cwdRepoRoot: params.cwdRepoRoot,
      cwdRepoName: params.cwdRepoName,
      targetRepo: target.repo,
    });
    if (!localRepo || !existsSync(localRepo.path)) {
      const attemptedPath = localRepo?.attempted ?? resolve(params.cwdRepoRoot, "..", target.repo);
      console.log(
        `[codebox] Skipping ${target.remote} repo=${target.repo}: no local path found at ${attemptedPath}`,
      );
      continue;
    }
    try {
      if (!statSync(localRepo.path).isDirectory()) {
        console.log(
          `[codebox] Skipping ${target.remote} repo=${target.repo}: local path is not a directory at ${localRepo.path}`,
        );
        continue;
      }
    } catch {
      console.log(
        `[codebox] Skipping ${target.remote} repo=${target.repo}: no local path found at ${localRepo.path}`,
      );
      continue;
    }

    if (!syncRepo) {
      console.log(`[codebox] Skipping ${target.remote} repo=${target.repo}: --no-repo set`);
      continue;
    }

    const cliSshOpts = argValue(params.args, "--ssh-opts");
    const targetSshOpts = cliSshOpts ?? target.sshOpts ?? params.sshOpts;
    const cmd = rsyncCmd(
      targetSshOpts,
      `${localRepo.path}/`,
      `${target.remote}:${target.remoteRepo}/`,
      repoExcludesWithBuiltin,
      params.verbose,
      repoIncludes,
      repoExcludes,
    );
    if (dryRun) {
      console.log(
        `[dry-run] resync target remote=${target.remote} repo=${target.repo} local=${localRepo.path} source=${localRepo.source}`,
      );
      console.log(`[dry-run] sync repo: ${cmd.join(" ")}`);
      continue;
    }

    const sshArgs = shellSplit(targetSshOpts).map(expandTildeArg);
    await run(["ssh", ...sshArgs, target.remote, "mkdir", "-p", target.remoteRepo]);
    await run(cmd);
    const updatedAt = new Date().toISOString();
    nextConfig = upsertKnownTarget(
      nextConfig,
      {
        ...target,
        sshOpts: targetSshOpts,
        lastSyncedAt: updatedAt,
      },
      updatedAt,
    );
  }

  if (!dryRun) {
    writeConfig(params.configPath, nextConfig);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const mode = rawArgs[0] === "ssh" ? "ssh" : rawArgs[0] === "tunnel" ? "tunnel" : rawArgs[0] === "list" ? "list" : "sync";
  let args = (mode === "ssh" || mode === "tunnel" || mode === "list") ? rawArgs.slice(1) : rawArgs;
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
  const tunnelListMode = mode === "tunnel" && hasFlag(args, "--list");
  const tunnelAllMode = mode === "tunnel" && hasFlag(args, "--all");
  const resyncMode = mode === "sync" && hasFlag(args, "--resync");
  const requestedRepo = (mode === "tunnel" || mode === "list" || resyncMode) ? argValue(args, "--repo") : undefined;
  if (tunnelListMode && tunnelAllMode) {
    throw new Error("Cannot combine --list and --all in tunnel mode.");
  }

  const repoRoot = resolve(process.cwd());
  const repoName = requestedRepo ?? basename(repoRoot);
  const requestedBase = argValue(args, "--base") ?? process.env.BASE;
  const requestedRemoteHint =
    argValue(args, "--remote") ?? positionalRemote ?? process.env.REMOTE;
  const rememberedTarget =
    !resyncMode && !tunnelListMode && !tunnelAllMode && mode !== "list"
      ? await resolveRememberedTarget({
          config: existingConfig,
          repo: repoName,
          remote: requestedRemoteHint,
          base: requestedBase,
          requireRepoMatch: Boolean(requestedRepo),
        })
      : undefined;
  if (requestedRepo && !resyncMode && !tunnelListMode && !tunnelAllMode && mode !== "list" && !rememberedTarget) {
    throw new Error(`No remembered target found for repo "${requestedRepo}".`);
  }

  const sshOpts =
    argValue(args, "--ssh-opts") ??
    rememberedTarget?.sshOpts ??
    process.env.SSH_OPTS ??
    "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes";

  const assumeYes = hasFlag(args, "--yes");
  const verbose = hasFlag(args, "--verbose") || hasFlag(args, "-v");

  const base =
    requestedBase ??
    rememberedTarget?.base ??
    DEFAULT_BASE;
  const remoteRepo = rememberedTarget?.remoteRepo ?? `${base}/${repoName}`;

  if (mode === "sync") {
    positionalRemote = undefined;
  }

  if (tunnelListMode) {
    const listedConfig = requestedRepo
      ? {
          ...existingConfig,
          known_targets: Object.fromEntries(
            getKnownTargetEntries(existingConfig).filter(([, target]) => target.repo === requestedRepo),
          ),
        }
      : existingConfig;
    const lines = await listKnownTargets(listedConfig);
    if (lines.length === 0) {
      console.log("[codebox] No remembered OpenCode tunnel targets.");
      return;
    }
    for (const line of lines) {
      console.log(line);
    }
    return;
  }

  if (mode === "list") {
    const listedConfig = requestedRepo
      ? {
          ...existingConfig,
          known_targets: Object.fromEntries(
            getKnownTargetEntries(existingConfig).filter(([, target]) => target.repo === requestedRepo),
          ),
        }
      : existingConfig;
    const targets = getKnownTargetEntries(listedConfig)
      .map(([, target]) => target)
      .sort((left, right) => {
        const a = knownTargetActivityStamp(left);
        const b = knownTargetActivityStamp(right);
        return b.localeCompare(a);
      });
    if (targets.length === 0) {
      console.log("[codebox] No remembered targets.");
      return;
    }
    for (const target of targets) {
      const vmName = target.remoteHost ?? target.remote;
      const publicIp = target.publicIp ?? "-";
      const tailscaleIp = target.tailscaleIp;
      const remotePort = target.opencodeRemotePort;
      const endpoint = tailscaleIp
        ? `http://${tailscaleIp}:${remotePort}`
        : `http://127.0.0.1:${remotePort}`;
      console.log(`${vmName}\t${publicIp}\t${endpoint}`);
    }
    return;
  }

  if (tunnelAllMode) {
    const rememberedTargets = selectKnownTargets(existingConfig, {
      repo: requestedRepo,
    });
    if (rememberedTargets.length === 0) {
      console.log("[codebox] No remembered OpenCode tunnel targets.");
      return;
    }

    let nextConfig = existingConfig;
    for (const rememberedTarget of rememberedTargets) {
      const rememberedSshOpts = rememberedTarget.sshOpts ?? sshOpts;
      const resolvedLocalPort = await resolveTunnelLocalPort({
        config: nextConfig,
        remote: rememberedTarget.remote,
        base: rememberedTarget.base,
        repo: rememberedTarget.repo,
        localPort: rememberedTarget.opencodeLocalPort,
        localPortExplicit: false,
        remotePort: rememberedTarget.opencodeRemotePort,
      });
      const resolvedTarget: KnownTarget = {
        ...rememberedTarget,
        sshOpts: rememberedSshOpts,
        opencodeLocalPort: resolvedLocalPort,
      };
      const tunnelCmd = buildTunnelCommand({
        remote: resolvedTarget.remote,
        sshOpts: rememberedSshOpts,
        localPort: resolvedLocalPort,
        remotePort: resolvedTarget.opencodeRemotePort,
      });
      if (hasFlag(args, "--dry-run")) {
        console.log(`[dry-run] ${tunnelCmd.join(" ")}`);
        continue;
      }

      const tunnelStatus = await ensureBackgroundTunnel({
        remote: resolvedTarget.remote,
        sshOpts: rememberedSshOpts,
        localPort: resolvedLocalPort,
        remotePort: resolvedTarget.opencodeRemotePort,
      });
      const updatedAt = new Date().toISOString();
      const remoteHost =
        resolvedTarget.remoteHost ??
        (await readRemoteHostname(resolvedTarget.remote, rememberedSshOpts));
      nextConfig = upsertKnownTarget(
        nextConfig,
        {
          ...resolvedTarget,
          remoteHost,
          lastTunneledAt: updatedAt,
        },
        updatedAt,
      );
      console.log(
        `[codebox] Tunnel ${tunnelStatus}: ${formatKnownTargetLine({
          target: {
            ...resolvedTarget,
            remoteHost,
            lastTunneledAt: updatedAt,
          },
          status: "active",
        })}`,
      );
    }

    if (!hasFlag(args, "--dry-run")) {
      writeConfig(configPath, nextConfig);
    }
    return;
  }

  if (resyncMode) {
    const sshOpts =
      argValue(args, "--ssh-opts") ??
      process.env.SSH_OPTS ??
      "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes";
    await runResync({
      args,
      config: existingConfig,
      configPath,
      cwdRepoRoot: repoRoot,
      cwdRepoName: basename(repoRoot),
      requestedRepo,
      sshOpts,
      verbose: hasFlag(args, "--verbose") || hasFlag(args, "-v"),
    });
    return;
  }

  const remote =
    requestedRemoteHint ??
    rememberedTarget?.remote ??
    (typeof existingConfig.last_remote === "string" ? existingConfig.last_remote : undefined);
  if (!remote) {
    console.error("Missing --remote");
    console.log(usage());
    process.exit(2);
  }
  validateRemote(remote);

  const opencodeSrcArg = argValue(args, "--opencode-src") ?? process.env.OPENCODE_SRC;
  const opencodeSrc = opencodeSrcArg ? resolve(expandHome(opencodeSrcArg)) : undefined;
  const opencodeRepoUrl =
    argValue(args, "--opencode-repo-url") ??
    process.env.OPENCODE_REPO_URL ??
    DEFAULT_OPENCODE_REPO_URL;
  const opencodeRef = parseNonEmptyOption(
    argValue(args, "--opencode-ref") ?? process.env.OPENCODE_REF,
    "--opencode-ref",
    DEFAULT_OPENCODE_REF,
  );
  const opencodeLocalPortRaw =
    argValue(args, "--opencode-local-port") ?? process.env.OPENCODE_LOCAL_PORT;
  const opencodeLocalPortExplicit = opencodeLocalPortRaw != null;
  const parsedOpencodeLocalPort = parsePort(
    opencodeLocalPortRaw,
    "--opencode-local-port",
    4096,
  );
  const opencodeRemotePort = parsePort(
    argValue(args, "--opencode-remote-port") ?? process.env.OPENCODE_REMOTE_PORT,
    "--opencode-remote-port",
    4096,
  );
  const opencodeSupervisor = parseOpencodeSupervisor(
    argValue(args, "--opencode-supervisor") ?? process.env.OPENCODE_SUPERVISOR,
  );
  const syncOpencodeConfig = !hasFlag(args, "--no-opencode-config");
  const syncOpencodeAuth = syncOpencodeConfig && !hasFlag(args, "--no-opencode-auth");
  const preferredOpencodeLocalPort = choosePreferredTunnelLocalPort({
    config: existingConfig,
    remote,
    base,
    repo: repoName,
    remotePort: opencodeRemotePort,
    explicitLocalPort: opencodeLocalPortExplicit ? parsedOpencodeLocalPort : undefined,
    fallbackLocalPort: parsedOpencodeLocalPort,
  });
  const shouldResolveActivePort = mode === "tunnel" || !hasFlag(args, "--no-opencode-tunnel");
  const resolvedOpencodeLocalPort = shouldResolveActivePort
    ? await resolveTunnelLocalPort({
        config: existingConfig,
        remote,
        base,
        repo: repoName,
        localPort: preferredOpencodeLocalPort,
        localPortExplicit: opencodeLocalPortExplicit,
        remotePort: opencodeRemotePort,
      })
    : preferredOpencodeLocalPort;

  const opts: Options = {
    remote,
    sshOpts,
    base,
    opencodeSrc,
    opencodeRepoUrl,
    opencodeRef,
    repoExcludes: argValues(args, "--exclude"),
    opencodeTunnel: !hasFlag(args, "--no-opencode-tunnel"),
    opencodeLocalPort: resolvedOpencodeLocalPort,
    opencodeRemotePort,
    opencodeSupervisor,
    syncRepo: !hasFlag(args, "--no-repo"),
    syncGit: !hasFlag(args, "--no-git"),
    syncCodexConfig: !hasFlag(args, "--no-codex-config"),
    syncOpencodeConfig,
    syncOpencodeAuth,
    syncGhConfig: !hasFlag(args, "--no-gh-config"),
    syncCopilotConfig: !hasFlag(args, "--no-copilot-config"),
    syncKubeConfig: !hasFlag(args, "--no-kube-config"),
    syncSshKeys: hasFlag(args, "--sync-ssh"),
    includeCodexHistory: hasFlag(args, "--include-codex-history"),
    syncEnv: !hasFlag(args, "--no-env"),
    envVars: {},
    reinstallOpencode: hasFlag(args, "--reinstall-opencode"),
    disableTailscale: hasFlag(args, "--disable-tailscale"),
    assumeYes,
    verbose,
    dryRun: hasFlag(args, "--dry-run"),
    configPath,
    syncPaperclip: !hasFlag(args, "--no-paperclip"),
    paperclipRepoUrl: parseNonEmptyOption(
      argValue(args, "--paperclip-repo-url") ?? process.env.PAPERCLIP_REPO_URL,
      "--paperclip-repo-url",
      DEFAULT_PAPERCLIP_REPO_URL,
    ),
    chromeCdpPort: parsePort(argValue(args, "--chrome-cdp-port"), "--chrome-cdp-port", 9222),
    setupChromeCdp: !hasFlag(args, "--no-chrome-cdp"),
  };

  if (opts.syncSshKeys) {
    await promptYes(
      "About to sync ~/.ssh (includes private keys) to the remote.",
      opts.assumeYes,
    );
  }

  const syncLocalOpencodeRepo = Boolean(opts.opencodeSrc && existsSync(opts.opencodeSrc));

  if (mode === "sync" && syncLocalOpencodeRepo) {
    const localOriginUrl = await readGitRemoteUrl(opts.opencodeSrc!, "origin");
    if (!localOriginUrl) {
      throw new Error(
        `Local OpenCode repo at ${opts.opencodeSrc} must be a git checkout with origin ${opts.opencodeRepoUrl}.`,
      );
    }
    if (canonicalGitRemoteUrl(localOriginUrl) !== canonicalGitRemoteUrl(opts.opencodeRepoUrl)) {
      throw new Error(
        `Local OpenCode repo origin (${localOriginUrl}) does not match required fork (${opts.opencodeRepoUrl}).`,
      );
    }
  }

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

    const tunnelStatus = await ensureBackgroundTunnel({
      remote: opts.remote,
      sshOpts: opts.sshOpts,
      localPort: opts.opencodeLocalPort,
      remotePort: opts.opencodeRemotePort,
    });
    const updatedAt = new Date().toISOString();
    const remoteHost = await readRemoteHostname(opts.remote, opts.sshOpts);
    const nextConfig = upsertKnownTarget(
      existingConfig,
      {
        remote: opts.remote,
        remoteHost,
        sshOpts: opts.sshOpts,
        base: opts.base,
        repo: repoName,
        remoteRepo,
        opencodeLocalPort: opts.opencodeLocalPort,
        opencodeRemotePort: opts.opencodeRemotePort,
        lastTunneledAt: updatedAt,
      },
      updatedAt,
    );
    writeConfig(opts.configPath, nextConfig);
    console.log(
      `[codebox] Tunnel ${tunnelStatus}: ${formatKnownTargetLine({
        target: {
          remote: opts.remote,
          remoteHost,
          sshOpts: opts.sshOpts,
          base: opts.base,
          repo: repoName,
          remoteRepo,
          opencodeLocalPort: opts.opencodeLocalPort,
          opencodeRemotePort: opts.opencodeRemotePort,
          lastTunneledAt: updatedAt,
        },
        status: "active",
      })}`,
    );
    return;
  }

  const builtinExcludes = [
    "codex-rs/target*",
    "node_modules",
    "dist",
    ".venv",
  ];
  // Explicit --include rules for .git so rsync's first-match-wins logic
  // keeps the directory even when a system-level filter or built-in exclude
  // would otherwise drop it.  User-provided excludes (opts.repoExcludes)
  // are emitted first so they can still override the includes when the
  // user explicitly targets paths under .git (e.g. --exclude .git/config).
  const repoIncludes: string[] = [];
  if (opts.syncGit) {
    repoIncludes.push(".git", ".git/**");
  } else {
    builtinExcludes.unshift(".git");
  }

  const actions: Array<{ label: string; cmd: string[]; stdin?: string }> = [];

  if (opts.syncRepo) {
    actions.push({
      label: "sync repo",
      cmd: rsyncCmd(
        opts.sshOpts,
        `${repoRoot}/`,
        `${opts.remote}:${remoteRepo}/`,
        builtinExcludes,
        opts.verbose,
        repoIncludes,
        opts.repoExcludes,
      ),
    });
  }

  if (syncLocalOpencodeRepo) {
    actions.push({
      label: "sync opencode repo",
      cmd: rsyncCmd(
        opts.sshOpts,
        `${opts.opencodeSrc!}/`,
        `${opts.remote}:${opts.base}/opencode/`,
        [".git", "node_modules", "dist", ".venv"],
        opts.verbose,
      ),
    });
  }

  const paperclipLocalDir = resolve(os.homedir(), "workspace/paperclip");
  if (opts.syncPaperclip && existsSync(paperclipLocalDir)) {
    actions.push({
      label: "sync paperclip",
      cmd: rsyncCmd(
        opts.sshOpts,
        `${paperclipLocalDir}/`,
        `${opts.remote}:${opts.base}/paperclip/`,
        [".git", "node_modules", "dist", ".venv", ".next", "*.db"],
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
    const opencodeData = resolve(os.homedir(), ".local/share/opencode");
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
    if (opts.syncOpencodeAuth && existsSync(opencodeData)) {
      for (const authFile of ["auth.json", "mcp-auth.json"]) {
        const source = resolve(opencodeData, authFile);
        if (!existsSync(source)) continue;
        actions.push({
          label: `sync ~/.local/share/opencode/${authFile}`,
          cmd: rsyncCmd(
            opts.sshOpts,
            source,
            `${opts.remote}:~/.local/share/opencode/${authFile}`,
            [],
            opts.verbose,
          ),
        });
      }
    }

    // Sync opencode agents/skills/commands customizations
    for (const entry of ["agents", "skills", "AGENTS.md", "commands"] as const) {
      const source = resolve(opencodeConfig, entry);
      if (!existsSync(source)) continue;
      const isDir = statSync(source).isDirectory();
      actions.push({
        label: `sync ~/.config/opencode/${entry}`,
        cmd: rsyncCmd(
          opts.sshOpts,
          isDir ? `${source}/` : source,
          isDir
            ? `${opts.remote}:~/.config/opencode/${entry}/`
            : `${opts.remote}:~/.config/opencode/${entry}`,
          [],
          opts.verbose,
        ),
      });
    }

    // Sync ~/.agents/ (global agent skills/memory)
    const agentsHome = resolve(os.homedir(), ".agents");
    if (existsSync(agentsHome)) {
      actions.push({
        label: "sync ~/.agents",
        cmd: rsyncCmd(
          opts.sshOpts,
          `${agentsHome}/`,
          `${opts.remote}:~/.agents/`,
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

  if (opts.syncCopilotConfig) {
    const copilotConfig = resolve(os.homedir(), ".config/github-copilot");
    if (existsSync(copilotConfig)) {
      actions.push({
        label: "sync ~/.config/github-copilot",
        cmd: rsyncCmd(
          opts.sshOpts,
          `${copilotConfig}/`,
          `${opts.remote}:~/.config/github-copilot/`,
          [],
          opts.verbose,
        ),
      });
    }
  }

  if (opts.syncKubeConfig) {
    const kubeDir = resolve(os.homedir(), ".kube");
    if (existsSync(kubeDir)) {
      actions.push({
        label: "sync ~/.kube",
        cmd: rsyncCmd(
          opts.sshOpts,
          `${kubeDir}/`,
          `${opts.remote}:~/.kube/`,
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
        `About to sync ${envKeys.length} env vars into remote shell/OpenCode env: ${shown.join(", ")}${suffix}.`,
        opts.assumeYes,
      );
    }
  }

  const devboxCodexJson = `{
  "packages": ["git","rustc","cargo","pkg-config","openssl","libcap","gcc","bun"]
}\n`;
  const devboxOpencodeJson = `{
  "packages": ["git","bun","nodejs_22"]
}\n`;

  const envLines = Object.entries(opts.envVars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `export ${k}=${bashQuote(v)}`);
  const envScript = envLines.length ? `${envLines.join("\n")}\n` : "";
  const envScriptDelimiter = `CODEBOX_ENV_FILE_${Math.random().toString(36).slice(2)}`;
  const envBashrcDelimiter = `CODEBOX_ENV_BASHRC_${Math.random().toString(36).slice(2)}`;
  const envBashrcBlock = `# >>> codebox env >>>\nif [ -f "$HOME/.config/codebox/env.sh" ]; then\n  . "$HOME/.config/codebox/env.sh"\nfi\n# <<< codebox env <<<\n`;
  const envSetup = opts.syncEnv
    ? `mkdir -p "$HOME/.config/codebox"
ENV_SCRIPT="$HOME/.config/codebox/env.sh"
if [ ${envLines.length} -gt 0 ]; then
  cat > "$ENV_SCRIPT" <<'${envScriptDelimiter}'
${envScript}${envScriptDelimiter}
  chmod 600 "$ENV_SCRIPT"
else
  rm -f "$ENV_SCRIPT"
fi

BASHRC="$HOME/.bashrc"
TMP_BASHRC="$(mktemp)"
if [ -f "$BASHRC" ]; then
  awk 'BEGIN{skip=0}
    /# >>> codebox env >>>/ {skip=1}
    /# <<< codebox env <<</ {skip=0; next}
    !skip {print}' "$BASHRC" > "$TMP_BASHRC"
else
  : > "$TMP_BASHRC"
fi
if [ ${envLines.length} -gt 0 ]; then
  cat >> "$TMP_BASHRC" <<'${envBashrcDelimiter}'
${envBashrcBlock}${envBashrcDelimiter}
fi
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
PAPERCLIP_DIR="$REMOTE_BASE/paperclip"
PAPERCLIP_REPO_URL=${bashQuote(opts.paperclipRepoUrl)}
OPENCODE_REPO_URL=${bashQuote(opts.opencodeRepoUrl)}
OPENCODE_REF=${bashQuote(opts.opencodeRef)}
OPENCODE_SYNC_LOCAL_SOURCE=${bashQuote(syncLocalOpencodeRepo ? "1" : "0")}
OPENCODE_PORT=${bashQuote(String(opts.opencodeRemotePort))}
OPENCODE_SUPERVISOR=${bashQuote(opts.opencodeSupervisor)}
OPENCODE_REINSTALL=${bashQuote(opts.reinstallOpencode ? "1" : "0")}
DISABLE_TAILSCALE=${bashQuote(opts.disableTailscale ? "1" : "0")}
CHROME_CDP_PORT=${bashQuote(String(opts.chromeCdpPort))}
SETUP_CHROME_CDP=${bashQuote(opts.setupChromeCdp ? "1" : "0")}
OPENCODE_HOSTNAME="127.0.0.1"

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

SYSTEMD_RUN_DIR="/run/user/$(id -u)"
systemd_user_cmd() {
  env XDG_RUNTIME_DIR="$SYSTEMD_RUN_DIR" DBUS_SESSION_BUS_ADDRESS="unix:path=$SYSTEMD_RUN_DIR/bus" systemctl --user "$@"
}

systemd_user_available() {
  command -v systemctl >/dev/null 2>&1 || return 1
  [ -d "$SYSTEMD_RUN_DIR" ] || return 1
  systemd_user_cmd show-environment >/dev/null 2>&1
}

ensure_linger_enabled() {
  command -v loginctl >/dev/null 2>&1 || return 0
  if loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '=yes$'; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    if sudo loginctl enable-linger "$USER" >/dev/null 2>&1; then
      echo "Info: enabled lingering for $USER so user services survive logout"
      return 0
    fi
  fi
  echo "Warning: systemd user lingering is not enabled for $USER; OpenCode may stop after logout."
}

resolve_opencode_bin() {
  if [ -x "$HOME/.local/bin/opencode" ]; then
    printf '%s\\n' "$HOME/.local/bin/opencode"
    return 0
  fi
  if [ -x "$HOME/.opencode/bin/opencode" ]; then
    printf '%s\\n' "$HOME/.opencode/bin/opencode"
    return 0
  fi
  if command -v opencode >/dev/null 2>&1; then
    command -v opencode
    return 0
  fi
  return 1
}

ensure_tailscale() {
  if [ "$DISABLE_TAILSCALE" = "1" ]; then
    echo "Info: Tailscale disabled via --disable-tailscale"
    return 0
  fi

  if ! command -v tailscale >/dev/null 2>&1; then
    echo "Info: Tailscale not found; installing..."
    curl -fsSL https://tailscale.com/install.sh | sh
  fi

  if tailscale status --json 2>/dev/null | grep -q '"BackendState":"Running"'; then
    echo "Info: Tailscale already authenticated and running"
  else
    echo "Info: Starting Tailscale authentication..."
    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      sudo tailscale up || true
    else
      tailscale up || true
    fi
  fi

  TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -1)" || true
  if [ -z "$TAILSCALE_IP" ]; then
    echo "Warning: Could not get Tailscale IP; falling back to 127.0.0.1 for OpenCode" >&2
    TAILSCALE_IP="127.0.0.1"
  else
    echo "Info: Tailscale IP: $TAILSCALE_IP"
  fi
  export TAILSCALE_IP
}

ensure_opencode_checkout() {
  if ! command -v git >/dev/null 2>&1; then
    echo "Error: git is required on the remote host to manage the OpenCode checkout." >&2
    return 1
  fi

  if [ -d "$OPENCODE_DIR/.git" ] && git -C "$OPENCODE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git -C "$OPENCODE_DIR" remote get-url origin >/dev/null 2>&1; then
      git -C "$OPENCODE_DIR" remote set-url origin "$OPENCODE_REPO_URL"
    else
      git -C "$OPENCODE_DIR" remote add origin "$OPENCODE_REPO_URL"
    fi
    echo "Info: ensured OpenCode checkout at $OPENCODE_DIR from $OPENCODE_REPO_URL"
  else
    local scratch_dir
    scratch_dir="$(mktemp -d "$REMOTE_BASE/.codebox-opencode.XXXXXX")"
    git clone "$OPENCODE_REPO_URL" "$scratch_dir/repo"
    if [ -d "$OPENCODE_DIR" ] && [ -n "$(ls -A "$OPENCODE_DIR" 2>/dev/null)" ]; then
      rsync -a --delete --exclude .git "$OPENCODE_DIR"/ "$scratch_dir/repo"/
    fi
    rm -rf "$OPENCODE_DIR"
    mv "$scratch_dir/repo" "$OPENCODE_DIR"
    rmdir "$scratch_dir" 2>/dev/null || true
    echo "Info: ensured OpenCode checkout at $OPENCODE_DIR from $OPENCODE_REPO_URL"
  fi

  if [ "$OPENCODE_SYNC_LOCAL_SOURCE" = "1" ]; then
    echo "Info: preserving synced local OpenCode source at $OPENCODE_DIR (requested ref: $OPENCODE_REF)"
    return 0
  fi

  git -C "$OPENCODE_DIR" fetch --force --tags --prune origin

  if git -C "$OPENCODE_DIR" show-ref --verify --quiet "refs/remotes/origin/$OPENCODE_REF"; then
    git -C "$OPENCODE_DIR" checkout -B "$OPENCODE_REF" "refs/remotes/origin/$OPENCODE_REF"
    echo "Info: checked out OpenCode ref origin/$OPENCODE_REF"
    return 0
  fi

  if git -C "$OPENCODE_DIR" rev-parse --verify --quiet "$OPENCODE_REF^{commit}" >/dev/null; then
    git -C "$OPENCODE_DIR" checkout --detach "$OPENCODE_REF"
    echo "Info: checked out OpenCode ref $OPENCODE_REF"
    return 0
  fi

  if git -C "$OPENCODE_DIR" fetch --force origin "$OPENCODE_REF" >/dev/null 2>&1; then
    git -C "$OPENCODE_DIR" checkout --detach FETCH_HEAD
    echo "Info: checked out OpenCode fetched ref $OPENCODE_REF"
    return 0
  fi

  echo "Error: failed to resolve OpenCode ref '$OPENCODE_REF' from $OPENCODE_REPO_URL." >&2
  return 1
}

stop_opencode_runtime() {
  if systemd_user_available && [ -f "$HOME/.config/systemd/user/opencode-serve.service" ]; then
    systemd_user_cmd stop opencode-serve.service >/dev/null 2>&1 || true
  fi
  pkill -f "opencode serve --hostname .* --port $OPENCODE_PORT" >/dev/null 2>&1 || true
  pkill -f "opencode serve.*--port $OPENCODE_PORT" >/dev/null 2>&1 || true
  for _ in $(seq 1 15); do
    if ! is_port_listening "$OPENCODE_PORT"; then
      return 0
    fi
    sleep 1
  done
  echo "Warning: timed out waiting for OpenCode to stop on $OPENCODE_HOSTNAME:$OPENCODE_PORT"
}

ensure_paperclip_checkout() {
  if [ ! -d "$PAPERCLIP_DIR/.git" ]; then
    if [ -d "$PAPERCLIP_DIR" ]; then
      echo "Info: $PAPERCLIP_DIR exists but is not a git repo (rsynced); skipping git setup"
    else
      echo "Info: Cloning paperclip from $PAPERCLIP_REPO_URL into $PAPERCLIP_DIR"
      git clone "$PAPERCLIP_REPO_URL" "$PAPERCLIP_DIR" || { echo "Warning: failed to clone paperclip; skipping"; return 0; }
    fi
  else
    git -C "$PAPERCLIP_DIR" remote set-url origin "$PAPERCLIP_REPO_URL" 2>/dev/null || \
      git -C "$PAPERCLIP_DIR" remote add origin "$PAPERCLIP_REPO_URL"
    echo "Info: paperclip checkout at $PAPERCLIP_DIR anchored to $PAPERCLIP_REPO_URL"
  fi
}

install_paperclip() {
  ensure_paperclip_checkout
  if [ ! -d "$PAPERCLIP_DIR" ]; then
    echo "Warning: paperclip directory not found after checkout; skipping install"
    return 0
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "Info: pnpm not found; installing via npm..."
    npm install -g pnpm || { echo "Warning: failed to install pnpm; skipping paperclip install"; return 0; }
  fi
  echo "Info: Running pnpm install in $PAPERCLIP_DIR"
  (cd "$PAPERCLIP_DIR" && pnpm install) || echo "Warning: pnpm install failed in $PAPERCLIP_DIR"
}

install_copilot_cli() {
  if command -v copilot >/dev/null 2>&1; then
    echo "Info: GitHub Copilot CLI already installed"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "Warning: npm not found; cannot install GitHub Copilot CLI"
    return 0
  fi
  echo "Info: Installing @github/copilot CLI..."
  npm install -g @github/copilot || echo "Warning: failed to install @github/copilot"
}

install_chrome() {
  if command -v google-chrome-stable >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
    echo "Info: Chrome/Chromium already installed"
    return 0
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Warning: apt-get not found; cannot auto-install Chrome. Install it manually."
    return 0
  fi
  echo "Info: Installing Google Chrome..."
  local tmp_deb
  tmp_deb="$(mktemp /tmp/chrome-XXXXXX.deb)"
  if curl -fsSL "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" -o "$tmp_deb"; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      sudo apt-get install -y "$tmp_deb" || sudo dpkg -i "$tmp_deb" && sudo apt-get install -yf
    else
      echo "Warning: sudo required to install Chrome via apt; skipping"
    fi
  fi
  rm -f "$tmp_deb"
}

resolve_chrome_bin() {
  for bin in google-chrome-stable google-chrome chromium-browser chromium; do
    if command -v "$bin" >/dev/null 2>&1; then
      command -v "$bin"
      return 0
    fi
  done
  # Fall back to puppeteer-bundled Chrome
  if [ -d "$HOME/.cache/puppeteer/chrome" ]; then
    local found
    found="$(find "$HOME/.cache/puppeteer/chrome" -name "chrome" -type f -executable 2>/dev/null | sort -V | tail -1)"
    if [ -n "$found" ]; then
      echo "$found"
      return 0
    fi
  fi
  return 1
}

write_chrome_cdp_service() {
  local chrome_bin
  if ! chrome_bin="$(resolve_chrome_bin)"; then
    echo "Warning: Chrome binary not found; cannot write chrome-cdp.service"
    return 1
  fi
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/chrome-cdp.service" <<EOF
[Unit]
Description=Chrome CDP headless service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$chrome_bin \\
  --headless=new \\
  --no-sandbox \\
  --disable-dev-shm-usage \\
  --disable-gpu \\
  --disable-software-rasterizer \\
  --remote-debugging-port=$CHROME_CDP_PORT \\
  --remote-debugging-address=127.0.0.1 \\
  --user-data-dir=/tmp/chrome-cdp-profile \\
  --disable-background-networking \\
  --disable-default-apps \\
  --no-first-run
Restart=always
RestartSec=5
MemoryMax=2G
KillMode=control-group

[Install]
WantedBy=default.target
EOF
  echo "Info: wrote chrome-cdp.service (binary: $chrome_bin, port: $CHROME_CDP_PORT)"
}

start_chrome_cdp_systemd() {
  if [ "$SETUP_CHROME_CDP" != "1" ]; then
    return 0
  fi
  if ! systemd_user_available; then
    echo "Warning: systemd user services unavailable; skipping Chrome CDP service setup"
    return 0
  fi
  install_chrome
  write_chrome_cdp_service || return 0
  systemd_user_cmd daemon-reload
  systemd_user_cmd enable chrome-cdp.service >/dev/null 2>&1 || true
  # Restart only if the unit file changed (always restart to pick up new binary path)
  systemd_user_cmd restart chrome-cdp.service >/dev/null 2>&1 || systemd_user_cmd start chrome-cdp.service >/dev/null 2>&1 || true
  echo "Info: Chrome CDP service active on 127.0.0.1:$CHROME_CDP_PORT"
}
  local attempted=0
  local runtime_stopped=0

  prepare_install_runtime() {
    if [ "$runtime_stopped" -eq 1 ]; then
      return 0
    fi
    stop_opencode_runtime
    runtime_stopped=1
    if [ ! -d "$OPENCODE_DIR/.git" ]; then
      export OPENCODE_CHANNEL="\${OPENCODE_CHANNEL:-latest}"
    fi
  }

  echo "Info: Running bun install in $OPENCODE_DIR"
  devbox run -- bash -lc "bun install" || echo "Warning: bun install failed; build may fail if deps are missing."

  if [ -x "./scripts/install-local.sh" ]; then
    attempted=1
    if grep -qE '^(<<<<<<< |=======|>>>>>>> )' ./scripts/install-local.sh; then
      echo "Warning: skipping ./scripts/install-local.sh due to merge-conflict markers; trying Bun install hooks if available."
    else
      prepare_install_runtime
      if devbox run -- bash -lc "./scripts/install-local.sh"; then
        return 0
      fi
      echo "Warning: ./scripts/install-local.sh failed; trying Bun install hooks if available."
    fi
  fi

  if [ -f "./package.json" ] && grep -q '"install:local"' ./package.json; then
    attempted=1
    prepare_install_runtime
    if devbox run -- bash -lc "bun run install:local"; then
      return 0
    fi
    echo "Warning: bun run install:local failed; trying package-level install hook if available."
  fi

  if [ -f "./packages/opencode/package.json" ] && grep -q '"install:local"' ./packages/opencode/package.json; then
    attempted=1
    prepare_install_runtime
    if devbox run -- bash -lc "bun run --cwd packages/opencode install:local"; then
      return 0
    fi
    echo "Warning: bun run --cwd packages/opencode install:local failed; continuing bootstrap."
  fi

  if [ "$attempted" -eq 0 ]; then
    echo "Info: skipping local OpenCode install; no install hook found in $OPENCODE_DIR"
    return 0
  fi

  return 1
}

start_opencode_nohup() {
  if is_port_listening "$OPENCODE_PORT"; then
    echo "Info: OpenCode already listening on $OPENCODE_HOSTNAME:$OPENCODE_PORT"
    return 0
  fi
  mkdir -p "$HOME/.cache/codebox"
  if ! (
    cd "$OPENCODE_DIR" &&
    OPENCODE_DISABLE_CHANNEL_DB="\${OPENCODE_DISABLE_CHANNEL_DB:-1}" \
    nohup "$OPENCODE_BIN" serve --hostname "$OPENCODE_HOSTNAME" --port "$OPENCODE_PORT" \
      > "$HOME/.cache/codebox/opencode-serve.log" 2>&1 &
  ); then
    echo "Warning: failed to start OpenCode serve from $OPENCODE_DIR via nohup."
    return 1
  fi
  echo "Info: started OpenCode serve via nohup on $OPENCODE_HOSTNAME:$OPENCODE_PORT (log: ~/.cache/codebox/opencode-serve.log)"
}

write_opencode_systemd_unit() {
  mkdir -p "$HOME/.config/systemd/user" "$HOME/.cache/codebox"
  cat > "$HOME/.config/systemd/user/opencode-serve.service" <<EOF
[Unit]
Description=OpenCode headless server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$OPENCODE_DIR
ExecStart=/bin/bash -lc 'if [ -f "$HOME/.config/codebox/env.sh" ]; then . "$HOME/.config/codebox/env.sh"; fi; if [ -x "$HOME/.local/bin/opencode" ]; then OPENCODE_BIN="$HOME/.local/bin/opencode"; elif [ -x "$HOME/.opencode/bin/opencode" ]; then OPENCODE_BIN="$HOME/.opencode/bin/opencode"; else OPENCODE_BIN="$(command -v opencode)"; fi; export OPENCODE_DISABLE_CHANNEL_DB="\${OPENCODE_DISABLE_CHANNEL_DB:-1}"; exec "\\$OPENCODE_BIN" serve --hostname "$OPENCODE_HOSTNAME" --port ${opts.opencodeRemotePort}'
Restart=always
RestartSec=2
StandardOutput=append:%h/.cache/codebox/opencode-serve.log
StandardError=append:%h/.cache/codebox/opencode-serve.log

[Install]
WantedBy=default.target
EOF
}

start_opencode_systemd() {
  if ! systemd_user_available; then
    return 1
  fi
  ensure_linger_enabled
  write_opencode_systemd_unit
  systemd_user_cmd daemon-reload
  systemd_user_cmd enable --now opencode-serve.service >/dev/null
  systemd_user_cmd restart opencode-serve.service >/dev/null
  echo "Info: ensured OpenCode systemd user service opencode-serve.service"
}

TAILSCALE_IP="127.0.0.1"
ensure_tailscale
if [ "$DISABLE_TAILSCALE" = "1" ]; then
  OPENCODE_HOSTNAME="127.0.0.1"
else
  OPENCODE_HOSTNAME="\${TAILSCALE_IP:-127.0.0.1}"
fi

${envSetup}if ! command -v devbox >/dev/null 2>&1; then
  curl -fsSL https://get.jetpack.io/devbox | bash -s -- -f
fi

mkdir -p "$REPO_DIR" "$OPENCODE_DIR" ~/.config/opencode ~/.opencode ~/.codex ~/.config/gh ~/.local/bin ~/.local/share/opencode

ensure_opencode_checkout
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
  if [ "$OPENCODE_REINSTALL" = "1" ]; then
    if ! install_opencode_local; then
      echo "Warning: OpenCode reinstall failed; continuing bootstrap."
    fi
  elif ! install_opencode_local; then
    echo "Warning: OpenCode local install failed; continuing bootstrap."
  fi
fi

install_paperclip
install_copilot_cli

start_chrome_cdp_systemd

OPENCODE_BIN=""
if OPENCODE_BIN="$(resolve_opencode_bin)"; then
  case "$OPENCODE_SUPERVISOR" in
    systemd)
      if ! start_opencode_systemd; then
        echo "Warning: requested systemd supervision for OpenCode, but systemd user services are unavailable; falling back to nohup."
        start_opencode_nohup
      fi
      ;;
    auto)
      if ! start_opencode_systemd; then
        start_opencode_nohup
      fi
      ;;
    nohup)
      start_opencode_nohup
      ;;
    *)
      echo "Warning: unknown OpenCode supervisor '$OPENCODE_SUPERVISOR'; falling back to nohup."
      start_opencode_nohup
      ;;
  esac

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

  const baseSetupScript = `#!/usr/bin/env bash
set -euo pipefail
BASE_INPUT=${bashQuote(opts.base)}
case "$BASE_INPUT" in
  '$HOME') REMOTE_BASE="$HOME" ;;
  '$HOME'/*) REMOTE_BASE="$HOME/\${BASE_INPUT:6}" ;;
  "~") REMOTE_BASE="$HOME" ;;
  "~/"*) REMOTE_BASE="$HOME/\${BASE_INPUT#~/}" ;;
  *) REMOTE_BASE="$BASE_INPUT" ;;
esac
mkdir -p "$REMOTE_BASE" "$REMOTE_BASE/opencode"
mkdir -p "$HOME/.local/share/opencode" "$HOME/.config/codebox"
`;
  const encoder = new TextEncoder();
  const sshArgs = shellSplit(opts.sshOpts).map(expandTildeArg);
  await run(["ssh", ...sshArgs, opts.remote, "bash", "-s"], {
    stdin: encoder.encode(baseSetupScript),
  });

  for (const a of actions) {
    await run(a.cmd);
  }

  const sshCmd = ["ssh", ...sshArgs, opts.remote, "bash", "-s"];
  await run(sshCmd, { stdin: encoder.encode(remoteScript) });

  let tunnelStatus: "reused" | "started" | undefined;
  if (opts.opencodeTunnel) {
    tunnelStatus = await ensureBackgroundTunnel({
      remote: opts.remote,
      sshOpts: opts.sshOpts,
      localPort: opts.opencodeLocalPort,
      remotePort: opts.opencodeRemotePort,
    });
  }

  const currentKnownTarget = findKnownTarget(existingConfig, opts.remote, opts.base, repoName)?.target;
  const updatedAt = new Date().toISOString();
  const remoteHost = await readRemoteHostname(opts.remote, opts.sshOpts);
  const tailscaleIp = opts.disableTailscale ? undefined : await readRemoteTailscaleIp(opts.remote, opts.sshOpts);
  const publicIp = await readRemotePublicIp(opts.remote, opts.sshOpts);
  const nextConfig = upsertKnownTarget(
    existingConfig,
    {
      remote: opts.remote,
      remoteHost,
      tailscaleIp,
      publicIp,
      sshOpts: opts.sshOpts,
      base: opts.base,
      repo: repoName,
      remoteRepo,
      opencodeLocalPort: opts.opencodeLocalPort,
      opencodeRemotePort: opts.opencodeRemotePort,
      lastSyncedAt: updatedAt,
      lastTunneledAt: opts.opencodeTunnel
        ? updatedAt
        : currentKnownTarget?.lastTunneledAt,
    },
    updatedAt,
  );
  writeConfig(opts.configPath, nextConfig);

  if (opts.opencodeTunnel) {
    console.log(
      `[codebox] Tunnel ${tunnelStatus}: ${formatKnownTargetLine({
        target: {
          remote: opts.remote,
          remoteHost,
          sshOpts: opts.sshOpts,
          base: opts.base,
          repo: repoName,
          remoteRepo,
          opencodeLocalPort: opts.opencodeLocalPort,
          opencodeRemotePort: opts.opencodeRemotePort,
          lastSyncedAt: updatedAt,
          lastTunneledAt: updatedAt,
        },
        status: "active",
      })}`,
    );
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
