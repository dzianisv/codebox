import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codebox-ssh-"));
const configPath = path.join(tempRoot, "codebox.json");

writeFileSync(
  configPath,
  JSON.stringify({
    last_remote: "cached-user@cached-host",
    last_base: "/srv/legacy-workspace",
  }) + "\n",
);

function runSsh(args) {
  return spawnSync("bun", ["codebox.ts", "ssh", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function runTunnel(args) {
  return spawnSync("bun", ["codebox.ts", "tunnel", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

try {
  const tunnelOnly = runSsh([
    "-L",
    "4097:127.0.0.1:4097",
    "-N",
    "--config",
    configPath,
    "--dry-run",
  ]);
  assert.equal(
    tunnelOnly.status,
    0,
    `Tunnel-only ssh dry-run failed: ${tunnelOnly.stderr || tunnelOnly.stdout}`,
  );
  const tunnelOut = `${tunnelOnly.stdout}\n${tunnelOnly.stderr}`;
  assert.match(tunnelOut, /\[dry-run\] ssh /);
  assert.match(tunnelOut, /-L 4097:127\.0\.0\.1:4097/);
  assert.match(tunnelOut, /-N cached-user@cached-host/);
  assert.doesNotMatch(tunnelOut, /bash -lc/);

  const remoteCommand = runSsh([
    "--config",
    configPath,
    "--dry-run",
    "--",
    "pwd",
  ]);
  assert.equal(
    remoteCommand.status,
    0,
    `Remote-command ssh dry-run failed: ${remoteCommand.stderr || remoteCommand.stdout}`,
  );
  const remoteOut = `${remoteCommand.stdout}\n${remoteCommand.stderr}`;
  assert.match(remoteOut, /\[dry-run\] ssh /);
  assert.match(remoteOut, /cached-user@cached-host bash -lc/);
  assert.match(remoteOut, /\$HOME\/workspace\/codebox/);
  assert.doesNotMatch(remoteOut, /\/srv\/legacy-workspace\/codebox/);
  assert.match(remoteOut, /exec .*pwd/);

  const tunnelCommand = runTunnel([
    "--config",
    configPath,
    "--opencode-local-port",
    "4901",
    "--opencode-remote-port",
    "4902",
    "--dry-run",
  ]);
  assert.equal(
    tunnelCommand.status,
    0,
    `Tunnel mode dry-run failed: ${tunnelCommand.stderr || tunnelCommand.stdout}`,
  );
  const tunnelModeOut = `${tunnelCommand.stdout}\n${tunnelCommand.stderr}`;
  assert.match(tunnelModeOut, /\[dry-run\] ssh /);
  assert.match(tunnelModeOut, /-f -N/);
  assert.match(tunnelModeOut, /-L 4901:127\.0\.0\.1:4902/);
  assert.match(tunnelModeOut, /cached-user@cached-host/);

  const rememberedTargetsConfigPath = path.join(tempRoot, "remembered-targets.json");
  writeFileSync(
    rememberedTargetsConfigPath,
    JSON.stringify(
      {
        known_targets: {
          "recent-user@vm-2::$HOME/workspace::codebox": {
            remote: "recent-user@vm-2",
            remoteHost: "vm-2",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "codebox",
            remoteRepo: "$HOME/workspace/codebox",
            opencodeLocalPort: 4096,
            opencodeRemotePort: 4096,
            lastSyncedAt: "2026-03-29T02:00:00.000Z",
            updatedAt: "2026-03-29T02:00:00.000Z",
          },
          "older-user@vm-1::$HOME/workspace::codebox": {
            remote: "older-user@vm-1",
            remoteHost: "vm-1",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "codebox",
            remoteRepo: "$HOME/workspace/codebox",
            opencodeLocalPort: 4096,
            opencodeRemotePort: 4096,
            lastSyncedAt: "2026-03-29T01:00:00.000Z",
            updatedAt: "2026-03-29T01:00:00.000Z",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const recentRemoteFallback = runSsh([
    "--config",
    rememberedTargetsConfigPath,
    "--dry-run",
    "--",
    "pwd",
  ]);
  assert.equal(
    recentRemoteFallback.status,
    0,
    `Recent-remote ssh dry-run failed: ${recentRemoteFallback.stderr || recentRemoteFallback.stdout}`,
  );
  const recentRemoteOut = `${recentRemoteFallback.stdout}\n${recentRemoteFallback.stderr}`;
  assert.match(recentRemoteOut, /recent-user@vm-2 bash -lc/);
  assert.doesNotMatch(recentRemoteOut, /older-user@vm-1 bash -lc/);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
