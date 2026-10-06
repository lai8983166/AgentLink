# Tasks

## 1. IPC 基础层

- [ ] 1.1 实现 `ipc/client.ts`：命名管道连接、4 字节小端长度前缀分帧、request/response 匹配、broadcast 分发、client-discovery 自动回应、断线指数退避重连；注入假 socket 的单测覆盖分帧与重连
- [ ] 1.2 实现 initialize/version 握手与对端版本记录（日志 + `~/.agentlink/` 状态文件），单测验证版本字段落盘

## 2. Follower 会话层

- [ ] 2.1 实现 `ipc/follower.ts`：thread-owner-discovery（失败抛 `IPC_OWNER_NOT_FOUND`）、following 每 10s 续订、owner 消失探测；假管道单测覆盖发现与续订时序
- [ ] 2.2 实现 conversationState → 内部事件映射器（turn 差分 → status/agent.message/tool.*；requests[] 差分 → approval.request/resolved；未知 item 类型降级占位卡片），用探测脚本快照样例做 fixture 单测
- [ ] 2.3 实现 revision 单调校验与快照重建（跳跃即重取），单测覆盖乱序/跳跃增量被拒绝

## 3. 路由与接管

- [ ] 3.1 SessionRegistry 集成三态路由（live/desktop/rollout）与 desktopGone 标记→resume 引导，域层单测覆盖路由切换
- [ ] 3.2 REST：`POST /sessions/:id/observe`、`/takeover`、`/fork`（fork 返回新会话并登记谱系）；`SESSION_BUSY` 语义收敛为"IPC 不可用且未接管"；Hono 集成测试三端点
- [ ] 3.3 发指令/中断桥接：接管态下 message/interrupt 改走 follower 委托，`clientUserMessageId` 幂等键；单测覆盖重复提交不重复执行
- [ ] 3.4 start-turn 请求构造（快照模板法 + `inheritThreadSettings:false` + 显式审批策略），单测覆盖模板替换与空模板兜底

## 4. 审批桥接

- [ ] 4.1 requests[] 差分检测 → approval.request 事件 + ntfy（去重键 `desktop:<requestId>`），单测覆盖去重
- [ ] 4.2 决定委托 + 幂等表（同决定幂等成功、不同决定 `APPROVAL_ALREADY_DECIDED`）+ 审计落库（source=desktop-delegate），单测覆盖三态

## 5. 前端

- [ ] 5.1 busy 会话观察模式（自动 observe、事件流复用既有渲染）+「接管此会话」按钮，组件测试覆盖观察→接管状态切换
- [ ] 5.2 接管后输入/审批/中断解禁与 `desktopGone` 引导（提示改 resume），组件测试覆盖
- [ ] 5.3 fork 兜底入口与谱系 UI（来源标注 + 旧会话"最新进展在 →"横幅，数据来自 forkedFromId 反向索引），组件测试覆盖谱系提示

## 6. 兼容性防护与集成

- [ ] 6.1 slow 兼容性回归（AGENTLINK_SLOW_TESTS=1）：真实桌面只读 discovery + 快照字段存在性断言，缺失报 `IPC_INCOMPATIBLE`；把 desktop-ipc-probe 只读路径改写为测试
- [ ] 6.2 实现期探测并按需暴露 `thread-follower-steer`（存在则接入中断菜单旁，不存在记录跳过）
- [ ] 6.3 VS Code 持有会话走同一管道的验证（真实环境 slow 测试），结果记入 `design/codex-appserver-notes.md`
- [ ] 6.4 daemon README 增补：IPC 能力说明、错误码（IPC_OWNER_NOT_FOUND / IPC_INCOMPATIBLE / APPROVAL_ALREADY_DECIDED）、兜底路径与桌面升级注意事项

## 7. 端到端验收

- [ ] 7.1 真实桌面 E2E 演练（脚本化）：桌面建会话跑任务 → 手机 observe 实时看 → takeover → 手机发指令 → 代批审批 → 中断 → 桌面端核对同一会话历史一致（ID 不变、无 fork），记录延迟
- [ ] 7.2 降级演练：管道断开/桌面关闭各一次，验证回退 resume 与兜底 fork 路径及 UI 提示
- [ ] 7.3 真机（用户）验收：手机完成 观察桌面任务 → 接管 → 续指令 → 审批 → 回电脑继续 的完整场景
