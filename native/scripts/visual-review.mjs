import { cpSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { root, nsh, requireNsh, run } from "./toolchain.mjs";

// Stage source in ignored workspace: never change the production manifest or
// connect to a real server while reviewing synthetic screenshots.
requireNsh();
const workspace = join(root, ".tools/visual-review/workspace");
const app = join(workspace, "native");
mkdirSync(app, { recursive: true });
for (const name of ["app", "core", "assets", "tests", "App.tsx"]) cpSync(join(root, name), join(app, name), { recursive: true });
for (const name of ["shared", "web"]) cpSync(join(root, "..", name, "src"), join(workspace, name, "src"), { recursive: true });
cpSync(join(root, "../shared"), join(workspace, "node_modules/@agentlink/shared"), { recursive: true, filter: source => !source.includes("node_modules") });
cpSync(realpathSync(join(root, "../shared/node_modules/zod")), join(workspace, "node_modules/zod"), { recursive: true });
const config = JSON.parse(readFileSync(join(root, "nsh.json"), "utf8"));
config.web = { host: "tests/client-host.mjs" };
writeFileSync(join(app, "nsh.json"), JSON.stringify(config));
mkdirSync(join(app, "artifacts"), { recursive: true });
const browser = process.argv[2];
run(nsh, ["test", "tests/VisualReview.test.tsx", "--target", "web", ...(browser ? ["--browser", resolve(browser)] : [])], { cwd: app });
console.log("Synthetic preview screenshots: native/.tools/visual-review/workspace/native/artifacts/");
