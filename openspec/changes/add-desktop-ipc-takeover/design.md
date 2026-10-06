# Design

## Context

v0 daemon 已有 app-server 适配器（自建会话）与事件总线/审批/审计全套域服务。`design/desktop-takeover-verification.md` 实测确认桌面端 IPC：`\\.\pipe\codex-ipc`，4 字节小端长度前缀 + JSON 帧；消息类型 `request`/`response`/`broadcast`/`client-discovery-*`；关键方法 `initialize`（返回 clientId）、`thread-owner-discovery`（v1，返回 handledByClientId）、follower 委托 `thread-follower-start-turn`（v2）/`thread-follower-interrupt-turn`（v4，带 expectedTurnId）/`thread-follower-command-approval-decision`（v1）；订阅经定向 broadcast `thread-stream-following-changed`（需周期续订，探测脚本 ~15s 一次）；状态经 broadcast 下发（`params.change.type==='snapshot'` → `conversationState`：`turnHistory.history.entitiesByKey`、`requests[]`、`latestThreadSettings`）。steer、网络重连、桌面退出交接未实测，列为实现期验证项。协议参考实现 `design/spike/desktop-ipc-probe.mjs`。

## Goals / Non-Goals

**Goals:**

- 桌面持有会话：观察 + 原会话接管 + 审批代办 + 中断，手机端体验与自建会话一致
- 桌面关闭 / IPC 不可用时的连续体验（回退 resume，兜底 fork）
- 内部接口漂移可检测、可降级、不静默

**Non-Goals:**

- 桌面端 UI 反向显示（让 ChatGPT 桌面实时渲染手机会话——桌面不订阅外部流，超出 IPC 能力）
- 修改桌面端行为或注入 UI
- 跨网络直连桌面管道（外网仍经 frp 连 daemon，IPC 永远在本机）

## Decisions

### D1 · IpcClient：帧协议客户端（独立于域层）

`daemon/src/ipc/client.ts`：Node `net.connect('\\\\.\\pipe\\codex-ipc')`，长度前缀分帧、request/response 按 requestId 匹配（复用 JsonRpcConnection 的模式但消息形态不同：`{type:'request',requestId,sourceClientId,version,method,params,targetClientId,timeoutMs}`）、broadcast 分发、`client-discovery-request` 自动回应 `canHandle:false`。断线指数退避重连。可注入 socket 工厂测试。

### D2 · FollowerSession：单会话跟随器

`daemon/src/ipc/follower.ts`：每个被观察/接管的桌面会话一个实例。职责：
- `discover()`：thread-owner-discovery → handledByClientId（失败抛 `IPC_OWNER_NOT_FOUND`，触发兜底）
- following 续订：每 10s 重发 `thread-stream-following-changed following:true`（探测脚本验证 15s 内有效，取 10s 留余量）
- 快照/增量 → 内部事件（见 D3）；revision 单调校验，跳跃即重取快照
- 操作委托：startTurn/interrupt/approvalDecision（带 targetClientId=owner）
- 桌面关闭：管道断或 owner 反复 discovery 失败 → 发 `session.status` 事件 + 标记 `desktopGone`，registry 引导 resume

### D3 · conversationState → 内部事件映射

`turnHistory.history.entitiesByKey` 的 turn（turnId/status/items[]）与顶层 `requests[]` 差分映射为既有事件流：新 turn → `session.status running`；agentMessage item → `agent.message`（含文本）；commandExecution item 状态迁移 → `tool.started/finished`（exit code 从 item 提取）；turn 终态 → `session.status done/error/idle`；`requests[]` 新增 → `approval.request`（requestId、command、可用决定），消失/已决 → `approval.resolved`。纯函数 + fixture 单测（复用探测脚本保存的快照样例）。

### D4 · start-turn 请求构造

