import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDownloadsRouter } from "./downloads";

test("download editions have separate files, names and uncached responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlink-download-test-"));
  try {
    const files = { original: join(dir, "old.apk"), nsh: join(dir, "new.apk") };
    writeFileSync(files.original, "synthetic-original"); writeFileSync(files.nsh, "synthetic-nsh");
    const app = createDownloadsRouter(files);
    for (const [path, name, body] of [["agentlink.apk", "AgentLink.apk", "synthetic-original"], ["agentlink-nsh.apk", "AgentLink-NSH.apk", "synthetic-nsh"]] as const) {
      const res = await app.request(`/downloads/${path}`);
      expect(res.status).toBe(200); expect(res.headers.get("Content-Type")).toBe("application/vnd.android.package-archive");
      expect(res.headers.get("Content-Disposition")).toContain(name); expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toBe(body);
    }
    const html = await (await app.request("/downloads/")).text();
    expect(html).toContain("/downloads/agentlink.apk"); expect(html).toContain("/downloads/agentlink-nsh.apk");
    rmSync(files.nsh);
    expect((await app.request("/downloads/agentlink-nsh.apk")).status).toBe(404);
    expect((await app.request("/downloads/agentlink.apk")).status).toBe(200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
