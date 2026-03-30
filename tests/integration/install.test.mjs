import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codebox-install-"));
const packDir = path.join(tempRoot, "pack");
const prefixDir = path.join(tempRoot, "prefix");
const cacheDir = path.join(tempRoot, "npm-cache");
mkdirSync(packDir, { recursive: true });
mkdirSync(prefixDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

const binDir = process.platform === "win32" ? prefixDir : path.join(prefixDir, "bin");
const codeboxBin = path.join(
  binDir,
  process.platform === "win32" ? "codebox.cmd" : "codebox",
);

try {
  const npmEnv = {
    ...process.env,
    npm_config_cache: cacheDir,
  };
  const packOutput = execFileSync(
    "npm",
    ["pack", "--pack-destination", packDir],
    { cwd: repoRoot, encoding: "utf8", env: npmEnv },
  );
  const tarball = packOutput.trim().split("\n").pop();
  assert.ok(tarball, "npm pack did not produce a tarball");

  const tarballPath = path.join(packDir, tarball);
  execFileSync(
    "npm",
    ["install", "-g", tarballPath, "--prefix", prefixDir],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: npmEnv,
    },
  );

  const whereCmd = process.platform === "win32" ? "where" : "which";
  const whereResult = spawnSync(whereCmd, ["codebox"], {
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });

  assert.equal(
    whereResult.status,
    0,
    `codebox is not on PATH after install. ${whereResult.stderr || ""}`,
  );

  assert.ok(
    existsSync(codeboxBin),
    `Expected codebox binary at ${codeboxBin}`,
  );

  const bunCheck = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (bunCheck.status === 0) {
    const helpResult = spawnSync(codeboxBin, ["--help"], {
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    assert.equal(
      helpResult.status,
      0,
      `codebox --help failed: ${helpResult.stderr || helpResult.stdout}`,
    );
    assert.match(helpResult.stdout + helpResult.stderr, /Usage:/);
    assert.match(helpResult.stdout + helpResult.stderr, /--opencode-ref <branch\|sha>/);
    assert.match(helpResult.stdout + helpResult.stderr, /default: "dev"/);
  } else if (process.platform !== "win32") {
    const contents = readFileSync(codeboxBin, "utf8");
    const firstLine = contents.split("\n")[0] ?? "";
    assert.match(firstLine, /bun/, "Expected codebox to use bun shebang");
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
