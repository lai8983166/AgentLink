// @agentlink/daemon 入口：装配并启动
import { loadConfig, saveConfig, configPath } from "./config";
import { createApp, websocket } from "./server";
import { CodexBridge } from "./codex/bridge";
import { createRealTransportFactory } from "./codex/process";
import { keepAlive } from "./keepalive";

async function main() {
  const cfg = loadConfig();
  keepAlive(cfg.keepAlive);

  const bridge = new CodexBridge(createRealTransportFactory());
  const { app, registry } = createApp({
    token: cfg.token,
    allowedRoots: cfg.allowedRoots,
    bridge,
    ntfy: cfg.ntfy,
    onTokenRotate: (t) => {
      cfg.token = t;
      saveConfig(cfg);
    },
  });

  Bun.serve({ port: cfg.port, fetch: app.fetch, websocket });

  console.log(`agentlink daemon → http://0.0.0.0:${cfg.port}`);
  console.log(`  health  → /api/v1/health`);
  console.log(`  config  → ${configPath()}（token 见该文件）`);
  if (cfg.ntfy.enabled) {
    console.log(`  ntfy    → ${cfg.ntfy.url}（主题前缀 ${cfg.ntfy.topicPrefix}）`);
  } else {
    console.log(`  ntfy    → 未启用（config.toml [ntfy] enabled=true 开启）`);
  }

  // codex 子进程就绪后再拉会话列表；失败不阻塞 HTTP 服务
  await registry.start();
  bridge
    .start()
    .catch((e) => {
      console.error("[daemon] codex bridge 启动失败（将自动重试）:", e.message);
    });
}

main();
