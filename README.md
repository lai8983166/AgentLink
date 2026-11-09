# AgentLink

家里 agent 的遥控器：agent 身体在 PC 上，手机是远程驾驶舱。派任务、看流式输出、批审批、收推送。

- `daemon/` — PC 侧常驻进程（Bun + Hono + TS），桥接 Codex 与 Claude Code 原终端
- `web/` — 手机端 PWA（React + Vite）
- `mobile/` — 自用安卓 APK（复用 React 界面，Kotlin 后台通知，无 Google 服务依赖）
- `native/` — NSH 安卓客户端（核心功能试用版，复用后台、独立 APK；真机验收待完成；见 [构建与验证说明](native/README.md)）
- `shared/` — API 契约包（REST/WS/事件 zod schema，两端共用）
- `plugins/` — Claude Code 原终端插件及本地安装工具
- `design/` — UI 原型、设计笔记、codex 协议摸底实录
- `openspec/` — 规格与变更管理

## 快速开始

前置：Bun ≥ 1.4、Node ≥ 22、pnpm ≥ 10、codex CLI ≥ 0.160（已登录）。

```bash
pnpm install          # 安装依赖
pnpm build            # 全 workspace 类型检查
pnpm test             # 全 workspace 测试（真连 codex 的 slow 用例默认跳过）
pnpm check            # 类型、单元测试、PWA 构建、桌面/手机尺寸浏览器测试
pnpm dev              # 启动 daemon :8787 → curl /api/v1/health
```

## 继续电脑端的原会话

电脑端已打开该会话时，在手机点击“接管此会话”，通过原拥有者发送消息和审批。旧会话没有被其他入口持有时，可点击“继续原会话”：后台确认 IPC 没有拥有者、Windows 写入锁已释放后，恢复同一个会话 ID，保留历史和记录中的执行权限，不创建 fork。

电脑、AgentLink 后台和桌面 IPC 通道仍需在线。连接异常、占用状态不明或仍有写入者时拒绝恢复，不把失联当作已释放。恢复成功后由 AgentLink 的 app-server 持有这条会话；手机刷新不重置运行任务。之后在电脑端重新编辑，需要先交还写入权；当前没有自动反向交接功能。关闭手机页面只释放浏览器连接，不中断后台任务，也不释放 app-server 写入权。

## 最近会话与全部目录

首页只显示最近 30 天活跃的会话，顶部“全部 Codex 会话”和“全部 Claude Code 会话”入口不限制时间，可按标题或项目路径搜索；较长目录每次展示 50 项，点击加载更多。进入旧会话后可返回原来的代理目录。

Claude 目录包含电脑当前用户默认配置目录的主会话历史，已关闭或未加载插件的会话可只读查看；加载插件的原终端连入后，同一 ID 开放控制。后台通过 `CLAUDE_CONFIG_DIR` 可指定其他 Claude 配置目录，不自动扫描 WSL 或其他用户账号。目录扫描只读取有界的首尾元数据，历史详情最多读取文件末尾 4 MiB、保留最近 500 个展示项；更早正文仍可在 Claude 原终端查看。Codex 全部目录按官方 `thread/list` 分页继续读取。浏览目录不会自动恢复或 fork 会话。

APK 需要更新到 0.2.2；网页更新页面即可。仅查询状态或检测连接不会延长会话的活跃时间，缺少有效活跃时间的历史仍可从全部目录查找。

## 长会话加载

APK 0.2.1 和新版网页首次只加载最近一页（最多 60 条，通常不超过 256 KiB；单条内容保持完整）。向上查看时点击“加载更早记录”。重新进入会话、定时核对与手动刷新使用历史版本，只传新增或修改的记录；本地缓存可先显示上次内容，核对完成前不开放控制操作。后台重启、历史裁剪或缓存失效时重新获取最近一页。

历史缓存最多保留 8 个会话，按估算存储量限制约 8 MiB；超大窗口和存储不可用时退回内存及联网读取。缓存按服务器地址与配对身份隔离，解除配对会清理历史缓存，草稿仍按原有机制保存。旧 APK 保留完整详情协议，需覆盖安装新版才能启用此优化。

## Claude Code 原终端

新版后台运行后，在本机 Windows 终端的仓库根目录执行 `node plugins/install.mjs`。要求 Claude Code ≥ 2.1.314；安装命令不会升级 CLI。已有 Claude 会话输入 `/reload-plugins`，以后直接启动 `claude` 即会加载。手机列表显示 CLAUDE 标识，可查看输出、发送指令、处理工具审批、停止任务和接收完成通知。APK 需要更新至 0.2.0，网页需要刷新至新版。

插件控制原进程、原会话，不恢复或 fork 另一个进程。当前仅验收 Windows 原生交互终端；电脑原生 Esc 后需在原终端发送一条消息解除输入限制，问答与计划确认等交互仍需原终端处理。安装、限制与隔离验证见 [Claude 插件说明](plugins/claude-code/README.md)。

## 文档

- UI 设计与产品决策：`design/ui-design.md`
- codex app-server 协议实录：`design/codex-appserver-notes.md`
- VPS 外网部署：`docs/deploy-vps.md`（任务 9.x 提供）
- 测试体系、真机验收与安全重启：[docs/testing.md](docs/testing.md)
- 安卓 APK 安装、签名构建与后台通知测试：[mobile/README.md](mobile/README.md)
- 变更流程：`openspec/`（OpenSpec，`/opsx:propose` 起新变更）
