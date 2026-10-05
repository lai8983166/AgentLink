# Spec Delta

## Purpose

把 agent 危险操作（命令执行、文件改动）的决定权留在人手里：审批请求实时下发、决定一次点击提交、全程留痕可审计。

## ADDED Requirements

### Requirement: 审批请求下发
当 codex 因审批策略或操作风险请求批准时，系统 SHALL 生成审批请求并实时下发已订阅客户端，内容包含：请求 id、类型（命令/文件改动）、命令原文或 diff、工作目录、可用决定列表、agent 附带的说明。同一时刻一个会话 SHALL 至少有一个可见的待决审批入口。

#### Scenario: 命令审批请求
- **WHEN** agent 在 `untrusted` 策略下请求执行 shell 命令
- **THEN** 客户端收到审批请求事件，含命令原文、cwd 与可用决定列表，会话状态转为 `waiting_approval`

#### Scenario: 文件改动审批请求
- **WHEN** agent 的文件改动需要批准
- **THEN** 客户端收到文件改动审批请求，含改动统计与 diff 入口

### Requirement: 提交审批决定
系统 SHALL 支持四种决定：`accept`（批准）、`acceptForSession`（批准且本会话内同类不再询问）、`decline`（拒绝，agent 继续另寻方案）、`cancel`（拒绝并中断当前轮次）。决定提交后系统 SHALL 转发给 codex 并向所有客户端广播审批已解决。

#### Scenario: 批准
- **WHEN** 用户对命令审批提交 `accept`
- **THEN** 命令执行，会话状态回 `running`

#### Scenario: 本会话不再询问
- **WHEN** 用户提交 `acceptForSession`
- **THEN** 本次执行，且同会话后续同类操作不再产生审批请求

#### Scenario: 拒绝但让 agent 继续
- **WHEN** 用户提交 `decline`
- **THEN** 命令不执行，agent 收到拒绝并继续当前轮次的其他方案

#### Scenario: 拒绝并中断
- **WHEN** 用户提交 `cancel`
- **THEN** 命令不执行且当前轮次被中断

### Requirement: 决定按钮按可用选项渲染
审批请求的可用决定由 codex 动态下发。系统 SHALL 原样传递可用决定列表，客户端 SHALL 仅渲染列表中存在的决定；列表外的高级决定项 SHALL 不显示或折叠。

#### Scenario: 可用列表不含 decline
- **WHEN** 某审批请求的可用决定列表不含 `decline`
- **THEN** 客户端不显示"拒绝（agent 继续）"按钮，只显示可用项

### Requirement: 审批策略切换
系统 SHALL 支持三档审批策略：`untrusted`（每次询问）、`on-request`（agent 自行判断，默认）、`never`（全自动），可在创建会话时指定，也 SHALL 支持在会话进行中随时切换并即时生效。

#### Scenario: 会话中途收紧策略
- **WHEN** 会话 running 时用户把策略从 `never` 切到 `untrusted`
- **THEN** 下一次需要批准的操作产生审批请求

### Requirement: 审计日志
每次审批决定系统 SHALL 追加一条不可变的审计记录：时间、项目/会话、审批类型、命令原文或改动摘要、决定、决定来源。审计日志 SHALL 支持分页查询，按时间倒序。

#### Scenario: 决定落审计
- **WHEN** 用户提交任意审批决定
- **THEN** 审计日志新增一条含命令原文与决定的记录

#### Scenario: 审计查询
- **WHEN** 客户端请求审计日志
- **THEN** 返回分页的倒序决定记录列表

### Requirement: 审批请求时效
审批请求 SHALL 随所属轮次结束（完成、中断、出错）自动作废；作废后提交决定返回明确错误，客户端界面不再显示该请求。

#### Scenario: 会话中断后审批作废
- **WHEN** 用户中断会话后再提交挂起的审批决定
- **THEN** 返回 `APPROVAL_EXPIRED` 类错误，界面移除该审批卡片