按探测脚本验证的形态：取快照中最近一次 turn 的请求参数为模板（模型/设置），替换 `input`（文本 + `text_elements:[]`）、`clientUserMessageId`（**手机端生成的 UUID，幂等键**——重试同 ID 不产生重复轮次）、`context:{inheritThreadSettings:false}`，审批策略显式传入。缺模板（空会话）时用最小默认参数并在真实桌面 slow 测试里补验。

### D5 · 会话归属路由（registry 集成）

`SessionRegistry` 三态路由：`live`（app-server 自建）→ 既有链路；`desktop`（activeElsewhere 且接管/观察中）→ FollowerSession；其余 → rollout/idle（resume 链路）。REST 新增：
- `POST /api/v1/sessions/:id/observe`（建立 follower，订阅事件）
- `POST /api/v1/sessions/:id/takeover`（observe + 标记接管态，输入框解禁）
- `POST /api/v1/sessions/:id/fork`（兜底接力；返回新会话 id，带 forkedFromId）
接管态下发消息/审批/中断改走 follower 委托；`SESSION_BUSY` 仅在 IPC 不可用且未接管时返回。

### D6 · 审批桥接与去重幂等

`requests[]` 差分检测：新 requestId → 登记 + `approval.request` 事件 + ntfy（复用既有 onRequest 钩子，去重键 `desktop:<requestId>`）。提交决定 → 委托 `thread-follower-command-approval-decision`；**幂等表**记录 `requestId → 首次决定`，重复提交同决定返回成功，不同决定返回 `APPROVAL_ALREADY_DECIDED`。审计照常落库（source 标 `desktop-delegate`）。

### D7 · 前端

- busy 会话页 = 观察模式（自动 observe）+ 顶部「接管此会话」按钮（takeover）
- 接管后输入框/审批/中断解禁；事件流复用既有渲染
- `desktopGone` → 提示改「桌面端已关闭，可直接接管」并走 resume
- fork 兜底入口 + 谱系：会话卡片/详情显示 `forkedFromId` 来源标注；打开有后代的旧会话显示「最新进展在 →」横幅（后代关系由 daemon 从 thread/list 的 forkedFromId 反向索引）

### D8 · 兼容性防护

IPC initialize 后记录对端信息（含 `codex-cli 0.160.0` 基线）到日志与 `~/.agentlink/` 状态文件；slow 测试（`AGENTLINK_SLOW_TESTS=1`）跑只读 discovery + 快照字段存在性断言（title/turnHistory/requests/latestThreadSettings），字段缺失 → 明确 `IPC_INCOMPATIBLE` 错误 + UI 引导兜底。

## Risks / Trade-offs

- [内部 IPC 无稳定性承诺，桌面升级即断] → D8 版本记录 + slow 回归 + 明确错误码 + fork/resume 双兜底；升级桌面后第一时间的可观测失败
- [following 续订失败导致假死] → 续订 ack 超时即重 discovery；连续失败按桌面关闭处理
- [revision/差分映射遗漏对话形态（MCP 工具、多模态）] → 映射器对未知 item 类型降级为通用占位卡片，不丢轮次结构；fixture 补充
- [start-turn 模板法在空会话/特殊设置下不稳] → 真实桌面 slow 测试覆盖；失败时提示走 fork
- [审批双端竞态（桌面同时批）] → 委托决定以先到为准，幂等表吸收重复；UI 显示已决状态
- [管道本机任意进程可连] → 威胁模型不变（本机即信任域，daemon 同权）；对外仍只有 token 网关

## Migration Plan

纯新增能力，无存量迁移。发布顺序：daemon IPC 层先行（observe 只读可独立验证）→ takeover 桥接 → 前端。回滚 = 不调用新端点，v0 行为不变。

## Open Questions

- `thread-follower-steer`（运行中改指令）是否存在于当前桌面版本——实现期探测，存在则顺带暴露
- 空会话 start-turn 最小参数形态——D4 预留，slow 测试定稿
- VS Code 扩展持有的会话是否同样接入 codex-ipc（桌面已验证；VS Code 侧实现期验证，预期同管道）
