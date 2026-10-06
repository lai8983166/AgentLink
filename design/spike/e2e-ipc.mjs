// 桌面 IPC 接管 E2E（任务 7.1）：真 daemon + 真桌面（READY 测试会话）
// 流程：observe（实时观察）→ takeover（原会话接管）→ 手机侧发指令 → 等 agent 回复 → 校验 ID 不变
const BASE = "http://127.0.0.1:8799";
const TOKEN = process.argv[2];
const CONV = process.argv[3] ?? "01a10ef1-c3d4-7d10-8577-f9989d558ab8"; // READY 测试会话
const MARKER = "AGENTLINK_IPC_TAKEOVER_OK";
if (!TOKEN) {
  console.error("用法: bun e2e-ipc.mjs <token> [会话id]");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. observe
  const t0 = Date.now();
  const obs = await fetch(`${BASE}/api/v1/sessions/${CONV}/observe`, { method: "POST", headers: auth, body: "{}" });
  if (!obs.ok) throw new Error(`observe 失败 ${obs.status}: ${await obs.text()}`);
  log("✓ observe（实时观察已建立）");

  // 2. WS 订阅收事件
  const ws = new WebSocket(`ws://127.0.0.1:8799/api/v1/ws?token=${TOKEN}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = (e) => j(new Error(e.message)); });
  ws.send(JSON.stringify({ type: "subscribe", sessionId: CONV }));
  let sawEvents = false;
  let replyText = "";
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== "event") return;
    sawEvents = true;
    if (m.event.type === "agent.message" && m.event.text.includes(MARKER)) replyText = m.event.text;
  };
  await sleep(2500);
  log(sawEvents ? "✓ WS 实时事件流已通（快照差分到达）" : "… 暂无事件（会话空闲，正常）");

  // 3. takeover
  const tk = await fetch(`${BASE}/api/v1/sessions/${CONV}/takeover`, { method: "POST", headers: auth });
  if (!tk.ok) throw new Error(`takeover 失败 ${tk.status}: ${await tk.text()}`);
  log("✓ takeover（原会话接管）");

  // 4. 发指令
  const msg = await fetch(`${BASE}/api/v1/sessions/${CONV}/message`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ text: `AgentLink 接管 E2E：请只回复 ${MARKER}，不要调用任何工具。` }),
  });
  if (!msg.ok) throw new Error(`message 失败 ${msg.status}: ${await msg.text()}`);
  log("→ 指令已委托发送，等待回复…");

  // 5. 等_marker
  const t1 = Date.now();
  while (!replyText && Date.now() - t1 < 120000) await sleep(1000);
  ws.close();
  if (!replyText) throw new Error("120s 内未收到带标记的回复");
  log(`✓ 收到回复（${(Date.now() - t1) / 1000 | 0}s）: ${replyText.slice(0, 50)}`);

  // 6. 校验原会话 ID 不变、无 fork
  const detail = await (await fetch(`${BASE}/api/v1/sessions/${CONV}`, { headers: auth })).json();
  const ok = detail.session.id === CONV && detail.session.forkedFromId === null;
  log(ok ? "✓ 原 ID 不变、forkedFromId=null（非 fork 接管）" : `✗ 校验失败: ${JSON.stringify(detail.session).slice(0, 120)}`);
  console.log(`\n=== IPC 接管 E2E ${ok ? "通过" : "失败"}（总耗时 ${((Date.now() - t0) / 1000) | 0}s）===`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E FAIL:", e.message);
  process.exit(1);
});
