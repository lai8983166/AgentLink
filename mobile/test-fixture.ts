// 模拟器专用，端口仅监听本机；与生产 daemon、真实 Codex 和手机订阅完全隔离。
import { PushStore } from "../daemon/src/notify/push-store";
import { WebPushService } from "../daemon/src/notify/web-push";
import { createNativePushRouter } from "../daemon/src/routes/native-push";

const push = new WebPushService(new PushStore(), async () => { throw new Error("模拟器测试不允许访问外部推送服务"); });
const app = createNativePushRouter(push, { token: "android-instrumentation-only" });
app.get("/", (c) => c.text("AgentLink Android isolated fixture"));
Bun.serve({ hostname: "127.0.0.1", port: 48918, fetch: app.fetch });
console.log("Android isolated fixture listening on 127.0.0.1:48918");
