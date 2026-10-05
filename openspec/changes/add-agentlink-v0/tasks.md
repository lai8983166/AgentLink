# Tasks

## 1. 工程脚手架

- [ ] 1.1 建 pnpm workspace 三包骨架（`daemon/`、`web/`、`shared/` + 根 tsconfig/biome），空壳下 `pnpm -r build` 通过
- [ ] 1.2 daemon 起 Bun + Hono 空应用，暴露 `GET /api/v1/health`，curl 返回 200
- [ ] 1.3 定型开发命令（dev/test/lint/format），README 写明本地启动方式，新克隆可跟跑

## 2. shared 契约包

- [ ] 2.1 用 zod 定义 REST 请求/响应类型、错误码枚举（`SESSION_BUSY`/`APPROVAL_EXPIRED`/`PATH_NOT_ALLOWED`/`UNAUTHORIZED`/`SNAPSHOT_REQUIRED`），schema 单测通过
- [ ] 2.2 定义内部事件类型（design.md D4 映射表全部行：`session.status`/`agent.delta`/`agent.message`/`tool.*`/`approval.*`/`session.queue`/`usage.updated`/`error`），含序号字段，类型导出编译通过
- [ ] 2.3 定义 WS 订阅协议消息（subscribe/unsubscribe/lastSeq），schema 单测通过

## 3. codex 桥接层（daemon 核心）

- [ ] 3.1 实现 stdio JSON-RPC 分帧、请求-响应 id 匹配、通知按 threadId 路由；用摸底录制的事件流 fixture 回放，单测覆盖分帧与分发
- [ ] 3.2 子进程生命周期管理：启动、就绪探测、崩溃自动重启、重启后从 rollout 恢复会话状态；集成测试（真连 codex，标 slow）
- [ ] 3.3 codex 事件 → 内部事件映射器 + 噪音过滤（`mcpServer/*`、`skills/changed`），回放单测逐行覆盖 D4 映射表
- [ ] 3.4 审批 server-request 挂起机制：登记 → 广播 → 等手机决定 → 回包 codex；超时随轮次作废；单测模拟"请求-决定-回包"全链路

## 4. 会话域服务

- [ ] 4.1 SessionRegistry：聚合 rollout 既有会话与实时会话、维护五态状态机（waitingOnApproval → waiting_approval），单测覆盖状态迁移
- [ ] 4.2 会话操作：新建（白名单校验）、恢复（单写者冲突 → `SESSION_BUSY`）、发消息（运行中排队）、中断；服务层单测 + 真连集成（slow）
- [ ] 4.3 审批域：请求登记、决定提交（四决定转发）、轮次结束作废（`APPROVAL_EXPIRED`），单测覆盖 specs 审批场景
- [ ] 4.4 审计存储：bun:sqlite append-only 写入 + 分页查询，单测验证记录字段完整且倒序
- [ ] 4.5 白名单目录浏览服务（fs 列目录，白名单外一律拒绝），单测含越界路径用例

## 5. HTTP/WS 接口层

- [ ] 5.1 REST 路由全套（design.md D5 端点表）+ Bearer 认证中间件 + 错误 envelope；Hono app 集成测试含 401 与各错误码
- [ ] 5.2 WS 端点：查询参数认证、订阅消息切换会话、ring buffer（500 条）广播、lastSeq 补发、超窗 `SNAPSHOT_REQUIRED`；集成测试覆盖断线补发场景
- [ ] 5.3 静态托管 + SPA fallback；curl 验证 `/` 与任意深链路由均返回 index.html

## 6. 配置与运维（daemon）

- [ ] 6.1 `~/.agentlink/config.toml` 读写（token、白名单根、ntfy 地址/主题）+ token 生成与轮换 CLI；单测 + 手动验证轮换后旧 token 401
- [ ] 6.2 NotifyGateway：三类通知、优先级、同请求去重、ntfy 不可达不影响主链路；mock HTTP 单测 + ntfy 真机手测一条
- [ ] 6.3 Windows 保活开关（SetThreadExecutionState）与日志 token 脱敏；运行观察验证
- [ ] 6.4 daemon 使用文档（启动、开机自启、配置项说明）写入 `daemon/README.md`

## 7. PWA 六屏

- [ ] 7.1 Vite + React 脚手架：路由、`theme.css`（移植原型 design tokens）、PWA manifest/图标；dev 打开六屏空壳导航正常
- [ ] 7.2 数据层：TanStack Query 客户端 + WS 管道（订阅、断线重连、lastSeq 补发、快照重建）；模拟 WS 的组件测试覆盖重连补发
- [ ] 7.3 首页：会话列表、待审批横幅、状态排序、连接 pill、额度显示；组件测试验证排序与横幅联动
- [ ] 7.4 会话页：动作条、流式渲染、工具卡片折叠/展开、diff 全屏、滚动跟随/暂停、排队消息；组件测试覆盖各交互
- [ ] 7.5 审批卡片：动态决定按钮（按 availableDecisions）、一键决定、已决态、`SESSION_BUSY`/`APPROVAL_EXPIRED` 友好提示；组件测试覆盖动态按钮场景
- [ ] 7.6 新任务 sheet：项目选择（最近 + 白名单浏览）、策略三档映射、任务描述提交；组件测试验证三档创建参数
- [ ] 7.7 设置页（连接/通知开关）与审计页（分页）；深链 `/<sessionId>?approval=` 直达；按 specs 场景手动验收
- [ ] 7.8 生产构建接入 daemon 托管，`vite-plugin-pwa` 产物验证；局域网 Android 真机"添加到主屏幕"全屏启动

## 8. 端到端验收（局域网）

- [ ] 8.1 真机全流程验收：新任务 → 流式 → 审批（含 acceptForSession）→ 中断 → 恢复旧 VS Code 会话 → 审计核对；按各 spec 场景清单逐条通过
- [ ] 8.2 健壮性演练：daemon kill 重启后会话列表与订阅恢复、WS 断线补发、ntfy 停机不影响审批链路

## 9. 外网部署（文档 + 实施）

- [ ] 9.1 撰写部署文档 `docs/deploy-vps.md`：VPS 要点、frps/frpc 配置、Caddy HTTPS（标准 443 与非标端口两条路线）、ntfy 自托管、自启动与休眠策略
- [ ] 9.2 用户按文档实际部署 VPS 并外网真机验证（4G 下全流程 + 通知直达），记录延迟与待改进项
