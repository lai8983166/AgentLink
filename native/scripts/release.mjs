import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root, run } from "./toolchain.mjs";

run(process.execPath, ["scripts/build.mjs", "release"]);
const target = join(root, "release");
mkdirSync(target, { recursive: true });
const name = "AgentLink-NSH.apk";
copyFileSync(join(root, "android/app/build/outputs/apk/release/app-release.apk"), join(target, name));
const hash = createHash("sha256").update(readFileSync(join(target, name))).digest("hex");
writeFileSync(join(target, name + ".sha256"), `${hash}  ${name}\n`);
console.log(`Signed APK: native/release/${name}\nSHA-256: ${hash}`);
