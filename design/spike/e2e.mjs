// 端到端演练（任务 8.1/8.2 自动化部分）：真 daemon + 真 codex
// 流程：建会话(untrusted) → WS 收流式/工具事件 → 审批请求 → accept → 完成 → 审计核对
const BASE = "http://127.0.0.1:8799";
const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法: bun e2e.mjs <token>");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 建会话
  log("→ POST /sessions (untrusted)");
  const createRes = await fetch(`${BASE}/api/v1/sessions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      projectPath: "F:/project/AgentLink/design/spike/scratch",
      approvalPolicy: "untrusted",
      prompt: "Create a file named e2e-ok.txt containing exactly the word hello. Then reply with just: DONE",
    }),
  });
  const { id } = await createRes.json();
  if (!id) throw new Error(`建会话失败: ${createRes.status}`);
  log("✓ 会话:", id);

  // 2. WS 订阅
  const ws = new WebSocket(`ws://127.0.0.1:8799/api/v1/ws?token=${TOKEN}`);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = (e) => j(new Error("WS 失败: " + e.message));
  });
  ws.send(JSON.stringify({ type: "subscribe", sessionId: id }));
  log("✓ WS 已订阅");

  const seen = [];
  let done = false;
  let approved = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== "event") return;
    const ev = m.event;
    seen.push(ev.type);
    if (ev.type === "approval.request") {
      log(`↙ 审批请求 [${ev.kind}]`, (ev.command ?? "").slice(0, 60));
      // 自动批准每一个（演练模式）
      fetch(`${BASE}/api/v1/sessions/${id}/approvals/${ev.approvalId}`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ decision: "accept" }),
      })
        .then((r) => {
          if (r.ok) {
            approved++;
            log("→ 已批准", ev.approvalId.slice(0, 12));
          }
        })
        .catch(() => {});
    } else if (ev.type === "agent.delta") {
      process.stdout.write(ev.delta);
    } else if (ev.type === "session.status") {
      log("· 状态:", ev.status, ev.activity ?? "");
    } else if (ev.type === "tool.started" || ev.type === "tool.finished") {
      log("·", ev.type, (ev.target ?? "").slice(0, 50));
    }
    if (ev.type === "session.status" && (ev.status === "done" || ev.status === "error")) done = true;
  };

  // 等完成（自动批审批）
  const t1 = Date.now();
  while (!done && Date.now() - t1 < 180000) await sleep(1000);
  ws.close();

  // 6. 核对
  const audit = await (await fetch(`${BASE}/api/v1/audit`, { headers: auth })).json();
  const last = audit.entries[0];
  log("✓ 审计最新:", last?.decision, (last?.command ?? "").slice(0, 40));
  const file = Bun.file("F:/project/AgentLink/design/spike/scratch/e2e-ok.txt");
  const fileOk = await file.exists();
  log(fileOk ? `✓ 文件已创建，内容: ${await file.text()}` : "✗ 文件未找到");
  const counts = {};
  seen.forEach((t) => (counts[t] = (counts[t] ?? 0) + 1));
  log("事件统计:", JSON.stringify(counts));
  const ok = done && fileOk && approved >= 1 && last?.decision === "accept";
  console.log(ok ? "\n=== E2E 全流程通过 ===" : "\n=== E2E 未完全通过 ===");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E FAIL:", e.message);
  process.exit(1);
});
