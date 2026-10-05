# AgentLink · UI 设计笔记

> 配套可点击原型：`design/prototype.html`（浏览器直接打开，桌面端左侧有导览）
> 本文档是"从 UI 交互出发规划项目"的产物：先定界面，再让界面反推 daemon 的 API 契约。

## 一、已确认的产品决策

| 决策点 | 结论 |
|---|---|
| 定位 | 家里 agent 的"遥控器"：agent 身体在 PC，手机是远程驾驶舱 |
| 使用范围 | 家里局域网 + 外网（否决 Tailscale，用 国内 VPS + frp 中继，兼顾局域网直连） |
| 交互深度 | 完整驾驶：从零开任务、流式输出、审批、推送 |
| 第一版 Agent | **Codex 为主**（ChatGPT Coding Plan 订阅，非 API key，走 `codex app-server`） |
| Claude Code | 二期接入（stream-json 无头模式 + `--permission-prompt-tool`） |
| 前端形态 | **PWA**（React + Vite），由 daemon 托管静态文件，手机"添加到主屏幕" |
| 目标手机 | Android |
| 推送通道 | **ntfy**（自托管在 VPS；国内安卓无 Google 服务，浏览器 Web Push 不可靠） |

## 二、设计原则

1. **审批一步到位** —— 通知 → 直达审批卡片 → 一次点击。这是全 app 价值最高的路径，任何页面有待审批时首页横幅 + 会话状态条同时提示。
2. **可扫读优先** —— 工具调用默认折叠为一行摘要（命令 + 耗时 + exit code / diff 统计），长输出不淹没对话；diff 点开全屏看。
3. **当前动作常显** —— 会话页顶部"动作条"始终显示 agent 此刻在干嘛（执行什么命令 / 等待什么），不读全文也能掌握进度。
4. **通知驱动闭环** —— 派任务 → 锁屏 → 收通知（等审批/完成/出错）→ 点通知直达对应界面。默认使用方式是"不看屏"。

## 三、屏幕清单与交互

### 1. 首页 · 会话列表
- **目的**：一眼看清"哪些在跑、哪个需要我"
- 元素：PC 连接状态 pill（局域网/中继 + 延迟）、待审批横幅（置顶、点击直达）、"进行中"/"已完成·空闲"分组卡片、FAB ＋
- 卡片信息：项目名、路径、Agent 标签、状态 chip（运行中/等待审批/已完成/空闲）、当前动作或结果摘要、时间
- 状态排序：等待审批 > 运行中 > 已完成 > 空闲

### 2. 会话页 · 对话流（核心屏）
- 顶栏：返回、项目名 + 状态点、菜单（中断 / 切换审批策略 / 在电脑上继续 / 结束会话）
- 动作条：当前动作（琥珀色 = 等待批准，可点击打开审批 sheet；蓝色 = 执行中）
- 消息流：
  - 用户消息：右侧气泡
  - agent 文本：全宽 markdown
  - 工具调用卡片：可折叠（读取文件 / 修改文件±统计 / 执行命令+exit code）
  - 审批卡片：命令、cwd、风险提示、agent 理由、[拒绝] [批准] + "本会话不再询问"
- 输入栏：运行中输入自动排队；发送键
- 滚动：自动跟随，用户上滑则暂停跟随并出现"回到底部"

### 3. 新任务 Sheet
- 项目选择（最近项目 + 浏览 PC 目录）
- Agent 选择（Codex；Claude Code 占位）
- 审批策略三档：每次询问 / **失败时询问（默认）** / 全自动 —— 对应 codex approval policy
- 任务描述输入 + 附加照片/截图

### 4. 设置
- 连接：家里 PC（局域网直连状态/延迟）、VPS 中继状态
- 通知：审批请求（最高优先级）/ 任务完成 / 出错掉线
- 安全：审计日志入口

### 5. 审计日志
- 每次审批的：决定（批准/拒绝）、项目、命令原文、时间。安全兜底 + 复盘。

### 6. Diff 全屏页
- 文件路径 + ±统计，逐行着色 diff，横滑长行。

## 四、会话状态机（UI 侧）

```
新建 → running ⇄ waiting_approval（审批后回 running）
              → done / error
  任意态 → idle（长时间无活动，可继续）
```

## 五、UI 反推的 daemon API 契约（草案，v0）

手机端所有界面需要的数据/操作，daemon 必须提供：

