import { dlopen, FFIType } from "bun:ffi";

/**
 * Windows 保活（任务 6.3 的一部分）：阻止系统休眠，防止外网遥控时掉线。
 * bun:ffi 在本进程内调 SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)。
 */
export function keepAlive(enabled: boolean): void {
  if (!enabled || process.platform !== "win32") return;
  try {
    const kernel32 = dlopen("kernel32.dll", {
      SetThreadExecutionState: {
        args: [FFIType.u32],
        returns: FFIType.u32,
      },
    });
    const ES_CONTINUOUS = 0x80000000;
    const ES_SYSTEM_REQUIRED = 0x00000001;
    kernel32.symbols.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    console.log("[daemon] keepAlive 已启用（阻止系统休眠）");
  } catch (e) {
    console.warn("[daemon] keepAlive 启用失败:", e);
  }
}
