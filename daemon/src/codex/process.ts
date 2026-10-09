import type { Subprocess } from "bun";

/**
 * codex app-server 子进程传输层（任务 3.2 的一部分）。
 * 生产传输：spawn `codex app-server`，把 stdout 行喂给回调。
 * 与桥接层解耦，便于测试注入假传输。
 */
export interface CodexTransport {
  write(line: string): void;
  kill(): void;
  /** 进程退出（code/signal） */
  onExit(cb: (code: number | null) => void): void;
}

export interface CodexTransportFactory {
  create(onData: (chunk: string) => void): CodexTransport;
}

/** 生产工厂：真实 spawn codex app-server */
export function createRealTransportFactory(): CodexTransportFactory {
  return {
    create(onData) {
      const proc: Subprocess = Bun.spawn(["cmd", "/c", "codex", "app-server"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            onData(decoder.decode(value, { stream: true }));
          }
        } catch {
          /* 流关闭 */
        }
      })();
      // stderr 只做低频日志，防止刷屏
      let stderrBuf = "";
      const errDecoder = new TextDecoder();
      const errReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      (async () => {
        try {
          for (;;) {
            const { done, value } = await errReader.read();
            if (done) break;
            stderrBuf += errDecoder.decode(value, { stream: true });
            const lines = stderrBuf.split("\n");
            stderrBuf = lines.pop() ?? "";
          }
        } catch {
          /* ignore */
        }
      })();

      const utf8 = new TextEncoder();
      const stdin = proc.stdin as import("bun").FileSink;
      return {
        write(line) {
          stdin.write(utf8.encode(`${line}\n`));
          stdin.flush();
        },
        kill() {
          proc.kill();
        },
        onExit(cb) {
          proc.exited.then((code) => cb(code)).catch(() => cb(null));
        },
      };
    },
  };
}
