import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tempHome = mkdtempSync(path.join(os.tmpdir(), "codebox-sync-home-"));
const tempRepos = mkdtempSync(path.join(os.tmpdir(), "codebox-sync-repos-"));
const goodOpencodeRepo = path.join(tempRepos, "opencode-good");
const badOpencodeRepo = path.join(tempRepos, "opencode-bad");

mkdirSync(path.join(tempHome, ".config", "opencode"), { recursive: true });
mkdirSync(path.join(tempHome, ".local", "share", "opencode"), { recursive: true });

writeFileSync(
  path.join(tempHome, ".config", "opencode", "opencode.json"),
  JSON.stringify({ provider: { "github-copilot": {} } }) + "\n",
);
writeFileSync(
  path.join(tempHome, ".local", "share", "opencode", "auth.json"),
  JSON.stringify({
    "github-copilot": {
      type: "oauth",
      refresh: "gho_test_refresh",
      access: "gho_test_access",
      expires: 0,
    },
  }) + "\n",
);

function initGitRepo(dir, originUrl) {
  mkdirSync(dir, { recursive: true });
  const initResult = spawnSync("git", ["init", "-q"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(initResult.status, 0, initResult.stderr || initResult.stdout);

  const addRemoteResult = spawnSync("git", ["remote", "add", "origin", originUrl], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(addRemoteResult.status, 0, addRemoteResult.stderr || addRemoteResult.stdout);
}

initGitRepo(goodOpencodeRepo, "git@github.com:dzianisv/opencode.git");
initGitRepo(badOpencodeRepo, "https://github.com/example/not-opencode.git");

function runSync(args) {
  return spawnSync(
    "bun",
    [
      "codebox.ts",
      "--remote",
      "dev@host",
      "--dry-run",
      "--no-env",
      "--no-codex-config",
      "--no-gh-config",
      "--no-opencode-tunnel",
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempHome,
      },
    },
  );
}

try {
  const defaultManagedOpencode = runSync([]);
  assert.equal(
    defaultManagedOpencode.status,
    0,
    `Default sync dry-run failed: ${defaultManagedOpencode.stderr || defaultManagedOpencode.stdout}`,
  );
  const defaultOut = `${defaultManagedOpencode.stdout}\n${defaultManagedOpencode.stderr}`;
  assert.match(defaultOut, /OPENCODE_REPO_URL=\$'https:\/\/github\.com\/dzianisv\/opencode\.git'/);
  assert.match(defaultOut, /OPENCODE_REF=\$'dev'/);
  assert.match(defaultOut, /OPENCODE_SYNC_LOCAL_SOURCE=\$'0'/);
  assert.match(defaultOut, /OPENCODE_SUPERVISOR=\$'systemd'/);
  assert.match(defaultOut, /git -C "\$OPENCODE_DIR" fetch --force --tags --prune origin/);
  assert.match(
    defaultOut,
    /git -C "\$OPENCODE_DIR" checkout -B "\$OPENCODE_REF" "refs\/remotes\/origin\/\$OPENCODE_REF"/,
  );
  assert.match(defaultOut, /systemd_user_cmd stop opencode-serve\.service/);
  assert.doesNotMatch(defaultOut, /sync opencode repo/);

  // Default sync must explicitly --include .git so it is always transferred
  const defaultRepoLine = defaultOut.split("\n").find((l) => l.includes("sync repo:"));
  assert.ok(defaultRepoLine, "Expected a 'sync repo:' line in dry-run output");
  assert.match(
    defaultRepoLine,
    /--include \.git --include \.git\/\*\*/,
    "Default sync should explicitly include .git",
  );
  assert.doesNotMatch(
    defaultRepoLine,
    /--exclude \.git/,
    "Default repo sync should not exclude .git",
  );

  // --no-git must exclude .git and must NOT include it
  const noGitSync = runSync(["--no-git"]);
  assert.equal(
    noGitSync.status,
    0,
    `--no-git sync dry-run failed: ${noGitSync.stderr || noGitSync.stdout}`,
  );
  const noGitOut = `${noGitSync.stdout}\n${noGitSync.stderr}`;
  const noGitRepoLine = noGitOut.split("\n").find((l) => l.includes("sync repo:"));
  assert.ok(noGitRepoLine, "Expected a 'sync repo:' line in --no-git dry-run output");
  assert.match(
    noGitRepoLine,
    /--exclude \.git/,
    "--no-git should exclude .git",
  );
  assert.doesNotMatch(
    noGitRepoLine,
    /--include \.git/,
    "--no-git should not include .git",
  );

  // User-provided --exclude for a .git sub-path must appear BEFORE the
  // protective --include rules so rsync's first-match-wins honours it.
  const userExcludeSync = runSync(["--exclude", ".git/config"]);
  assert.equal(
    userExcludeSync.status,
    0,
    `--exclude .git/config sync dry-run failed: ${userExcludeSync.stderr || userExcludeSync.stdout}`,
  );
  const userExcludeOut = `${userExcludeSync.stdout}\n${userExcludeSync.stderr}`;
  const userExcludeRepoLine = userExcludeOut.split("\n").find((l) => l.includes("sync repo:"));
  assert.ok(userExcludeRepoLine, "Expected a 'sync repo:' line in --exclude .git/config dry-run output");
  // The user exclude must come before the include so it is not overridden
  const excludeIdx = userExcludeRepoLine.indexOf("--exclude .git/config");
  const includeIdx = userExcludeRepoLine.indexOf("--include .git");
  assert.ok(excludeIdx >= 0, "User --exclude .git/config must appear in repo sync command");
  assert.ok(includeIdx >= 0, "Protective --include .git must still appear in repo sync command");
  assert.ok(
    excludeIdx < includeIdx,
    `User --exclude .git/config (pos ${excludeIdx}) must precede --include .git (pos ${includeIdx})`,
  );

  const withSystemd = runSync([
    "--opencode-supervisor",
    "systemd",
    "--opencode-src",
    goodOpencodeRepo,
  ]);
  assert.equal(
    withSystemd.status,
    0,
    `Sync dry-run with systemd failed: ${withSystemd.stderr || withSystemd.stdout}`,
  );
  const systemdOut = `${withSystemd.stdout}\n${withSystemd.stderr}`;
  assert.match(systemdOut, /sync ~\/\.config\/opencode/);
  assert.match(systemdOut, /sync ~\/\.local\/share\/opencode\/auth\.json/);
  assert.match(systemdOut, /OPENCODE_REPO_URL=\$'https:\/\/github\.com\/dzianisv\/opencode\.git'/);
  assert.match(systemdOut, /OPENCODE_REF=\$'dev'/);
  assert.match(systemdOut, /OPENCODE_SYNC_LOCAL_SOURCE=\$'1'/);
  assert.match(systemdOut, /OPENCODE_SUPERVISOR=\$'systemd'/);
  assert.match(systemdOut, /git clone "\$OPENCODE_REPO_URL" "\$scratch_dir\/repo"/);
  assert.match(systemdOut, /preserving synced local OpenCode source/);
  assert.match(systemdOut, /systemd_user_cmd stop opencode-serve\.service/);
  assert.match(
    systemdOut,
    /resolve_opencode_bin\(\) \{[\s\S]*\$HOME\/\.local\/bin\/opencode[\s\S]*\$HOME\/\.opencode\/bin\/opencode/,
  );
  assert.match(systemdOut, /bun run install:local/);
  assert.match(systemdOut, /bun run --cwd packages\/opencode install:local/);
  assert.match(systemdOut, /WorkingDirectory=\$OPENCODE_DIR/);
  assert.match(
    systemdOut,
    /ExecStart=.*\$HOME\/\.local\/bin\/opencode.*\$HOME\/\.opencode\/bin\/opencode.*export OPENCODE_DISABLE_CHANNEL_DB="\$\{OPENCODE_DISABLE_CHANNEL_DB:-1\}".*exec "\\\$OPENCODE_BIN" serve --hostname "\$OPENCODE_HOSTNAME" --port 4096/,
  );
  assert.match(systemdOut, /opencode-serve\.service/);
  assert.match(systemdOut, /systemctl --user/);

  const withNohup = runSync([
    "--opencode-supervisor",
    "nohup",
    "--opencode-src",
    goodOpencodeRepo,
  ]);
  assert.equal(
    withNohup.status,
    0,
    `Sync dry-run with nohup failed: ${withNohup.stderr || withNohup.stdout}`,
  );
  const nohupOut = `${withNohup.stdout}\n${withNohup.stderr}`;
  assert.match(
    nohupOut,
    /cd "\$OPENCODE_DIR" &&[\s\S]*OPENCODE_DISABLE_CHANNEL_DB="\$\{OPENCODE_DISABLE_CHANNEL_DB:-1\}"[\s\S]*nohup "\$OPENCODE_BIN" serve --hostname "\$OPENCODE_HOSTNAME" --port "\$OPENCODE_PORT"/,
  );

  const withoutAuth = runSync(["--no-opencode-auth", "--opencode-src", goodOpencodeRepo]);
  assert.equal(
    withoutAuth.status,
    0,
    `Sync dry-run without auth sync failed: ${withoutAuth.stderr || withoutAuth.stdout}`,
  );
  const withoutAuthOut = `${withoutAuth.stdout}\n${withoutAuth.stderr}`;
  assert.doesNotMatch(withoutAuthOut, /sync ~\/\.local\/share\/opencode\/auth\.json/);

  const badFork = runSync(["--opencode-src", badOpencodeRepo]);
  assert.notEqual(badFork.status, 0, "Expected sync to reject non-fork OpenCode source");
  assert.match(
    `${badFork.stdout}\n${badFork.stderr}`,
    /does not match required fork/,
  );
} finally {
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempRepos, { recursive: true, force: true });
}
