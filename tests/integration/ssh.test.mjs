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
    last_base: "$HOME/workspace",
  }) + "\n",
);

function runSsh(args) {
  return spawnSync("bun", ["codebox.ts", "ssh", ...args], {
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
  assert.match(remoteOut, /exec .*pwd/);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
