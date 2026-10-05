# Spec Delta

## Purpose

管理 PC 上 codex 会话的完整生命周期：新建、列出（含既有 VS Code/Codex Desktop 会话）、恢复、发送消息、中断与状态跟踪，使远程客户端可以像在电脑前一样驱动 agent。

## ADDED Requirements

### Requirement: 会话列表
系统 SHALL 返回全部会话集合，包括本系统创建的会话与 codex 既有会话（VS Code / Codex Desktop 产生）。每条会话 SHALL 含：会话 id、标题/首条消息预览、工作目录、agent 标识、当前状态、最近活动时间、token 用量。

#### Scenario: 列出含旧会话的完整列表
- **WHEN** 客户端请求会话列表
- **THEN** 返回 PC 上 `~/.codex/sessions` 中全部会话与新创建会话，含预览文本与工作目录

#### Scenario: daemon 重启后会话不丢失
- **WHEN** daemon 重启后请求会话列表
- **THEN** 既有会话仍完整列出，状态可恢复识别

### Requirement: 新建会话
系统 SHALL 接受工作目录、审批策略与任务描述，创建会话并立即开始执行。工作目录 MUST 在配置的白名单根目录内。

#### Scenario: 创建成功
- **WHEN** 提交合法的 `{projectPath, approvalPolicy, prompt}`
- **THEN** 返回新会话 id，会话进入 running 状态并开始产出事件

#### Scenario: 白名单外路径被拒绝
- **WHEN** 提交的 projectPath 不在白名单内
- **THEN** 返回明确的错误响应，不创建会话

### Requirement: 恢复既有会话
系统 SHALL 支持按会话 id 恢复 codex 既有会话，并返回完整历史消息与工具调用记录，恢复后可继续对话。

#### Scenario: 恢复空闲的旧会话
- **WHEN** 对一个无活动写入者的旧会话请求恢复
- **THEN** 返回完整历史，且可继续发送消息

#### Scenario: 恢复被占用的会话被拒绝
- **WHEN** 目标会话正被 VS Code / Codex Desktop 使用（单写者冲突）
- **THEN** 返回特定错误码 `SESSION_BUSY`，客户端可提示"会话正在电脑上使用中"

### Requirement: 发送消息
系统 SHALL 接受对指定会话的文本消息。会话空闲时消息立即触发新轮次；会话运行中时消息 SHALL 进入队列，待当前轮次结束后依次发送。

#### Scenario: 空闲会话立即响应
- **WHEN** 会话处于 idle 且用户发送消息
- **THEN** 立即开始新轮次

#### Scenario: 运行中消息排队
- **WHEN** 会话 running 且用户发送消息
- **THEN** 消息入队并产生队列变化事件，当前轮次完成后按序发出

### Requirement: 中断当前轮次
系统 SHALL 支持中断指定会话的当前轮次，agent 停止后续动作，会话回到可交互状态。

#### Scenario: 中断执行中的任务
- **WHEN** 会话 running 且用户请求中断
- **THEN** 当前轮次终止，产生中断确认，会话回到 idle

### Requirement: 会话状态机
系统 SHALL 为每个会话暴露五种状态：`running` / `waiting_approval` / `done` / `error` / `idle`，状态由 codex 事件映射（审批挂起标志 → `waiting_approval`，审批解决 → 回 `running`），并随事件流实时更新。

#### Scenario: 审批挂起改变状态
- **WHEN** codex 报告会话带 waitingOnApproval 标志
- **THEN** 会话状态变为 `waiting_approval` 并推送状态事件

#### Scenario: 出错进入 error
- **WHEN** 会话轮次以错误结束
- **THEN** 状态变为 `error` 且错误信息可被客户端读取

### Requirement: 用量与限额可见
系统 SHALL 暴露每会话 token 用量（含缓存命中）与账户限额使用百分比、重置时间，数据来自 codex 事件。

#### Scenario: 额度推送
- **WHEN** codex 报告限额更新事件
- **THEN** 客户端可读取最新使用百分比与重置时间
