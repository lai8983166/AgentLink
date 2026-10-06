# Proposal

## Why

v0 已建成"AgentLink 自建会话"的完整遥控链路，但用户多数会话诞生在官方桌面端 / VS Code——这些会话目前只能看徽章和快照，不能接管（单写者），fork 接力又牺牲"同一会话"。`design/desktop-takeover-verification.md` 已实测：桌面端经 `\\.\pipe\codex-ipc` 命名管道提供 follower 委托模式，外部客户端可对**原会话**发指令、收实时 snapshot/patches、代办审批、中断，全程会话 ID 不变。把这条通道产品化，用户的完整场景（晚上电脑启动任务 → 白天手机看进度/审批/续指令 → 回家电脑看结果继续）即全部成立。

## What Changes

- daemon 新增**桌面 IPC follower 适配器**：连接 `\\.\pipe\codex-ipc`，`thread-owner-discovery` 发现会话拥有者，以 follower 身份订阅 snapshot/patches 实时同步，委托 `thread-follower-start-turn` / `thread-follower-interrupt-turn` / `thread-follower-command-approval-decision` 操作原会话
- 新增**会话归属路由**：AgentLink 自建会话走 app-server 适配器；桌面持有会话走 IPC follower；桌面关闭（owner 消失）自动回退 app-server resume
- 手机端 REST/WS 桥接：busy 会话从"只提示占用"升级为**可观察 + 可接管 + 双向同步**；接管后发消息、审批、中断全部经 daemon 委托，原会话 ID 不变
- 审批桥接强化：桌面端发起任务的审批请求在手机端可批，含去重与幂等提交
- **fork 降级为兜底**（owner 发现失败 / 管道不可用时），并补齐接力谱系提示（B 标注"从 A 接力"、A 提示"最新进展在 B"）
- 断线恢复：daemon↔管道断线自动重连 + 快照重建 + revision 校验防错序
- 内部接口风险防护：桌面版本握手记录 + 兼容性回归测试（slow）+ 字段缺失时明确降级

## Capabilities

### New Capabilities

- `desktop-session-takeover`: 桌面持有会话的原会话接管——拥有者发现、follower 订阅实时同步、委托发指令/审批/中断、断线恢复、桌面关闭回退、fork 兜底与谱系、内部接口兼容性防护

### Modified Capabilities

（无——`session-management` / `approval-flow` 等能力的正式 spec 尚未从 add-agentlink-v0 归档入库，本变更不直接改动其 delta；接管行为对路由的集成要求全部收敛在新能力内，归档时合并）

## Impact

- **代码**：`daemon/src/ipc/`（新模块：pipe 客户端、framing、follower 协议）、`daemon/src/domain/sessions.ts`（归属路由与回退）、`daemon/src/routes/api.ts`（takeover/fork 端点）、`web/`（观察页 + 接管/接力 UI + 谱系提示）
- **依赖**：Node `net`（命名管道），无新增第三方依赖
- **系统**：连接桌面端内部 IPC（`\\.\pipe\codex-ipc`）——非承诺稳定的内部接口，桌面版升级需回归
- **既有产物**：`design/desktop-takeover-verification.md`（实测依据）、`design/spike/desktop-ipc-probe.mjs`（协议参考实现，复用为 slow 测试基础）
