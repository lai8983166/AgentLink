# AgentLink

家里 agent 的遥控器：agent 身体在 PC 上，手机是远程驾驶舱。派任务、看流式输出、批审批、收推送。

- `daemon/` — PC 侧常驻进程（Bun + Hono + TS），桥接 codex app-server
- `web/` — 手机端 PWA（React + Vite）
- `shared/` — API 契约包（REST/WS/事件 zod schema，两端共用）
- `design/` — UI 原型、设计笔记、codex 协议摸底实录
- `openspec/` — 规格与变更管理

## 快速开始

前置：Bun ≥ 1.4、Node ≥ 20、pnpm ≥ 10、codex CLI ≥ 0.160（已登录）。

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

## 文档

- UI 设计与产品决策：`design/ui-design.md`
- codex app-server 协议实录：`design/codex-appserver-notes.md`
- VPS 外网部署：`docs/deploy-vps.md`（任务 9.x 提供）
- 测试体系、真机验收与安全重启：[docs/testing.md](docs/testing.md)
- 变更流程：`openspec/`（OpenSpec，`/opsx:propose` 起新变更）
