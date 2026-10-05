import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** daemon 配置（~/.agentlink/config.toml） */
export interface DaemonConfig {
  token: string;
  allowedRoots: string[];
  port: number;
  keepAlive: boolean;
  ntfy: {
    enabled: boolean;
    /** 自托管 ntfy 基地址，如 https://ntfy.example.com */
    url: string;
    topicPrefix: string;
    /** 点击通知的跳转基址（PWA 对外地址） */
    clickBase: string;
  };
}

export function configDir(): string {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".agentlink");
}
export function configPath(): string {
  return join(configDir(), "config.toml");
}

function parseToml(text: string): Record<string, unknown> {
  try {
    return (Bun as unknown as { TOML?: { parse: (t: string) => Record<string, unknown> } }).TOML?.parse(text) ?? {};
  } catch {
    return {};
  }
}

/** TOML 基本字符串转义（反斜杠 + 双引号）——Windows 路径必须转义反斜杠 */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function serializeToml(c: DaemonConfig): string {
  return [
    "# agentlink daemon 配置",
    `token = "${esc(c.token)}"`,
    `port = ${c.port}`,
    `keepAlive = ${c.keepAlive}`,
    "# 白名单根目录（fs 浏览与新任务 projectPath 允许的范围）",
    `allowedRoots = [${c.allowedRoots.map((r) => `"${esc(r)}"`).join(", ")}]`,
    "",
    "[ntfy]",
    `enabled = ${c.ntfy.enabled}`,
    `url = "${esc(c.ntfy.url)}"`,
    `topicPrefix = "${esc(c.ntfy.topicPrefix)}"`,
    `clickBase = "${esc(c.ntfy.clickBase)}"`,
    "",
  ].join("\n");
}

/** 读取配置；不存在则生成（含随机 token）并落盘 */
export function loadConfig(overrides?: { env?: Record<string, string | undefined> }): DaemonConfig {
  const env = overrides?.env ?? process.env;
  const defaults: DaemonConfig = {
    token: "",
    allowedRoots: [],
    port: 8787,
    keepAlive: true,
    ntfy: { enabled: false, url: "https://ntfy.example.com", topicPrefix: "agentlink", clickBase: "" },
  };

  mkdirSync(configDir(), { recursive: true });
  let cfg = { ...defaults };
  if (existsSync(configPath())) {
    const raw = parseToml(readFileSync(configPath(), "utf-8"));
    const ntfy = (raw.ntfy ?? {}) as Record<string, unknown>;
    cfg = {
      ...cfg,
      token: typeof raw.token === "string" ? raw.token : cfg.token,
      port: typeof raw.port === "number" ? raw.port : cfg.port,
      keepAlive: typeof raw.keepAlive === "boolean" ? raw.keepAlive : cfg.keepAlive,
      allowedRoots: Array.isArray(raw.allowedRoots)
        ? raw.allowedRoots.filter((r): r is string => typeof r === "string")
        : cfg.allowedRoots,
      ntfy: {
        enabled: typeof ntfy.enabled === "boolean" ? ntfy.enabled : cfg.ntfy.enabled,
        url: typeof ntfy.url === "string" ? ntfy.url : cfg.ntfy.url,
        topicPrefix: typeof ntfy.topicPrefix === "string" ? ntfy.topicPrefix : cfg.ntfy.topicPrefix,
        clickBase: typeof ntfy.clickBase === "string" ? ntfy.clickBase : cfg.ntfy.clickBase,
      },
    };
  }

  let changed = false;
  if (!cfg.token) {
    cfg.token = crypto.randomUUID().replace(/-/g, "");
    changed = true;
  }
  if (cfg.allowedRoots.length === 0) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
    cfg.allowedRoots = [join(home, "project")];
    changed = true;
  }
  // 环境覆盖
  if (env.AGENTLINK_PORT) cfg.port = Number(env.AGENTLINK_PORT);
  if (env.AGENTLINK_TOKEN) cfg.token = env.AGENTLINK_TOKEN;

  if (changed) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: DaemonConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), serializeToml(cfg), "utf-8");
}

/** 轮换 token：新 token 落盘并返回（旧 token 随之失效） */
export function rotateToken(cfg: DaemonConfig): string {
  cfg.token = crypto.randomUUID().replace(/-/g, "");
  saveConfig(cfg);
  return cfg.token;
}
