import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const appBuild = new Date().toISOString();
const buildMetadata: Plugin = {
  name: "agentlink-build-version",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: appBuild }) });
  },
};

export default defineConfig({
  define: { __APP_BUILD__: JSON.stringify(appBuild) },
  plugins: [
    react(),
    buildMetadata,
    VitePWA({
      // Activate new caches for legacy installations; our own updater controls page reload.
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icons/icon.svg"],
      manifest: {
        name: "AgentLink",
        short_name: "AgentLink",
        description: "家里 agent 的遥控器：派任务、看进度、批审批",
        theme_color: "#FFD700",
        background_color: "#FDF9EF",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        globIgnores: ["**/version.json"],
        // 静态资源预缓存；API/WS 永不缓存
        navigateFallback: "/index.html",
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    // 开发时代理到本机 daemon
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
} as never);