| UI 元素 | 需要什么 | API 草案 |
|---|---|---|
| 首页卡片列表 | 会话集合 + 状态 + 摘要 | `GET /api/sessions` |
| PC 状态 pill | 机器在线、连接模式、延迟 | `GET /api/status` |
| 会话页消息流 | 事件流（增量） | `WS /api/sessions/:id/ws`（下方事件表） |
| 输入栏发送 | 发消息（运行中排队） | `POST /api/sessions/:id/message` `{text, images[]}` |
| 菜单·中断 | 停止当前步骤 | `POST /api/sessions/:id/interrupt` |
| 审批卡片 | 请求详情 + 提交决定 | 事件 `approval_request` → `POST /api/sessions/:id/approvals/:aid` `{decision: deny\|allow\|allow_session}` |
| 菜单·切换策略 | 改审批策略 | `PATCH /api/sessions/:id` `{approvalPolicy}` |
| 新任务·项目选择 | 最近项目 + 目录浏览 | `GET /api/projects`、`GET /api/fs?path=…`（限白名单根目录） |
| 新任务·开始 | 创建会话并启动 | `POST /api/sessions` `{projectPath, agent:'codex', approvalPolicy, prompt, images[]}` |
| 会话列表继续旧会话 | 历史/恢复 | codex rollout 会话列表 + `POST /api/sessions/:id/resume` |
| 菜单·电脑上继续 | 会话 id 对接 `codex resume` | 展示可复制的会话标识即可（v0） |
| 审计日志 | 审批历史 | `GET /api/audit` |
| 设置·通知开关 | 推送订阅管理 | `POST /api/notify/subscriptions` |

**WS 事件类型**（会话页渲染所需的最小集）：

```
session.status     {status: running|waiting_approval|done|error|idle}
agent.delta        {text}                      ← 流式文本
agent.message      {text(markdown)}
tool.started       {kind: read|edit|exec, target, cmd?}
tool.finished      {exitCode?, durationMs, diff?, outputTail?}
approval.request   {id, kind: exec|patch, cmd?|diff?, cwd, reason?}
approval.resolved  {id, decision, by}
error              {message}
```

**ntfy 通知 → 深链映射**：

| 通知 | topic | 点击后 |
|---|---|---|
| 审批请求 | `agentlink-approval`（最高优先级） | 打开 PWA → 对应会话 → 审批卡片 |
| 任务完成 | `agentlink-task` | 对应会话 |
| 出错/掉线 | `agentlink-task` | 对应会话 |

## 六、视觉规范（原型即规范 · Raft 风）

> 参照 [raft.build](https://raft.build)：暖米白纸感底 + 金黄主色 + 墨色描边硬投影，"千禧年聊天室"质感。

- 背景暖米白 `#FDF9EF`，卡片 `#FFFFFF`，内嵌羊皮纸 `#F8F1DD`
- 描边墨色 `#221C0E`（卡片 1.5px）+ 硬投影 `3px 3px 0`（按压时位移消投影，贴纸感）
- 主色金黄 `#FFD700`：按钮 / FAB / 用户气泡 / 审批横幅 / 开关，一律配黑字；浅底上的金黄文字用深金 `#8A6E00`
- 语义色：运行中 `#3D5CE5`（钴蓝）/ 等待审批 = 品牌金黄（全 app 最高优先级）/ 成功 `#1F8A3B` / 危险 `#D24430`
- 字体：**Space Grotesk**（界面）+ **Space Mono**（命令/路径/标签/时间戳），中文回退 PingFang / 雅黑
- 状态点为圆角小方块 + 墨描边；空闲/占位类用虚线边框；用户气泡带 mono 小时间戳（聊天室致敬）
- 尺寸基准 390×844，安全区适配（`viewport-fit=cover`）

## 七、待定问题（不阻塞 UI）

1. **网络**：VPS 具体选型/购买；frp 端口与 HTTPS 证书方案（IP+非标端口 vs 域名备案）
2. **daemon 技术栈**：Node（直接复用 app-server JSON-RPC）vs 先调研 angel-engine 是否可作基座
3. **Claude Code 接入时间点**（二期）
4. **图片上传**：v0 就要还是后置
5. **多任务并发**：同项目多会话并存（codex 支持，UI 已按会话粒度设计，无冲突）
6. **PC 睡眠策略**：daemon 常驻 + 阻止睡眠的方案
