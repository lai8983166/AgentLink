import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { join } from "node:path";

const mobile = fileURLToPath(new URL("..", import.meta.url));
const android = join(mobile, "android");
if (!existsSync(join(android, "keystore.properties"))) throw new Error("请先按 mobile/README.md 配置本地签名密钥；不会使用临时 debug 密钥发布。");
const result = spawnSync(process.platform === "win32" ? "gradlew.bat" : "bash", process.platform === "win32"
  ? [":app:testDebugUnitTest", ":app:assembleRelease", "--console=plain"]
  : ["./gradlew", ":app:testDebugUnitTest", ":app:assembleRelease", "--console=plain"],
  { cwd: android, stdio: "inherit", shell: process.platform === "win32" });
if (result.status !== 0) process.exit(result.status ?? 1);
const apk = join(android, "app/build/outputs/apk/release/app-release.apk");
const release = join(mobile, "release"); mkdirSync(release, { recursive: true });
// 下载接口可以同时读取旧包；新包完整复制后再替换，避免下载到半个 APK。
const staged = join(release, "AgentLink.apk.next");
copyFileSync(apk, staged);
renameSync(staged, join(release, "AgentLink.apk"));
const sha256 = createHash("sha256").update(readFileSync(apk)).digest("hex");
writeFileSync(join(release, "AgentLink.apk.sha256"), sha256 + "  AgentLink.apk\n");
console.log("APK ready: " + join(release, "AgentLink.apk"));
console.log("SHA256: " + sha256);
