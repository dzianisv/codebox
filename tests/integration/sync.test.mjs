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
  assert.match(systemdOut, /OPENCODE_SUPERVISOR=\$'systemd'/);
  assert.match(systemdOut, /git clone "\$OPENCODE_REPO_URL" "\$scratch_dir\/repo"/);
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
    /ExecStart=.*\$HOME\/\.local\/bin\/opencode.*\$HOME\/\.opencode\/bin\/opencode.*export OPENCODE_DISABLE_CHANNEL_DB="\$\{OPENCODE_DISABLE_CHANNEL_DB:-1\}".*exec "\\\$OPENCODE_BIN" serve --hostname 127\.0\.0\.1 --port 5551/,
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
    /cd "\$OPENCODE_DIR" &&[\s\S]*OPENCODE_DISABLE_CHANNEL_DB="\$\{OPENCODE_DISABLE_CHANNEL_DB:-1\}"[\s\S]*nohup "\$OPENCODE_BIN" serve --hostname 127\.0\.0\.1 --port "\$OPENCODE_PORT"/,
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
