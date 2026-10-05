import type { CodexTransport, CodexTransportFactory } from "../codex/process";

/** 测试用假 codex app-server：可编程响应 + 可注入推送 */
export class FakeCodexServer implements CodexTransportFactory {
  written: string[] = [];
  private onData: ((c: string) => void) | null = null;

  create(onData: (c: string) => void): CodexTransport {
    this.onData = onData;
    return {
      write: (line) => {
        this.written.push(line);
        this.handle(line);
      },
      kill: () => {},
      onExit: () => {},
    };
  }

  private handle(line: string): void {
    const msg = JSON.parse(line);
    if (typeof msg.id === "number" && msg.method) {
      const results: Record<string, unknown> = {
        initialize: { userAgent: "fake" },
        "thread/start": { thread: { id: "t1", environments: [{ cwd: "F:/x" }] } },
        "thread/list": {
          data: [
            {
              id: "old1",
              preview: "查看此项目的进展",
              cwd: "F:/project/chaomofa",
              environments: [{ cwd: "F:/project/chaomofa" }],
              updatedAt: Math.floor(Date.now() / 1000), // 刚刚活跃 → activeElsewhere
            },
          ],
        },
        "thread/resume": { thread: { id: "t1" } },
        "turn/start": { turn: { id: "turn1" } },
        "turn/interrupt": {},
        "thread/turns/list": {
          data: [
            {
              id: "turn-old",
              items: [
                { type: "userMessage", id: "u1", content: [{ type: "text", text: "旧会话第一条" }] },
                { type: "agentMessage", id: "a1", text: "收到" },
                {
                  type: "commandExecution",
                  id: "e1",
                  command: "pnpm build",
                  exitCode: 0,
                  aggregatedOutput: "done",
                },
              ],
            },
          ],
        },
      };
      const result = results[msg.method] ?? {};
      const err =
        msg.method === "thread/resume" && msg.params?.threadId === "busy"
          ? { code: -32600, message: "thread busy already has an active writer" }
          : undefined;
      this.send(err ? { jsonrpc: "2.0", id: msg.id, error: err } : { jsonrpc: "2.0", id: msg.id, result });
    }
  }

  /** 模拟 codex 推送（通知或请求） */
  send(obj: unknown): void {
    this.onData?.(`${JSON.stringify(obj)}\n`);
  }

  /** 便捷：推送一条通知 */
  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }
}
