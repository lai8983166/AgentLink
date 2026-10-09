import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoThreadWriter } from "./writer-lock";

let fixture: string | undefined;
afterEach(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); fixture = undefined; });

describe.skipIf(process.platform !== "win32")("Windows 原会话写入锁只读核验", () => {
  test("缺失锁文件可恢复，空闲旧锁不会被删除；持有文件句柄时拒绝", async () => {
    fixture = mkdtempSync(join(tmpdir(), "al-writer-probe-"));
    mkdirSync(join(fixture, "thread-writer-locks"));
    await assertNoThreadWriter("missing-thread", fixture);
    const lock = join(fixture, "thread-writer-locks", "test-thread.lock");
    writeFileSync(lock, "probe-fixture");
    await assertNoThreadWriter("test-thread", fixture);
    const handle = openSync(lock, "r+");
    try { await expect(assertNoThreadWriter("test-thread", fixture)).rejects.toMatchObject({ code: "SESSION_BUSY" }); }
    finally { closeSync(handle); }
    expect(readFileSync(lock, "utf8")).toBe("probe-fixture");
    await assertNoThreadWriter("test-thread", fixture);
  }, 20000);
  test("缺少锁目录或非法 ID 都不能当成已释放", async () => {
    fixture = mkdtempSync(join(tmpdir(), "al-writer-probe-"));
    await expect(assertNoThreadWriter("test-thread", fixture)).rejects.toMatchObject({ code: "IPC_UNAVAILABLE" });
    await expect(assertNoThreadWriter("../escape", fixture)).rejects.toMatchObject({ code: "IPC_UNAVAILABLE" });
  });
});
