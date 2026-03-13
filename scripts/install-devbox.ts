#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type InstallOptions = {
  version?: string;
  dryRun: boolean;
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name: string;
  assets: ReleaseAsset[];
};

function parseArgs(argv: string[]): InstallOptions {
  const opts: InstallOptions = {
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--version") {
      opts.version = argv[++i];
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      // eslint-disable-next-line no-console
      console.log(`install-devbox.ts [options]

Options:
  --version <tag>   Install a specific release tag (example: 0.17.0)
  --dry-run         Print actions without writing files
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function mapAssetArch(platform: NodeJS.Platform, arch: string): string {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  if (platform === "linux" && arch === "ia32") return "386";
  if (platform === "linux" && arch === "arm") return "armv7l";
  throw new Error(`Unsupported architecture for devbox binary: ${platform}/${arch}`);
}

function ensureSupportedPlatform(platform: NodeJS.Platform): "darwin" | "linux" {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error(`Unsupported platform for devbox binary: ${platform}`);
}

function runCapture(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  }
  return result.stdout.trim();
}

function run(cmd: string, args: string[], dryRun: boolean): void {
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`[dry-run] ${cmd} ${args.join(" ")}`);
    return;
  }
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

async function fetchRelease(version?: string): Promise<GitHubRelease> {
  const base = "https://api.github.com/repos/jetify-com/devbox/releases";
  const url = version ? `${base}/tags/${encodeURIComponent(version)}` : `${base}/latest`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "codebox-install-script"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch release metadata (${response.status}) from ${url}`);
  }
  return (await response.json()) as GitHubRelease;
}

function selectAsset(release: GitHubRelease, platform: "darwin" | "linux", arch: string): ReleaseAsset {
  const expectedName = `devbox_${release.tag_name}_${platform}_${arch}.tar.gz`;
  const exact = release.assets.find((asset) => asset.name === expectedName);
  if (exact) return exact;

  const fallback = release.assets.find(
    (asset) =>
      asset.name.startsWith("devbox_") &&
      asset.name.includes(`_${platform}_`) &&
      asset.name.includes(`_${arch}.tar.gz`)
  );
  if (fallback) return fallback;

  const available = release.assets.map((asset) => asset.name).join(", ");
  throw new Error(`No matching devbox asset for ${platform}/${arch}. Available: ${available}`);
}

async function findDevboxBinary(root: string): Promise<string | undefined> {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "devbox") {
        return fullPath;
      }
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const platform = ensureSupportedPlatform(process.platform);
  const arch = mapAssetArch(platform, process.arch);
  const release = await fetchRelease(options.version);
  const asset = selectAsset(release, platform, arch);

  const bunGlobalBin =
    process.env.BUN_INSTALL_BIN || runCapture("bun", ["pm", "bin", "-g"]) || path.join(os.homedir(), ".bun", "bin");
  const targetPath = path.join(bunGlobalBin, "devbox");

  // eslint-disable-next-line no-console
  console.log(`Installing devbox ${release.tag_name} from ${asset.name}`);
  // eslint-disable-next-line no-console
  console.log(`Target: ${targetPath}`);

  if (options.dryRun) {
    // eslint-disable-next-line no-console
    console.log(`[dry-run] Would download: ${asset.browser_download_url}`);
    // eslint-disable-next-line no-console
    console.log(`[dry-run] Would install binary into ${bunGlobalBin}`);
    return;
  }

  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "devbox-install-"));
    const tarPath = path.join(tempDir, asset.name);

    const response = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": "codebox-install-script" }
    });
    if (!response.ok) {
      throw new Error(`Failed to download ${asset.browser_download_url} (${response.status})`);
    }
    await Bun.write(tarPath, await response.arrayBuffer());

    run("tar", ["-xzf", tarPath, "-C", tempDir], false);

    const binaryPath = await findDevboxBinary(tempDir);
    if (!binaryPath) {
      throw new Error(`Could not find devbox binary in extracted archive: ${asset.name}`);
    }

    await mkdir(bunGlobalBin, { recursive: true });
    await copyFile(binaryPath, targetPath);
    await chmod(targetPath, 0o755);

    const verify = spawnSync(targetPath, ["version"], { encoding: "utf8" });
    if (verify.status !== 0) {
      throw new Error(`Installed binary failed version check: ${verify.stderr || verify.stdout}`);
    }

    // eslint-disable-next-line no-console
    console.log(`Installed: ${targetPath}`);
    // eslint-disable-next-line no-console
    console.log(`devbox version: ${verify.stdout.trim()}`);

    const pathSegments = (process.env.PATH || "").split(":");
    if (!pathSegments.includes(bunGlobalBin)) {
      // eslint-disable-next-line no-console
      console.log(`Warning: ${bunGlobalBin} is not in PATH for this shell.`);
    }
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
