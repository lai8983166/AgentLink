# codex app-server 摸底实录

> 2026-10-05 · codex-cli **0.160.0** · Windows 10 · Node 24
> 方法：`codex app-server generate-json-schema` 提取协议 + stdio JSON-RPC 真连接测试（脚本在本目录 `drive.mjs` / `resume.mjs` / `approval.mjs`）
> 结论先行：**v0 全部技术假设成立，无阻塞项**。

## 一、核心结论

| 验证项 | 结果 |
|---|---|
| 认证复用 | ✅ 直接吃现有 `~/.codex/auth.json`（ChatGPT 登录态），**免登录**；`account/updated` 事件回报 `planType:"plus"` |
| 旧会话列表 | ✅ `thread/list` 一页列出全部 **55 个历史会话**（VS Code / Codex Desktop 产生的 rollout 全部在内，含中文 preview） |
| 旧会话恢复 | ✅ `thread/resume` + `thread/turns/list` 成功读出旧会话完整历史（10 turns，userMessage/agentMessage 内容完整） |
| 流式输出 | ✅ `item/agentMessage/delta` 逐段推送，`item/completed` 带全文 |
| 审批流 | ✅ 见下文，完整闭环实测通过 |
| 状态机 | ✅ `thread/status/changed`: `active` / `active+waitingOnApproval` / `idle`，与 UI 状态机直接对应 |
| 用量/限额 | ✅ `thread/tokenUsage/updated` + `account/rateLimits/updated`（可在 UI 显示额度百分比） |
| 传输方式 | `--listen` 支持 `stdio://`（默认）/ `ws://IP:PORT` / `unix://`，daemon 可自选 |

## 二、生命周期映射（UI → app-server）

| AgentLink 操作 | JSON-RPC 方法 | 备注 |
|---|---|---|
| 新建会话 | `thread/start` `{cwd, model?, sandbox, approvalPolicy}` | 返回 `result.thread.id`（注意嵌套在 `thread` 里） |
| 发消息 | `turn/start` `{threadId, input:[{type:'text',text}]}` | 返回 turn id；`input` 是数组（支持多段/附件） |
| 中断 | `turn/interrupt` `{threadId}` | |
| 会话列表 | `thread/list` `{cursor,limit}` → `result.data[]` | 含 `id/preview/sessionId/environments[].cwd`；实测一页 55 条 |
| 恢复旧会话 | `thread/resume` `{threadId}` | 空闲会话直接成功 |
| 读历史 | `thread/turns/list` `{threadId,cursor,limit}` → `turns[].items[]` | items 类型见下 |
| 结束/归档 | `thread/archive` / `thread/delete` | |

`thread/start` 常用参数：`sandbox: read-only | workspace-write | danger-full-access`；`approvalPolicy: untrusted | on-request | never`（另有 granular 对象可细粒度控制）。

## 三、事件映射（手机端渲染所需）

| UI 元素 | 通知 | payload 要点 |
|---|---|---|
| 状态 chip / 动作条 | `thread/status/changed` | `{threadId, status:{type: active\|idle, activeFlags:["waitingOnApproval"]}}` |
| 流式文本 | `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` |
| 完整消息 | `item/completed` | item.type: `agentMessage`(text) / `userMessage` |
| 工具卡片·命令 | `item/started`+`item/completed` | item.type `commandExecution`，带 `command`、aggregatedOutput |
| 工具卡片·文件 | 同上 | item.type `fileChange`（详见 `item/fileChange/patchUpdated`） |
| 命令实时输出 | `item/commandExecution/outputDelta` | base64 流 |
| diff 更新 | `turn/diff/updated` / `item/fileChange/patchUpdated` | |
| 思考摘要 | `item/reasoning/summaryTextDelta` | 可选展示 |
| 消息排队指示 | `thread/queue/changed` | UI"运行中输入排队"的依据 |
| token 用量 | `thread/tokenUsage/updated` | cachedInputTokens 等 |
| 账户限额 | `account/rateLimits/updated` | usedPercent / resetsAt，可做首页额度 pill |

噪音过滤：`mcpServer/startupStatus/updated`（cua_repl/node_repl 等启动刷屏）、`skills/changed` 可忽略。

## 四、审批协议（实测闭环）

**触发**：策略 `untrusted`（或 agent 主动）→ server 主动请求（带 id，需回 result）：

```
method: item/commandExecution/requestApproval
params: { kind:"command", threadId, turnId, itemId,
          command, cwd, commandActions[],
          proposedExecpolicyAmendment?,
          availableDecisions: [...] }   // ← 动态！按此渲染按钮
```

**决定**（`CommandExecutionApprovalDecision`）：
- `accept` / `acceptForSession`（= UI"本会话不再询问"）/ `decline`（拒绝但 agent 继续）/ `cancel`（拒绝并中断）
- 高级：`acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment`

**文件改动审批**：`item/fileChange/requestApproval`，决定 `accept/acceptForSession/decline/cancel`。

