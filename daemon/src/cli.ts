// agentlink daemon CLI：token 管理（任务 6.1）
// 用法：
//   bun run src/cli.ts token           # 打印当前 token
//   bun run src/cli.ts token rotate    # 轮换 token（需重启 daemon 后生效；API 轮换则即时）
//   bun run src/cli.ts config          # 打印配置概览（token 脱敏）
import { configPath, loadConfig, rotateToken, saveConfig } from "./config";

const cmd = process.argv[2] ?? "help";
const sub = process.argv[3];

switch (cmd) {
  case "token": {
    const cfg = loadConfig();
    if (sub === "rotate") {
      const t = rotateToken(cfg);
      console.log(`已轮换并写入 ${configPath()}`);
      console.log(`新 token: ${t}`);
      console.log("注意：正在运行的 daemon 需重启加载；或用 POST /api/v1/admin/token/rotate 即时轮换。");
    } else {
      console.log(`token: ${cfg.token}`);
      console.log(`（首次配对：手机端在设置里粘贴此 token）`);
    }
    break;
  }
  case "config": {
    const cfg = loadConfig();
    console.log(`config: ${configPath()}`);
    console.log(`port:          ${cfg.port}`);
    console.log(`token:         ${cfg.token.slice(0, 6)}…（完整值见配置文件）`);
    console.log(`allowedRoots:  ${cfg.allowedRoots.join(", ")}`);
    console.log(`keepAlive:     ${cfg.keepAlive}`);
    console.log(`ntfy.enabled:  ${cfg.ntfy.enabled}`);
    console.log(`ntfy.url:      ${cfg.ntfy.url}`);
    console.log(`ntfy.topics:   ${cfg.ntfy.topicPrefix}-approval / ${cfg.ntfy.topicPrefix}-task`);
    break;
  }
  case "roots": {
    // agentlink roots add <path>：添加白名单根
    const cfg = loadConfig();
    if (sub === "add" && process.argv[4]) {
      const p = process.argv[4].replace(/\\/g, "/");
      if (!cfg.allowedRoots.includes(p)) cfg.allowedRoots.push(p);
      saveConfig(cfg);
      console.log(`已添加白名单根: ${p}`);
      console.log(`当前: ${cfg.allowedRoots.join(", ")}`);
    } else {
      console.log(`当前白名单根:\n  ${cfg.allowedRoots.join("\n  ")}`);
      console.log(`添加: bun run src/cli.ts roots add <绝对路径>`);
    }
    break;
  }
  default:
    console.log("用法: bun run src/cli.ts <token|token rotate|config|roots|roots add PATH>");
}
