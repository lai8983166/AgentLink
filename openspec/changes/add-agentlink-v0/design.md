# Design

## Context

全新代码库（greenfield）。已有产物：`design/prototype.html`（六屏视觉/交互基线）、`design/ui-design.md`（决策表 + API 草案）、`design/codex-appserver-notes.md`（app-server 0.160.0 实测协议：thread/turn/item 模型、审批决定枚举、单写者限制、事件清单）。已定技术选型：daemon = Bun + Hono + TS；手机端 = React + Vite PWA（TanStack Query + zustand），API 与前端形态解耦，为安卓原生预留。约束：Windows 10 家用 PC、单用户、目标手机 Android、国内网络环境（无 Google 服务）。

## Goals / Non-Goals

**Goals:**

- 手机端全量 v0 六屏可用：派任务、看流式、批审批、收推送，内外网皆可
- API 契约一次定稿（`/api/v1`），PWA 只是第一个客户端
- daemon 单进程常驻、崩溃可恢复、事件不丢（重连可补）
- 部署可跟做：局域网零配置，外网按文档一小时内搭完

**Non-Goals:**

- 图片/附件上传（v1 再议）
- Claude Code 接入（二期，接口位预留）
- 多用户/权限分级（单用户 token）
- iOS 适配验证、离线模式（在线遥控器形态）
- 端到端加密通道（v0 依赖 TLS + token）

## Decisions

### D1 · 仓库结构：pnpm workspace 三包

```
agentlink/
├─ daemon/          # Bun + Hono + TS
├─ web/             # React + Vite PWA
├─ shared/          # API 类型与事件契约（两端共用 zod schema）
└─ design/ openspec/
```

`shared/` 用 zod 定义 REST/WS 契约并导出 TS 类型，是"前端可替换"约束的落点：原生客户端按同一 schema 对照实现。

### D2 · codex 桥接：单例 app-server 子进程 + thread 复用

daemon 维护**一个** `codex app-server` 子进程（stdio JSON-RPC），全部会话经它 `thread/start` / `thread/resume`。理由：实测单进程多 thread 稳定；`thread/list` 天然一致；进程与内存开销最小。备选（每会话一进程）被否：Windows 下进程开销大、列表需聚合、无隔离收益（都是当前用户权限）。

桥接层职责：JSON-RPC 分帧（按行）、请求-响应匹配、通知按 `threadId` 路由到会话状态机、子进程崩溃自动重启（重启后所有会话回读 rollout 恢复状态）。

### D3 · 事件流：内存环形缓冲 + 单调序号

每会话一个内存 ring buffer（默认 500 条），事件入 buffer 后按订阅广播。客户端重连带 `lastSeq` 补发；超出窗口返回 `SNAPSHOT_REQUIRED`，客户端走 REST 全量拉取。daemon 重启 = 缓冲清空 = 客户端自然走快照。不落盘：rollout 本身就是持久层，无需重复。

### D4 · codex 事件 → 内部事件映射（契约核心）

| codex | 内部事件 | UI 去向 |
|---|---|---|
| `thread/status/changed`（含 waitingOnApproval） | `session.status` | 状态 chip / 动作条 / 横幅 |
| `item/agentMessage/delta` | `agent.delta` | 流式文本 |
| `item/completed`（agentMessage） | `agent.message` | 完整消息 |
| `item/started`/`item/completed`（commandExecution/fileChange） | `tool.started`/`tool.finished` | 工具卡片（exit code/耗时/diff 统计） |
| `item/commandExecution/requestApproval` 等审批 server-request | `approval.request` | 审批卡片 + ntfy |
| `serverRequest/resolved` | `approval.resolved` | 卡片变已决 |
| `thread/queue/changed` | `session.queue` | 排队提示 |
| `thread/tokenUsage/updated` + `account/rateLimits/updated` | `usage.updated` | 额度 pill |
| `item/fileChange/patchUpdated` / `turn/diff/updated` | 挂 `tool.finished.diff` | diff 全屏 |

噪音事件（`mcpServer/*`、`skills/changed`）在桥接层丢弃。审批类 server-request 是 JSON-RPC **请求**而非通知：daemon 先登记、广播、挂起响应，等手机提交决定后再回包给 codex（超时默认不回，随轮次作废）。

### D5 · REST API（/api/v1，Bearer token）

```
GET    /api/v1/status                      连接模式/延迟/额度
GET    /api/v1/sessions                    会话列表（含旧 rollout）
POST   /api/v1/sessions                    新建 {projectPath, approvalPolicy, prompt}
GET    /api/v1/sessions/:id                会话详情 + 历史快照
POST   /api/v1/sessions/:id/resume         恢复（→ SESSION_BUSY）
POST   /api/v1/sessions/:id/message        发消息（排队语义）
POST   /api/v1/sessions/:id/interrupt      中断
PATCH  /api/v1/sessions/:id                切换 approvalPolicy
POST   /api/v1/sessions/:id/approvals/:aid {decision}
GET    /api/v1/fs?path=…                   白名单目录浏览
GET    /api/v1/audit?cursor=…              审计日志
GET    /api/v1/health                      无需认证
WS     /api/v1/ws?token=…&lastSeq=…        全局+会话复用一条连接（订阅消息切换会话）
```

