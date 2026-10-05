# Spec Delta

## Purpose

为已认证客户端提供按会话订阅的 WebSocket 实时事件流，是手机端"当前动作常显、流式输出、审批直达"的数据基础。

## ADDED Requirements

### Requirement: 按会话订阅事件流
系统 SHALL 提供 WebSocket 端点，客户端认证后可订阅/退订单个会话的事件流；同一会话允许多个并发订阅（多设备同时看）。

#### Scenario: 订阅后收到实时事件
- **WHEN** 客户端订阅一个 running 会话
- **THEN** 此后该会话的状态、消息与工具事件实时推送到该客户端

#### Scenario: 未认证订阅被拒绝
- **WHEN** WebSocket 连接未携带有效 token
- **THEN** 连接被拒绝并关闭，返回认证错误

### Requirement: 事件类型契约
事件流 SHALL 覆盖以下类型（载荷以内部契约定义为准）：`session.status`（状态机变化）、`agent.delta`（流式文本增量）、`agent.message`（完整消息）、`tool.started` / `tool.finished`（工具卡片，含 exit code、耗时、diff 统计）、`approval.request` / `approval.resolved`、`usage.updated`（用量与限额）、`error`。每种事件 SHALL 含会话 id 与单调递增序号。

#### Scenario: 流式文本增量
- **WHEN** agent 产出文本
- **THEN** 客户端按序收到 `agent.delta`，随后收到含全文的 `agent.message`

#### Scenario: 工具卡片事件
- **WHEN** agent 执行命令
- **THEN** 客户端先收 `tool.started`（命令摘要），执行完收到 `tool.finished`（exit code、耗时、输出尾部）

### Requirement: 事件顺序与幂等
同一会话的事件 SHALL 按发生顺序携带单调递增序号；客户端 SHALL 能依赖序号检测丢失与去重。

#### Scenario: 序号连续
- **WHEN** 客户端收到同一会话的连续事件
- **THEN** 序号严格递增，无回退

### Requirement: 断线重连补发
客户端重连并携带最后已收序号时，系统 SHALL 补发该序号之后的全部丢失事件，再继续实时推送；补发与实时事件序号连续。

#### Scenario: 断线期间的事件可补齐
- **WHEN** 客户端断线期间会话产生 10 个事件后重连并携带最后序号
- **THEN** 系统先按序补发 10 个事件，再继续实时推送

#### Scenario: 序号过旧无法补发
- **WHEN** 请求补发的序号早于系统保留窗口
- **THEN** 返回完整快照标记，客户端以全量拉取重建界面

### Requirement: 会话列表级事件
系统 SHALL 提供会话集合级的轻量事件（新建、状态变化、删除），供首页列表实时刷新，无需逐会话订阅。

#### Scenario: 首页感知新会话
- **WHEN** 其他设备创建了新会话
- **THEN** 订阅列表事件的客户端收到新会话条目事件
