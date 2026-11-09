import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verify } from "../scripts/toolchain.mjs";

test("toolchain integrity rejects corrupted archives and invalid pins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentlink-nsh-test-"));
  try {
    const file = join(dir, "synthetic-archive");
    await writeFile(file, "synthetic official archive");
    const hash = createHash("sha256").update("synthetic official archive").digest("hex");
    await verify(file, hash);
    await writeFile(file, "corrupted archive");
    await assert.rejects(verify(file, hash), /Checksum mismatch/);
    await assert.rejects(verify(file, "latest"), /Invalid pinned/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
