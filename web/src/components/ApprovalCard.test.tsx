import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";
import { api } from "../runtime";

vi.mock("../runtime", () => ({
  api: { decideApproval: vi.fn().mockResolvedValue({ ok: true }) },
  ws: { subscribe: vi.fn(() => () => {}), onSnapshotRequired: () => {} },
}));

describe("ApprovalCard（任务 7.5）", () => {
  const base = {
    approvalId: "a1",
    kind: "command" as const,
    command: "npm install",
    cwd: "F:/x",
    reason: null,
    availableDecisions: ["accept", "cancel"] as Array<string | Record<string, unknown>>,
  };

  test("按 availableDecisions 渲染：只有批准，无拒绝（agent 继续）", () => {
    render(<ApprovalCard a={base} sessionId="s1" resolved={null} onResolved={() => {}} />);
    expect(screen.getByText("批准")).toBeTruthy();
    expect(screen.queryByText("拒绝")).toBeNull();
    expect(screen.queryByText("批准，且本会话内不再询问此类操作")).toBeNull();
  });

  test("完整四项时的主次按钮与次级入口", () => {
    render(
      <ApprovalCard
        a={{ ...base, availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] }}
        sessionId="s1"
        resolved={null}
        onResolved={() => {}}
      />,
    );
    expect(screen.getByText("批准")).toBeTruthy();
    expect(screen.getByText("拒绝")).toBeTruthy();
    expect(screen.getByText("批准，且本会话内不再询问此类操作")).toBeTruthy();
  });

  test("点击批准 → 调 API + onResolved", async () => {
    const onResolved = vi.fn();
    render(<ApprovalCard a={base} sessionId="s1" resolved={null} onResolved={onResolved} />);
    fireEvent.click(screen.getByText("批准"));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("a1", "accept"));
    expect(api.decideApproval).toHaveBeenCalledWith("s1", "a1", "accept");
  });

  test("已决态只读展示", () => {
    render(<ApprovalCard a={base} sessionId="s1" resolved={{ decision: "accept" }} onResolved={() => {}} />);
    expect(screen.getByText(/已批准/)).toBeTruthy();
    expect(screen.queryByText("批准")).toBeNull();
  });
});
