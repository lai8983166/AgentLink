import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const lock = JSON.parse(readFileSync(join(root, "toolchain.lock.json"), "utf8"));
export const toolsDir = join(root, ".tools");
export const nsh = join(toolsDir, "nsh", "bin", process.platform === "win32" ? "nsh.exe" : "nsh");

export async function verify(file, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid pinned SHA-256");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error(`Checksum mismatch: ${file}`);
}

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? result.signal})`);
}

export function requireNsh() {
  if (!existsSync(nsh)) throw new Error("Run node native/scripts/setup.mjs first");
  const version = spawnSync(nsh, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim().split(/\s+/)[1] !== lock.nshVersion) {
    throw new Error(`Expected NSH ${lock.nshVersion}; rerun setup`);
  }
}