错误码统一 envelope：`{error:{code,message}}`，保留 `SESSION_BUSY` / `APPROVAL_EXPIRED` / `PATH_NOT_ALLOWED` / `UNAUTHORIZED` / `SNAPSHOT_REQUIRED`。WS 用单连接 + 客户端订阅消息（而非每会话一连接），配对/断线逻辑简单，移动网络友好。

### D6 · 认证：单 token + 首次配对

daemon 首次启动生成随机 token 存 `~/.agentlink/config.toml`，CLI 打印二维码/文本供手机一次性录入；`agentlink token rotate` 轮换。REST 走 `Authorization: Bearer`，WS 走查询参数（浏览器 WS 不能带 header）。轮换后旧 token 立即失效。审批操作本身是安全第二道防线：即使 token 泄露，删文件/执行命令仍需手机点批准（策略 untrusted/on-request 下）。

### D7 · 审计与配置存储

`~/.agentlink/`：`config.toml`（token、白名单根目录、ntfy 地址、主题前缀）+ `audit.db`（bun:sqlite，append-only 表）。不进 `~/.codex`，避免污染 codex 状态。

### D8 · PWA 技术要点

- 路由 BrowserRouter + daemon SPA fallback（局域网/外网同源部署，无需 hash 路由）
- `vite-plugin-pwa`：manifest + 静态资源预缓存；**API 永不缓存**
- TanStack Query 管列表/详情轮询兜底，WS 事件驱动 invalidate；zustand 存 UI 态（滚动跟随、订阅中的会话）
- 深链格式 `/<sessionId>?approval=<id>`，ntfy 通知点击经此直达
- 视觉：直接移植 `prototype.html` 的 design tokens（CSS 变量搬进 `theme.css`），不引 UI 组件库

### D9 · 外网链路：frp + Caddy + ntfy 同居 VPS

```
手机 ─HTTPS/WSS→ VPS[Caddy:443] ─反代→ frps ↔ frpc(PC) ↔ daemon
                                    └→ ntfy(:80 自用, 仅 VPS 本机反代)
```

Caddy 自动 Let's Encrypt（需一个域名，解析到 VPS）。备案顾虑的替代路线：域名走非标端口（如 :8443）规避 80/443 备案检查，文档两种都写。ntfy 手机端直接订阅自建服务器地址。

### D10 · 测试策略

- `shared/` schema 单测
- daemon：桥接层用**录制回放**（把摸底脚本的真事件流存为 fixture）做单测；REST/WS 用 Hono app 级集成测试（mock 桥接）
- 真连 codex 的集成测试标记 `slow`，复用 `design/spike/` 驱动逻辑，CI 可跳过
- web：Vitest + Testing Library，覆盖状态机映射与审批卡片交互

## Risks / Trade-offs

- [app-server 协议是 experimental，升级可能破坏] → 协议版本锁定 0.160.0 写进文档；桥接层集中一处做协议适配（`protocol.ts`），升级只改一个文件；schema 生成物入库做 diff 告警
- [Bun on Windows 偶发兼容问题] → Hono 应用层与运行时解耦，紧急时可平移到 Node（构建脚本双跑）；开发期优先暴露问题
- [Windows 休眠/睡眠导致掉线] → daemon 调 `SetThreadExecutionState` 保活（可选开关）；掉线本身由重连 + 快照兜底
- [ring buffer 溢出导致频繁全量拉取] → 窗口 500 条对单用户足够；快照接口带增量游标，成本可控
- [token 经 WS 查询参数可能进日志] → daemon 日志脱敏；token 可轮换；文档提示
- [frp 中继单点（VPS 宕机外网不可达）] → 局域网通道不受影响；文档提供 frps 健康检查与重启脚本；接受单点（自用）
- [codex 单写者：IDE 开着的会话无法接管] → 属实且无法绕过（rollout 锁语义）；映射 SESSION_BUSY 并在 UI 友好提示，是产品行为而非缺陷

## Migration Plan

全新部署，无存量迁移。发布顺序：daemon 先行（含 API），web 构建产物由 daemon 托管，单 `pnpm build` 出全量。回滚 = 切回上一构建产物目录（保留上一版本 release 目录，启动脚本指版本号）。codex 侧无任何写入，随时可退回纯 IDE 使用。

## Open Questions

- VPS 供应商与域名备案路线（标准 443 vs 非标端口）——部署阶段按文档二选一即可，不影响代码
- ntfy 自托管是否加简单鉴权（v0 局域网内网访问 + 随机主题名，够用；后续可加 basic auth）
- `acceptWithExecpolicyAmendment` 类高级决定是否在 UI 暴露（v0 折叠不展示，契约已预留）
