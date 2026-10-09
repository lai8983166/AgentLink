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

## 文档

- UI 设计与产品决策：`design/ui-design.md`
- codex app-server 协议实录：`design/codex-appserver-notes.md`
- VPS 外网部署：`docs/deploy-vps.md`（任务 9.x 提供）
- 测试体系、真机验收与安全重启：[docs/testing.md](docs/testing.md)
- 变更流程：`openspec/`（OpenSpec，`/opsx:propose` 起新变更）
