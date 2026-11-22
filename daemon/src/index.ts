// @agentlink/daemon 入口：装配并启动
import { loadConfig, saveConfig, configPath, configDir } from "./config";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { startClaudeTransport } from "./claude/transport";
import { createApp, websocket } from "./server";
import { CodexBridge } from "./codex/bridge";
import { createRealTransportFactory } from "./codex/process";
import { sharedEndpoint, sharedTransport, startSharedDesktopRelay } from "./codex/shared-server";
import { keepAlive } from "./keepalive";

async function main() {
  const cfg = loadConfig();
  keepAlive(cfg.keepAlive);

  const sharedUrl = process.env.AGENTLINK_SHARED_APP_SERVER_URL;
  function secret(name: string) {
    const file = process.env[name];
    if (!file) throw new Error(`缺少 ${name}`);
    return readFileSync(file, "utf8").trim();
  }
  const shared = sharedUrl ? sharedEndpoint(sharedUrl, secret("AGENTLINK_SHARED_APP_SERVER_TOKEN_FILE")) : undefined;
  const relayPort = process.env.AGENTLINK_SHARED_DESKTOP_PORT;
  if (relayPort) {
    const port = Number(relayPort);
    if (!shared || !Number.isInteger(port) || port < 1024 || port > 65535 || port === cfg.port) {
      throw new Error("桌面中转端口或共享 App Server 配置无效");
    }
    startSharedDesktopRelay(shared, port, secret("AGENTLINK_SHARED_DESKTOP_KEY_FILE"));
  }
  const bridge = new CodexBridge(shared ? sharedTransport(shared) : createRealTransportFactory());
  const { app, registry, claude, limitsRefresh, push } = createApp({
    token: cfg.token,
    allowedRoots: cfg.allowedRoots,
    bridge,
    sharedAppServer: !!shared,
    ntfy: cfg.ntfy,
    onTokenRotate: (t) => {
      cfg.token = t;
      saveConfig(cfg);
    },
  });

  Bun.serve({ port: cfg.port, fetch: app.fetch, websocket });
  startClaudeTransport(claude, join(configDir(), "claude-bridge.json"));

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
  push.start(() => registry.list());
  limitsRefresh.start();
  bridge
    .start()
    .then(() => limitsRefresh.refresh(true))
    .catch((e) => {
      console.error("[daemon] codex bridge 启动失败（将自动重试）:", e.message);
    });
}

main();
