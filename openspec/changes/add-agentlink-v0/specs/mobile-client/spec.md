# Spec Delta

## Purpose

定义 PWA 六屏的可观察行为契约：可扫读优先、当前动作常显、审批一步到位。视觉规范以 `design/prototype.html`（Raft 风格）为基线。

## ADDED Requirements

### Requirement: 首页会话列表
首页 SHALL 置顶显示待审批横幅（存在待决审批时，点击直达审批卡片）；会话卡片按状态排序：等待审批 > 运行中 > 已完成 > 空闲；SHALL 显示连接状态（局域网/中继 + 延迟）与账户额度。

#### Scenario: 待审批横幅置顶
- **WHEN** 任一会话存在待决审批
- **THEN** 首页顶部显示横幅，点击进入对应会话并定位审批卡片

#### Scenario: 状态排序
- **WHEN** 列表同时存在空闲、运行中、等待审批的会话
- **THEN** 等待审批排最前，其后运行中，再已完成，最后空闲

### Requirement: 会话页动作条与对话流
会话页顶部 SHALL 常显当前动作（执行中的命令 / 等待审批提示）。对话流中：用户消息为气泡；agent 消息为全宽 markdown；工具调用默认折叠为一行摘要（命令 + 耗时 + exit code / diff 统计），点开可看输出，diff 点开全屏。

#### Scenario: 不读全文掌握进度
- **WHEN** agent 连续执行多个工具调用
- **THEN** 每个调用折叠为一行摘要，动作条显示当前正在执行的动作

#### Scenario: diff 全屏查看
- **WHEN** 用户点开文件改动卡片
- **THEN** 全屏展示逐行着色 diff，含 ± 统计

### Requirement: 流式跟随与输入排队
agent 输出流式渲染时 SHALL 自动跟随滚动；用户上滑后 SHALL 暂停跟随并出现"回到底部"入口。会话运行中发送的消息 SHALL 显示排队状态。

#### Scenario: 上滑暂停跟随
- **WHEN** 流式输出中用户向上滚动查看历史
- **THEN** 视口不再自动跳动，出现回到底部按钮

#### Scenario: 排队提示
- **WHEN** 会话运行中用户发送消息
- **THEN** 消息以排队态显示，轮次结束后自动发出

### Requirement: 新任务表单
新任务 SHALL 依次提供：项目选择（最近项目 + 浏览白名单目录）、Agent 选择（v0 仅 Codex，其余占位）、审批策略三档（默认 on-request 对应"失败时询问"）、任务描述输入。

#### Scenario: 三档策略映射
- **WHEN** 用户分别选择每次询问/失败时询问/全自动创建任务
- **THEN** 会话分别以 untrusted / on-request / never 策略创建

#### Scenario: 浏览白名单目录
- **WHEN** 用户展开项目浏览
- **THEN** 只能浏览白名单根目录内的目录

### Requirement: 审批卡片一步到位
审批卡片 SHALL 显示命令原文（等宽）、工作目录、风险提示与 agent 理由；操作按钮按可用决定动态渲染，主按钮为批准；含"本会话不再询问"次级入口。决定后卡片变为已决状态且不可重复提交。

#### Scenario: 一次点击完成审批
- **WHEN** 用户在审批卡片点击批准
- **THEN** 卡片变为"已批准"，动作条与横幅同步更新，无需二次确认

### Requirement: 设置与审计入口
设置页 SHALL 显示：家里 PC 连接状态（模式 + 延迟）、VPS 中继状态、三类通知开关、审计日志入口。审计页 SHALL 分页展示决定记录（决定、项目、命令原文、时间）。

#### Scenario: 通知开关即时生效
- **WHEN** 用户切换某类通知开关
- **THEN** 设置持久化并立即影响后续推送

### Requirement: PWA 可安装
应用 SHALL 提供 manifest 与图标，Android 浏览器"添加到主屏幕"后以独立全屏窗口启动（无浏览器栏）。

#### Scenario: 添加主屏全屏启动
- **WHEN** 用户从主屏幕图标启动应用
- **THEN** 以 standalone 全屏模式打开，不显示浏览器 UI

### Requirement: 单写者冲突提示
恢复被 IDE 占用的会话失败时，界面 SHALL 显示明确提示（"会话正在电脑上使用中"）并提供返回列表入口，SHALL NOT 显示笼统错误。

#### Scenario: 占用冲突的友好提示
- **WHEN** 用户尝试恢复一个正被 VS Code 使用的会话且收到 SESSION_BUSY
- **THEN** 界面显示占用提示与返回入口
