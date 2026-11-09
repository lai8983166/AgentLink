import { Hono } from "hono";
import { existsSync } from "node:fs";

/** Public installation files contain no pairing credentials. Keep both editions independent. */
export function createDownloadsRouter(files: { original: string; nsh: string }) {
  const app = new Hono();
  for (const [path, file, name] of [
    ["agentlink.apk", files.original, "AgentLink.apk"],
    ["agentlink-nsh.apk", files.nsh, "AgentLink-NSH.apk"],
  ] as const) {
    app.get(`/downloads/${path}`, () => {
      const headers = { "Content-Type": "application/vnd.android.package-archive", "Content-Disposition": `attachment; filename=${name}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (!existsSync(file)) return new Response("安装包尚未生成，请稍后重试。", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
      return new Response(Bun.file(file), { headers });
    });
  }
  const index = () => new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentLink 安卓下载</title>
<style>body{max-width:560px;margin:40px auto;padding:0 20px;font:16px/1.7 system-ui;background:#f2f5f3;color:#182d35}section{background:white;border-radius:16px;padding:20px;margin:20px 0}a{display:block;background:#14695e;color:white;padding:12px;text-align:center;border-radius:8px;text-decoration:none}p{color:#526770}h2{font-size:20px}</style></head>
<body><h1>AgentLink 安卓下载</h1><p>选择要安装的版本。两版可同时安装，各自配对。</p>
<section><h2>原版客户端</h2><p>现有安卓客户端，保留原有功能与配对数据。</p><a href="/downloads/agentlink.apk">下载原版 APK</a></section>
<section><h2>NSH 版 · 测试版</h2><p>Android 9 及以上，支持 arm64 / x86_64。首次安装需重新配对；通知待机、输入法和长历史体验仍待手机验证。</p><a href="/downloads/agentlink-nsh.apk">下载 NSH 测试版 APK</a></section>
<p>下载后打开 APK，按系统提示允许安装。NSH 版不会覆盖原版。</p></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  app.get("/downloads", index);
  app.get("/downloads/", index);
  return app;
}
