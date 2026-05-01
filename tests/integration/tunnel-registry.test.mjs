import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codebox-tunnel-registry-"));

function runCodebox(args) {
  return spawnSync("bun", ["codebox.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine free port"));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function occupyPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine occupied port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

try {
  const rememberedPort = await getFreePort();
  const secondRememberedPort = await getFreePort();
  const thirdRememberedPort = await getFreePort();
  const configPath = path.join(tempRoot, "codebox.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        last_remote: "cached-user@cached-host",
        last_base: "$HOME/workspace",
        last_repo: "codebox",
        known_targets: {
          "cached-user@cached-host::$HOME/workspace::codebox": {
            remote: "cached-user@cached-host",
            remoteHost: "vm-alpha",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "codebox",
            remoteRepo: "$HOME/workspace/codebox",
            opencodeLocalPort: rememberedPort,
            opencodeRemotePort: 4096,
            lastSyncedAt: "2026-03-29T00:00:00.000Z",
            updatedAt: "2026-03-29T00:00:00.000Z",
          },
          "other-user@other-host::$HOME/workspace::demo-repo": {
            remote: "other-user@other-host",
            remoteHost: "vm-beta",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "demo-repo",
            remoteRepo: "$HOME/workspace/demo-repo",
            opencodeLocalPort: secondRememberedPort,
            opencodeRemotePort: 4096,
            lastSyncedAt: "2026-03-28T23:00:00.000Z",
            updatedAt: "2026-03-28T23:00:00.000Z",
          },
          "older-user@older-host::$HOME/workspace::demo-repo": {
            remote: "older-user@older-host",
            remoteHost: "vm-gamma",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "demo-repo",
            remoteRepo: "$HOME/workspace/demo-repo",
            opencodeLocalPort: thirdRememberedPort,
            opencodeRemotePort: 4096,
            lastSyncedAt: "2026-03-28T22:00:00.000Z",
            updatedAt: "2026-03-28T22:00:00.000Z",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const listed = runCodebox(["tunnel", "--list", "--config", configPath]);
  assert.equal(
    listed.status,
    0,
    `Tunnel list failed: ${listed.stderr || listed.stdout}`,
  );
  const listedOut = `${listed.stdout}\n${listed.stderr}`;
  assert.match(listedOut, /vm=vm-alpha/);
  assert.match(listedOut, /repo=codebox/);
  assert.match(listedOut, new RegExp(`local=http://127\\.0\\.0\\.1:${rememberedPort}`));
  assert.match(listedOut, /vm=vm-beta/);
  assert.match(listedOut, /repo=demo-repo/);
  assert.match(listedOut, /vm=vm-gamma/);

  const allDryRun = runCodebox(["tunnel", "--all", "--config", configPath, "--dry-run"]);
  assert.equal(
    allDryRun.status,
    0,
    `Tunnel --all dry-run failed: ${allDryRun.stderr || allDryRun.stdout}`,
  );
  const allDryRunOut = `${allDryRun.stdout}\n${allDryRun.stderr}`;
  assert.match(
    allDryRunOut,
    new RegExp(`-L ${rememberedPort}:127\\.0\\.0\\.1:4096 cached-user@cached-host`),
  );
  assert.match(
    allDryRunOut,
    new RegExp(`-L ${secondRememberedPort}:127\\.0\\.0\\.1:4096 other-user@other-host`),
  );

  const singleDryRun = runCodebox(["tunnel", "--config", configPath, "--dry-run"]);
  assert.equal(
    singleDryRun.status,
    0,
    `Single tunnel dry-run failed: ${singleDryRun.stderr || singleDryRun.stdout}`,
  );
  const singleDryRunOut = `${singleDryRun.stdout}\n${singleDryRun.stderr}`;
  assert.match(
    singleDryRunOut,
    new RegExp(`-L ${rememberedPort}:127\\.0\\.0\\.1:4096 cached-user@cached-host`),
  );

  const selectedRepoDryRun = runCodebox([
    "tunnel",
    "--repo",
    "demo-repo",
    "--config",
    configPath,
    "--dry-run",
  ]);
  assert.equal(
    selectedRepoDryRun.status,
    0,
    `Repo-selected tunnel dry-run failed: ${selectedRepoDryRun.stderr || selectedRepoDryRun.stdout}`,
  );
  const selectedRepoOut = `${selectedRepoDryRun.stdout}\n${selectedRepoDryRun.stderr}`;
  assert.match(
    selectedRepoOut,
    new RegExp(`-L ${secondRememberedPort}:127\\.0\\.0\\.1:4096 other-user@other-host`),
  );
  assert.doesNotMatch(
    selectedRepoOut,
    new RegExp(`-L ${thirdRememberedPort}:127\\.0\\.0\\.1:4096 older-user@older-host`),
  );

  const occupied = await occupyPort();
  try {
    const occupiedConfigPath = path.join(tempRoot, "occupied-codebox.json");
    writeFileSync(
      occupiedConfigPath,
      JSON.stringify(
        {
          last_remote: "cached-user@cached-host",
          last_base: "$HOME/workspace",
          last_repo: "codebox",
          known_targets: {
            "cached-user@cached-host::$HOME/workspace::codebox": {
              remote: "cached-user@cached-host",
              remoteHost: "vm-alpha",
              sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
              base: "$HOME/workspace",
              repo: "codebox",
              remoteRepo: "$HOME/workspace/codebox",
              opencodeLocalPort: occupied.port,
              opencodeRemotePort: 4096,
              lastSyncedAt: "2026-03-29T00:00:00.000Z",
              updatedAt: "2026-03-29T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const reassigned = runCodebox(["tunnel", "--config", occupiedConfigPath, "--dry-run"]);
    assert.equal(
      reassigned.status,
      0,
      `Occupied-port tunnel dry-run failed: ${reassigned.stderr || reassigned.stdout}`,
    );
    const reassignedOut = `${reassigned.stdout}\n${reassigned.stderr}`;
    const match = reassignedOut.match(/-L (\d+):127\.0\.0\.1:4096 cached-user@cached-host/);
    assert.ok(match, `Did not find reassigned tunnel command in output: ${reassignedOut}`);
    const assignedPort = Number.parseInt(match[1], 10);
    assert.notEqual(assignedPort, occupied.port, "Expected occupied remembered port to be reassigned");
  } finally {
    await new Promise((resolve, reject) => {
      occupied.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
