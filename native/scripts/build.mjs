import { join } from "node:path";
import { rmSync } from "node:fs";
import { root, lock, nsh, requireNsh, run, verify } from "./toolchain.mjs";

const mode = process.argv[2] ?? "check";
if (!["check", "test", "bundle", "apk", "release", "unit", "test-apk", "connected-test"].includes(mode)) throw new Error("Unknown build mode");
requireNsh();
await verify(join(root, "android/app/libs/nsh.aar"), lock.aar["nsh.aar"]);
run(nsh, ["check"]);
if (mode === "test") {
  run(process.execPath, ["--test", "tests/toolchain.test.mjs"]);
  run("bun", ["test", "tests/client.test.ts"]);
  run(nsh, ["test", "tests/HostProbe.test.tsx", "--web-host", "tests/host.mjs"]);
  run(nsh, ["test", "tests/ClientApp.test.tsx", "--web-host", "tests/client-host.mjs"]);
}
if (!["check", "test"].includes(mode)) {
  run(nsh, ["build", "App.tsx", "--release", "--out", "android/app/src/main/assets/nsh"]);
  // Retain executable JS/bytecode, but not development source mappings in an APK.
  rmSync(join(root, "android/app/src/main/assets/nsh/bundle.js.map"), { force: true });
}
if (["apk", "release", "unit", "test-apk", "connected-test"].includes(mode)) {
  const task = mode === "release" ? ":app:assembleRelease" : mode === "unit" ? ":app:testDebugUnitTest" : mode === "apk" ? ":app:assembleDebug" : mode === "test-apk" ? ":app:assembleDebugAndroidTest" : ":app:connectedDebugAndroidTest";
  if (process.platform === "win32") {
    run("cmd.exe", ["/d", "/c", "gradlew.bat", task, "--console=plain"], { cwd: join(root, "android") });
  } else run("bash", ["./gradlew", task, "--console=plain"], { cwd: join(root, "android") });
}
