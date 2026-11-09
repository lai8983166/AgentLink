# 项目协作约定

- 在 Windows 上执行 shell 命令时优先使用 Git Bash；仅在 Git Bash 不可用或命令专属 Windows/PowerShell 时使用 PowerShell。
- 每完成并验证一小部分任务，就提交一次本地 Git，使用清楚描述该部分改动的提交信息。
- 原版客户端（`web/`、`mobile/`）与 NSH 客户端（`native/`）持续同步维护。除非用户明确限定单版，后续功能、界面、操作流程和问题修复均检查两版并同步实现，保持用户可见行为一致；后台协议变化同时核对两版兼容性。按 `native/COMPATIBILITY.md` 和 `native/VISUAL_PARITY.md` 检查对应页面及状态，分别执行适用验证；交付安卓更新时构建两版 APK 并更新各自后台下载入口。平台专属差异与未验证项明确记录，不将单版完成视为整体完成。
- 不得提交真实会话快照、消息正文、运行日志、个人邮箱、真实部署地址或本机身份信息；文档和测试使用人工构造的数据及示例地址。提交前运行 `node scripts/check-repository-privacy.mjs`。