**实测时序**：审批请求 → 回 `acceptForSession` → `serverRequest/resolved` → status 从 `waitingOnApproval` 回 `active` → 命令执行 → `item/completed` → agent 总结 → `idle`。整个链路 < 10s。

⚠️ `availableDecisions` 是**按场景动态给的**（实测该场景只给了 accept/amendment/cancel，但回 `acceptForSession` 也被接受）。daemon 应按列表渲染按钮，未知选项隐藏。

## 五、会话继承 & 单写者

> 2026-10-06 补充：下述冲突是独立 app-server 恢复会话的限制，不能推导出只能 fork。已通过官方桌面本地 IPC follower 接口实测原会话发指令、状态同步、审批与中断，见 [接管验证记录](desktop-takeover-verification.md)。

- 列表/恢复/读历史三级全部验证通过：VS Code（`source:"vscode"`）与 Codex Desktop 的会话和 CLI/app-server **共用 `~/.codex/sessions` rollout**，同一套 thread id。
- ⚠️ **单写者**：会话若正被 VS Code / 桌面应用占用，`thread/resume` 报 `-32600 "already has an active writer"`。daemon 必须优雅处理：UI 显示"会话正在电脑上使用中"，或提示先在 IDE 关闭。
- 附注：`codex migrate-rollouts` 可将 legacy rollout 迁到分页 thread history（本机已是新格式，未用到）。

## 六、其他发现

- **`codex agents`** 子命令：浏览"共享本地 app-server daemon"上的会话 → 桌面应用/IDE 与 CLI 可能共用一个常驻 daemon；AgentLink 的 daemon 可以选择（a）自起独立 `codex app-server` 进程（隔离、简单，推荐 v0），或（b）attach 现有 daemon（`app-server proxy`）。
- `remoteControl/status/changed` 通知（status:"disabled"）→ codex 自带 remote-control 机制（`codex remote-control` 子命令），AgentLink 做自己的通道（frp）不冲突，但值得后续调研是否可复用。
- 旧版方法并存：`execCommandApproval`/`applyPatchApproval` 是 deprecated 风格，新代码用 `item/*` 系列。
- `thread/start` 时 MCP servers（cua_repl 等）会启动并推送状态，属于正常噪音。

## 七、对 daemon 设计的直接输入

1. 与 app-server 的连接：v0 用 **stdio + 自起进程**（每会话独立 or 单进程多 thread 均可）；`ws://` 备用于前后端同机调试。
2. UI 三档审批策略映射：每次询问 → `untrusted`；失败时询问 → `on-request`（codex 默认）；全自动 → `never`。
3. WS 事件契约（ui-design.md 第五节）需按本笔记第三节重命名对齐（`session.status` → `thread/status/changed` 等），在 OpenSpec 提案里定稿。
4. 会话卡片可直接显示 `thread/list` 的 `preview` + `environments[].cwd` + `tokenUsage` + 限额百分比。

## 附录：摸底产物

- `spike/schema/` — 39 个协议 Schema 文件（`codex app-server generate-json-schema`）
- `spike/drive.mjs` — 基础链路：initialize → thread/start → turn/start → 事件流
- `spike/resume.mjs` — thread/list 翻页 + 旧会话 resume + 历史读取
- `spike/approval.mjs` — 审批触发 + acceptForSession 回应闭环

## 八、外部会话实时性判定（2026-10-06 补充实验）

问题：手机端能否实时看到 ChatGPT 桌面端 / VS Code 正在运行的会话活动？

**实验**（`spike/live-probe.mjs`，双通道对照，目标会话正在执行任务）：
- 协议通道：`thread/read` 只读加载 busy 会话成功（不报 writer 错），但 **120s 内 0 条会话事件**
- 文件通道：rollout 同期增长 ~60KB，事件词汇与 mapper 同构（`event_msg/item_completed`、`response_item/custom_tool_call*`、`token_count`）

**证据链结论**：
1. 桌面端的 codex.exe 为 stdio 子进程，无监听端口（netstat 验证）→ 无法接入其后端
2. `~/.codex/app-server-control/` 不存在 → 桌面端不使用托管共享 daemon
3. `thread/read` 不跨进程转发事件 → 协议层无外部会话实时通道
4. **rollout 文件直读（watcher）是唯一实时桥梁**，数据完备
5. `thread/fork` 可在 busy 会话上随时创建继承全部历史的新会话（writer 归调用方）→ 接力接管的官方通道

> **更正（2026-10-06 晚）**：上文"rollout 是唯一实时桥梁"的结论**不成立**。`design/desktop-takeover-verification.md` 证实桌面端另有命名管道 IPC（`\.\pipe\codex-ipc`，4 字节小端长度前缀 + JSON），支持 `thread-owner-discovery` 发现会话拥有者 + follower 委托模式：外部客户端可对**原会话**（非 fork）发指令、收 snapshot/patches 实时同步、代批审批、中断——已在真实会话上全部实测通过。IPC 通道优先；rollout watcher 降级为管道不可用时的兜底；fork 降为 owner 发现失败时的兜底。注意：此为内部接口，桌面版升级需回归测试。
