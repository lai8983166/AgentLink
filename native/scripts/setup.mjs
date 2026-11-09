import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lock, root, toolsDir, verify, run } from "./toolchain.mjs";

const platform = `${process.platform}-${process.arch}`;
if (!lock.archives[platform]) throw new Error(`No pinned NSH archive for ${platform}`);
const cache = join(toolsDir, "downloads");
mkdirSync(cache, { recursive: true });
// Optional directory of previously downloaded OFFICIAL archives; hashes still checked.
const input = process.env.NSH_ARCHIVE_DIR && resolve(process.env.NSH_ARCHIVE_DIR);
for (const asset of [lock.archives[platform], lock.archives.android]) {
  const target = join(cache, asset.name);
  if (!existsSync(target)) {
    if (input) copyFileSync(join(input, asset.name), target);
    else run(process.platform === "win32" ? "curl.exe" : "curl", [
      "--fail", "--location", "--retry", "2", "--connect-timeout", "15", "--max-time", "600",
      `${lock.release}/${asset.name}`, "--output", target,
    ]);
  }
  await verify(target, asset.sha256);
  if (asset.name.endsWith(".tar.gz")) run("tar", ["-xzf", target, "-C", toolsDir]);
  else if (process.platform === "win32") {
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Expand-Archive -LiteralPath $env:AGENTLINK_NSH_ARCHIVE -DestinationPath $env:AGENTLINK_NSH_DEST -Force"],
    { env: { ...process.env, AGENTLINK_NSH_ARCHIVE: target, AGENTLINK_NSH_DEST: toolsDir } });
  } else run("python3", ["-m", "zipfile", "-e", target, toolsDir]);
}
const libs = join(root, "android", "app", "libs");
mkdirSync(libs, { recursive: true });
for (const [name, hash] of Object.entries(lock.aar)) {
  const source = join(toolsDir, "nsh-embed-android", name);
  await verify(source, hash);
  copyFileSync(source, join(libs, name));
}
console.log(`NSH ${lock.nshVersion} CLI and Android AAR installed from verified archives.`);
