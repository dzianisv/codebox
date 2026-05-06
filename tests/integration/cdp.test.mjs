import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codebox-cdp-"));

function runCdp(args, opts = {}) {
  return spawnSync("bun", ["codebox.ts", "cdp", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
  });
}

try {
  const configPath = path.join(tempRoot, "codebox.json");
  writeFileSync(
    configPath,
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
          "older-user@vm-1::$HOME/workspace::demo-repo": {
            remote: "older-user@vm-1",
            remoteHost: "vm-1",
            sshOpts: "-i ~/.ssh/id_rsa -o IdentitiesOnly=yes",
            base: "$HOME/workspace",
            repo: "demo-repo",
            remoteRepo: "$HOME/workspace/demo-repo",
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

  const defaultCommand = runCdp(["--config", configPath, "--dry-run"]);
  assert.equal(
    defaultCommand.status,
    0,
    `CDP mode default dry-run failed: ${defaultCommand.stderr || defaultCommand.stdout}`,
  );
  const defaultOut = `${defaultCommand.stdout}\n${defaultCommand.stderr}`;
  assert.match(defaultOut, /\[dry-run\] ssh /);
  assert.match(defaultOut, /-f -N/);
  assert.match(defaultOut, /-R 9222:127\.0\.0\.1:9222/);
  assert.match(defaultOut, /recent-user@vm-2/);
  assert.doesNotMatch(defaultOut, /older-user@vm-1/);

  const customPorts = runCdp([
    "--config",
    configPath,
    "--repo",
    "demo-repo",
    "--cdp-local-port",
    "9333",
    "--cdp-remote-port",
    "9555",
    "--dry-run",
  ]);
  assert.equal(
    customPorts.status,
    0,
    `CDP mode custom-port dry-run failed: ${customPorts.stderr || customPorts.stdout}`,
  );
  const customOut = `${customPorts.stdout}\n${customPorts.stderr}`;
  assert.match(customOut, /-R 9555:127\.0\.0\.1:9333/);
  assert.match(customOut, /older-user@vm-1/);
  assert.doesNotMatch(customOut, /recent-user@vm-2/);

  const fakeBin = path.join(tempRoot, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const psCounterPath = path.join(tempRoot, "ps-count");
  const sshLogPath = path.join(tempRoot, "ssh.log");
  const localPort = 19333;
  const remotePort = 19555;
  writeFileSync(psCounterPath, "0\n");
  writeFileSync(sshLogPath, "");

  const psPath = path.join(fakeBin, "ps");
  writeFileSync(
    psPath,
    `#!/bin/sh
count="$(cat "${psCounterPath}")"
next=$((count + 1))
echo "$next" > "${psCounterPath}"
if [ "$1" = "-ax" ] && [ "$2" = "-o" ] && [ "$3" = "command=" ]; then
  if [ "$count" -eq 0 ]; then
    echo "ssh -f -N -R ${remotePort}:127.0.0.1:${localPort} recent-user@vm-20"
  else
    echo "ssh -f -N -R${remotePort}:127.0.0.1:${localPort} recent-user@vm-2"
  fi
  exit 0
fi
exec /bin/ps "$@"
`,
  );
  chmodSync(psPath, 0o755);

  const lsofPath = path.join(fakeBin, "lsof");
  writeFileSync(
    lsofPath,
    `#!/bin/sh
echo "4242"
`,
  );
  chmodSync(lsofPath, 0o755);

  const sshPath = path.join(fakeBin, "ssh");
  writeFileSync(
    sshPath,
    `#!/bin/sh
echo "$@" >> "${sshLogPath}"
exit 0
`,
  );
  chmodSync(sshPath, 0o755);

  const edgeCase = runCdp(
    [
      "--config",
      configPath,
      "--cdp-local-port",
      String(localPort),
      "--cdp-remote-port",
      String(remotePort),
    ],
    { env: { PATH: `${fakeBin}:${process.env.PATH}` } },
  );
  assert.equal(
    edgeCase.status,
    0,
    `CDP mode exact-arg matching failed: ${edgeCase.stderr || edgeCase.stdout}`,
  );
  const edgeOut = `${edgeCase.stdout}\n${edgeCase.stderr}`;
  assert.match(edgeOut, /CDP reverse tunnel started/);
  assert.doesNotMatch(edgeOut, /CDP reverse tunnel reused/);
  const sshInvocations = readFileSync(sshLogPath, "utf8");
  assert.match(sshInvocations, /recent-user@vm-2/);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
