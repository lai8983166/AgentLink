# Claude 原终端会话验证

这是独立验证工具，不是已接入 AgentLink 的正式 Claude 适配器。不会自动安装插件、修改 Claude 用户设置或连接其他会话。仅当启动进程显式设置 `AGENTLINK_CLAUDE_PROBE_URL` 和 `AGENTLINK_CLAUDE_PROBE_TOKEN` 时启用；地址只能是 `http://127.0.0.1:<port>`。

目标：验证同一个 Claude CLI 进程、同一个 session ID 下的消息发送、文本流、审批、停止和断线恢复。验证期间只使用专用测试目录与测试会话。

插件基于 Claude Code mod API，初始验证版本为 Windows CLI 2.1.314。旧版 WSL CLI 2.1.23 不支持此路径。

## 独立校验

```sh
claude plugin validate --strict ./design/spike/claude-terminal-probe/plugin
claude plugin test ./design/spike/claude-terminal-probe/plugin
```

官方测试工具不启动会话、不调用模型，也不执行测试中的工具命令。通过它只能证明接口和事件处理，不能当作真实终端接管已通过。

## 约束

- 只加载插件而未配置验证连接时，插件不连接后台。
- 消息提交等候 Claude 空闲；区分已排队、已开始和被拒绝，不自动重发未知结果。
- 中止操作必须携带当前 turn ID，旧按钮不能停止后一轮。
- 默认只观察审批；显式设置 `AGENTLINK_CLAUDE_PROBE_APPROVALS=1` 才转发远程决定。
- 验证服务不可达时不改变 Claude 的原生权限规则，也不关闭 Claude 进程。
- 原生审批、远程审批之间的竞态，需通过真实终端进一步核实。
- 本地验证记录、凭据和 CLI 生成的类型文件不入库。

参考：[mod API](https://code.claude.com/docs/en/plugins/mods/api)、[事件](https://code.claude.com/docs/en/plugins/mods/events)、[官方测试工具](https://code.claude.com/docs/en/plugins/mods/test)。
