# Proposal

## Why

家里的 Codex agent 跑在 PC 上（VS Code / Codex Desktop），人离开电脑就无法派任务、看进度、处理审批——现有的 ChatGPT App 只能续跑云端沙箱副本，碰不到本机文件，也没有命令审批把关。摸底已验证 codex app-server 协议完整可用（见 `design/codex-appserver-notes.md`）：免登录复用、旧会话可继承、审批流可编程，实现"手机远程驾驶舱"的技术风险已清零。

## What Changes

- 新增 **daemon**（Bun + Hono + TypeScript，跑在家里 PC）：托管 codex app-server 子进程（stdio JSON-RPC 桥），对外提供版本化 REST API（`/api/v1`）与 WebSocket 事件流，托管 PWA 静态文件
- 新增 **会话管理能力**：新建 / 列表 / 恢复（含继承既有 VS Code/Codex Desktop 会话）/ 发消息 / 中断，完整状态机（running / waiting_approval / done / error / idle）
- 新增 **审批网关**：命令与文件改动审批请求实时下发手机，提交决定（accept / acceptForSession / decline / cancel，按 `availableDecisions` 动态渲染），审批策略三档随时切换，全部决定落审计日志
- 新增 **实时事件流**：会话状态、流式文本、工具卡片（命令/文件改动/diff）、token 用量与额度限额推送，断线重连可补齐
- 新增 **ntfy 推送**：审批请求（最高优先级）/ 任务完成 / 出错掉线，点击通知直达对应界面
- 新增 **PWA 手机端**（React + Vite + TanStack Query + zustand，Raft 风视觉）：六屏——首页会话列表、会话对话流、新任务、设置、审计日志、diff 全屏
- 新增 **外网接入**：局域网直连 + 国内 VPS frp 中继 + HTTPS，附部署文档
- 新增 **token 认证**：daemon 与手机端之间的独立鉴权，不绑定前端形态（PWA 是第一客户端，为将来安卓原生预留同一套 API）

## Capabilities

### New Capabilities

- `session-management`: codex 会话生命周期——新建、列表、恢复（含旧会话继承与单写者冲突处理）、发消息、中断、状态机与用量跟踪
- `approval-flow`: 审批闭环——请求下发、决定提交（四种决定 + 动态可用选项）、策略三档切换、审计日志记录与查询
- `event-stream`: 会话 WebSocket 事件流——事件类型契约、订阅/断线重连语义、事件与 UI 状态机的映射
- `push-notifications`: ntfy 通知通道——审批/完成/出错三类通知、优先级、深链回跳、订阅开关
- `remote-access`: 网络接入层——局域网直连、VPS frp 中继、HTTPS 与部署要求
- `mobile-client`: PWA 六屏行为——会话列表状态排序与待审批横幅、对话流可扫读性（工具卡片折叠/diff 全屏）、新任务表单、设置与审计入口

### Modified Capabilities

（无——全新项目，无存量 spec）

## Impact

- **代码**：全新代码库。仓库将新增 `daemon/`（Bun + Hono + TS）与 `web/`（React + Vite）两个包（pnpm workspace）
- **依赖**：Bun 运行时；Hono 及 WS；React/Vite/TanStack Query/zustand；本机 codex CLI ≥0.160（app-server 协议按 0.160.0 实测锁定）；VPS 上的 frp + ntfy（部署项，不在本仓库代码内）
- **系统影响**：daemon 以当前用户运行 codex 子进程（具备本机文件写能力，审批策略是安全边界）；读取 `~/.codex/`（auth.json 只读复用、sessions rollout）；对外暴露端口（局域网 + frp 隧道，token 认证是前提）
- **既有产物**：`design/prototype.html`（视觉规范基线）、`design/ui-design.md` 第五节 API 草案将按实测协议定稿为本 change 的 specs；`design/spike/` 保留为协议参考
