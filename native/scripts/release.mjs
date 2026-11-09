import { copyFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root, run } from "./toolchain.mjs";

run(process.execPath, ["scripts/build.mjs", "release"]);
const target = join(root, "release");
mkdirSync(target, { recursive: true });
const name = "AgentLink-NSH.apk";
const staged = join(target, name + ".next");
copyFileSync(join(root, "android/app/build/outputs/apk/release/app-release.apk"), staged);
const hash = createHash("sha256").update(readFileSync(staged)).digest("hex");
// The daemon may serve this path while publishing. Never expose a partially copied APK.
renameSync(staged, join(target, name));
writeFileSync(join(target, name + ".sha256"), `${hash}  ${name}\n`);
console.log(`Signed APK: native/release/${name}\nSHA-256: ${hash}`);
