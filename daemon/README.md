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

## 管理 CLI

```bash
bun run daemon/src/cli.ts token           # 查看配对 token
bun run daemon/src/cli.ts token rotate    # 轮换 token（写文件；运行中 daemon 用 API 轮换即时生效）
bun run daemon/src/cli.ts config          # 配置概览（token 脱敏）
bun run daemon/src/cli.ts roots           # 查看白名单根目录
bun run daemon/src/cli.ts roots add F:/project   # 添加白名单根
```

## 配置说明（~/.agentlink/config.toml）

| 键 | 默认 | 说明 |
|---|---|---|
| `token` | 首次生成 | 手机配对凭据；`POST /api/v1/admin/token/rotate` 轮换即时生效 |
| `port` | 8787 | HTTP/WS 监听端口（环境变量 `AGENTLINK_PORT` 可覆盖） |
| `keepAlive` | true | Windows 下阻止系统休眠（外网遥控不断线） |
| `allowedRoots` | `~/project` | 会话工作目录白名单（fs 浏览 + projectPath 校验） |
| `[ntfy] enabled` | false | 推送总开关；关闭不影响主链路 |
| `[ntfy] url` | — | 自托管 ntfy 基地址 |
| `[ntfy] topicPrefix` | agentlink | 主题前缀；实际主题 `-approval`（最高优先级）/ `-task` |
| `[ntfy] clickBase` | — | 点击通知跳转的 PWA 对外地址 |

## API 一览（/api/v1，Bearer token）

```
GET    /status /sessions /sessions/:id /fs?path= /audit?cursor= /health(免认证)
POST   /sessions   {projectPath, approvalPolicy, prompt}
POST   /sessions/:id/resume | /message {text} | /interrupt
PATCH  /sessions/:id {approvalPolicy}
POST   /sessions/:id/approvals/:aid {decision}
POST   /admin/token/rotate
WS     /ws?token=…（订阅消息切换会话，lastSeq 断线补发）
```

错误 envelope：`{error:{code,message}}`；`SESSION_BUSY`（会话被 IDE 占用）、`APPROVAL_EXPIRED`（审批已作废）、`PATH_NOT_ALLOWED`（越出白名单）、`SNAPSHOT_REQUIRED`（事件超出保留窗口，需全量拉取）。

## 运行时数据

`~/.agentlink/`：`config.toml`（token / 白名单根目录 / ntfy）、`audit.db`（审批审计，SQLite）。
不写入 `~/.codex`（只读复用其 auth 与 rollout）。
codex 协议版本锁定 0.160.0（`src/codex/protocol.ts` 为唯一适配层）。
