# @agentlink/daemon

手机远程驾驶舱的 PC 侧常驻进程：托管 codex app-server 子进程，对外提供 `/api/v1` REST + WebSocket，并托管 PWA 静态文件。

## 本地开发

前置：Bun ≥ 1.4、codex CLI ≥ 0.160（已登录 ChatGPT）。

```bash
# 仓库根目录
pnpm install

# 启动 daemon（默认 :8787，可用 AGENTLINK_PORT 覆盖）
pnpm dev            # watch 模式
pnpm start          # 直接运行

# 验证
curl http://127.0.0.1:8787/api/v1/health
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | watch 模式启动 daemon |
| `pnpm build` | 类型检查（tsc --noEmit） |
| `pnpm test` | bun test（单元 + 集成；真连 codex 的用例标 slow，见下） |
| `pnpm --filter @agentlink/daemon test` | 仅 daemon 测试 |

真连 codex 的集成测试：`AGENTLINK_SLOW_TESTS=1 pnpm test`（默认跳过，避免消耗额度）。

## 运行时数据

`~/.agentlink/`：`config.toml`（token / 白名单根目录 / ntfy）、`audit.db`（审批审计，SQLite）。
不写入 `~/.codex`（只读复用其 auth 与 rollout）。
