// @agentlink/daemon 入口
import { createApp, DAEMON_VERSION } from "./server";

const port = Number(process.env.AGENTLINK_PORT ?? 8787);
const app = createApp();

Bun.serve({ port, fetch: app.fetch });

console.log(`agentlink daemon v${DAEMON_VERSION} listening on :${port}`);
console.log(`  health → http://127.0.0.1:${port}/api/v1/health`);
