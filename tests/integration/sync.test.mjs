import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function runSync(args, options = {}) {
  const syncArgs = [
    "codebox.ts",
    "--remote",
    "dev@host",
    "--dry-run",
    "--no-codex-config",
    "--no-gh-config",
    "--no-opencode-tunnel",
    ...args,
  ];
  if (options.includeNoEnv !== false) {
    syncArgs.splice(4, 0, "--no-env");
  }
  return spawnSync(
    "bun",
    syncArgs,
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempHome,
        ...(options.env ?? {}),
      },
    },
  );
}

function runResync(args, cwd) {
  return spawnSync("bun", [path.join(repoRoot, "codebox.ts"), "--resync", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tempHome,
    },
  });
}

try {
  const nonInteractiveEnvSync = runSync([], {
    includeNoEnv: false,
    env: { CODEBOX_SYNC_TEST_TOKEN: "codebox-sync-test-token" },
  });
  assert.equal(
    nonInteractiveEnvSync.status,
    0,
    `Env sync dry-run should not require --yes: ${nonInteractiveEnvSync.stderr || nonInteractiveEnvSync.stdout}`,
  );
  const nonInteractiveEnvSyncOut = `${nonInteractiveEnvSync.stdout}\n${nonInteractiveEnvSync.stderr}`;
  assert.match(nonInteractiveEnvSyncOut, /export CODEBOX_SYNC_TEST_TOKEN=\$'codebox-sync-test-token'/);
  assert.doesNotMatch(nonInteractiveEnvSyncOut, /Use --yes to proceed/);
  assert.doesNotMatch(nonInteractiveEnvSyncOut, /Type 'yes' to continue/);

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
  assert.match(defaultOut, /elif OPENCODE_BIN_EXISTING="\$\(resolve_opencode_bin\)"; then/);
  assert.match(defaultOut, /OpenCode binary already present at \$OPENCODE_BIN_EXISTING; skipping local install hooks/);
  assert.match(defaultOut, /if paperclip_runtime_healthy; then[\s\S]*skipping install\/start[\s\S]*install_paperclip/);
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
  assert.match(systemdOut, /if \[ "\$OPENCODE_REINSTALL" = "1" \]; then[\s\S]*install_opencode_local/);
  assert.match(
    systemdOut,
    /resolve_opencode_bin\(\) \{[\s\S]*\$HOME\/\.local\/bin\/opencode[\s\S]*\$HOME\/\.opencode\/bin\/opencode/,
  );
  assert.match(systemdOut, /bun run install:local/);
  assert.match(systemdOut, /bun run --cwd packages\/opencode install:local/);
  assert.match(systemdOut, /if systemd_user_cmd is-active --quiet opencode-serve\.service; then/);
  assert.match(systemdOut, /OpenCode systemd service already active and healthy .* skipping restart/);
  assert.match(systemdOut, /OpenCode systemd service inactive; starting/);
  assert.doesNotMatch(systemdOut, /systemd_user_cmd enable --now opencode-serve\.service/);
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

  const resyncWorkspace = mkdtempSync(path.join(tempRepos, "resync-workspace-"));
  const localCodeboxRepo = path.join(resyncWorkspace, "codebox");
  const localDemoRepo = path.join(resyncWorkspace, "demo-repo");
  const localFileRepo = path.join(resyncWorkspace, "file-repo");
  mkdirSync(localCodeboxRepo, { recursive: true });
  mkdirSync(localDemoRepo, { recursive: true });
  writeFileSync(localFileRepo, "not a directory\n");
  writeFileSync(path.join(localCodeboxRepo, "README.txt"), "codebox local repo\n");
  writeFileSync(path.join(localDemoRepo, "README.txt"), "demo local repo\n");

  const resyncConfigPath = path.join(tempRepos, "resync-codebox.json");
  writeFileSync(
    resyncConfigPath,
    JSON.stringify(
      {
        known_targets: {
          "cached-user@cached-host::$HOME/workspace::codebox": {
            remote: "cached-user@cached-host",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "codebox",
            remoteRepo: "$HOME/workspace/codebox",
            opencodeLocalPort: 4096,
            opencodeRemotePort: 4096,
            updatedAt: "2026-03-29T00:00:00.000Z",
          },
          "other-user@other-host::$HOME/workspace::demo-repo": {
            remote: "other-user@other-host",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "demo-repo",
            remoteRepo: "$HOME/workspace/demo-repo",
            opencodeLocalPort: 4097,
            opencodeRemotePort: 4096,
            updatedAt: "2026-03-29T00:00:01.000Z",
          },
          "missing-user@missing-host::$HOME/workspace::missing-repo": {
            remote: "missing-user@missing-host",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "missing-repo",
            remoteRepo: "$HOME/workspace/missing-repo",
            opencodeLocalPort: 4098,
            opencodeRemotePort: 4096,
            updatedAt: "2026-03-29T00:00:02.000Z",
          },
          "file-user@file-host::$HOME/workspace::file-repo": {
            remote: "file-user@file-host",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "file-repo",
            remoteRepo: "$HOME/workspace/file-repo",
            opencodeLocalPort: 4099,
            opencodeRemotePort: 4096,
            updatedAt: "2026-03-29T00:00:03.000Z",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const resyncDryRun = runResync(
    ["--config", resyncConfigPath, "--dry-run", "--no-repo"],
    localCodeboxRepo,
  );
  assert.equal(
    resyncDryRun.status,
    0,
    `--resync dry-run failed: ${resyncDryRun.stderr || resyncDryRun.stdout}`,
  );
  const resyncDryRunOut = `${resyncDryRun.stdout}\n${resyncDryRun.stderr}`;
  assert.match(resyncDryRunOut, /Skipping other-user@other-host repo=demo-repo: --no-repo set/);
  assert.match(resyncDryRunOut, /Skipping cached-user@cached-host repo=codebox: --no-repo set/);
  assert.match(
    resyncDryRunOut,
    /Skipping missing-user@missing-host repo=missing-repo: no local path found/,
  );
  assert.match(
    resyncDryRunOut,
    /Skipping file-user@file-host repo=file-repo: local path is not a directory/,
  );

  const resyncRepoFiltered = runResync(
    ["--config", resyncConfigPath, "--dry-run", "--repo", "demo-repo"],
    localCodeboxRepo,
  );
  assert.equal(
    resyncRepoFiltered.status,
    0,
    `--resync --repo dry-run failed: ${resyncRepoFiltered.stderr || resyncRepoFiltered.stdout}`,
  );
  const resyncRepoFilteredOut = `${resyncRepoFiltered.stdout}\n${resyncRepoFiltered.stderr}`;
  assert.match(
    resyncRepoFilteredOut,
    /resync target remote=other-user@other-host repo=demo-repo local=.*\/demo-repo source=sibling/,
  );
  assert.match(
    resyncRepoFilteredOut,
    /sync repo: rsync .* other-user@other-host:\$HOME\/workspace\/demo-repo\//,
  );
  assert.match(resyncRepoFilteredOut, /sync repo: rsync .* -e ssh -i ~\/\.ssh\/id_rsa -o IdentitiesOnly=yes /);
  assert.doesNotMatch(resyncRepoFilteredOut, /cached-user@cached-host/);

  const resyncRepoFilteredCliSshOpts = runResync(
    [
      "--config",
      resyncConfigPath,
      "--dry-run",
      "--repo",
      "demo-repo",
      "--ssh-opts",
      "-o StrictHostKeyChecking=no",
    ],
    localCodeboxRepo,
  );
  assert.equal(
    resyncRepoFilteredCliSshOpts.status,
    0,
    `--resync --repo --ssh-opts dry-run failed: ${
      resyncRepoFilteredCliSshOpts.stderr || resyncRepoFilteredCliSshOpts.stdout
    }`,
  );
  const resyncRepoFilteredCliSshOptsOut = `${resyncRepoFilteredCliSshOpts.stdout}\n${resyncRepoFilteredCliSshOpts.stderr}`;
  assert.match(
    resyncRepoFilteredCliSshOptsOut,
    /sync repo: rsync .* -e ssh -o StrictHostKeyChecking=no .* other-user@other-host:\$HOME\/workspace\/demo-repo\//,
  );
  assert.doesNotMatch(resyncRepoFilteredCliSshOptsOut, /-i ~\/\.ssh\/id_rsa -o IdentitiesOnly=yes/);

  const localRsyncSrcDir = mkdtempSync(path.join(tempRepos, "local-rsync-src-"));
  const localRsyncDestDefaultDir = mkdtempSync(path.join(tempRepos, "local-rsync-dest-default-"));
  const localRsyncDestNoGitDir = mkdtempSync(path.join(tempRepos, "local-rsync-dest-no-git-"));

  mkdirSync(path.join(localRsyncSrcDir, ".git"), { recursive: true });
  writeFileSync(path.join(localRsyncSrcDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(localRsyncSrcDir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  writeFileSync(path.join(localRsyncSrcDir, "README.txt"), "local rsync payload\n");

  const defaultRsyncArgs = [
    "-az",
    "--delete",
    "--human-readable",
    "--stats",
    "--include",
    ".git",
    "--include",
    ".git/**",
    "--exclude",
    "codex-rs/target*",
    "--exclude",
    "node_modules",
    "--exclude",
    "dist",
    "--exclude",
    ".venv",
    `${localRsyncSrcDir}/`,
    `${localRsyncDestDefaultDir}/`,
  ];
  const defaultRsyncResult = spawnSync("rsync", defaultRsyncArgs, { encoding: "utf8" });
  assert.equal(
    defaultRsyncResult.status,
    0,
    `Local default rsync failed: ${defaultRsyncResult.stderr || defaultRsyncResult.stdout}`,
  );
  assert.equal(
    existsSync(path.join(localRsyncDestDefaultDir, ".git", "HEAD")),
    true,
    "Default rsync should transfer .git/HEAD",
  );

  const noGitRsyncArgs = [
    "-az",
    "--delete",
    "--human-readable",
    "--stats",
    "--exclude",
    "codex-rs/target*",
    "--exclude",
    "node_modules",
    "--exclude",
    "dist",
    "--exclude",
    ".venv",
    "--exclude",
    ".git",
    `${localRsyncSrcDir}/`,
    `${localRsyncDestNoGitDir}/`,
  ];
  const noGitRsyncResult = spawnSync("rsync", noGitRsyncArgs, { encoding: "utf8" });
  assert.equal(
    noGitRsyncResult.status,
    0,
    `Local --no-git rsync failed: ${noGitRsyncResult.stderr || noGitRsyncResult.stdout}`,
  );
  assert.equal(
    existsSync(path.join(localRsyncDestNoGitDir, ".git")),
    false,
    "--no-git rsync should not transfer .git",
  );
  assert.equal(
    existsSync(path.join(localRsyncDestNoGitDir, ".git", "HEAD")),
    false,
    "--no-git rsync should not transfer .git/HEAD",
  );
} finally {
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempRepos, { recursive: true, force: true });
}
