import { themedStyle, uiTheme } from "../../../shared/src/ui-theme";
import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalPolicy, FsEntry } from "@agentlink/shared";
import { api } from "../runtime";
import { useVisibleViewport } from "../visible-viewport";

/** 新任务 Sheet（任务 7.6）：项目选择 + 策略三档 + 描述 */
const POLICY: Array<{ key: ApprovalPolicy; label: string }> = [
  { key: "untrusted", label: "每次询问" },
  { key: "on-request", label: "失败时询问" },
  { key: "never", label: "全自动" },
];

export function NewTaskSheet({ onClose }: { onClose: () => void }) {
  const viewportStyle = useVisibleViewport();
  const sheetRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && sheetRef.current?.contains(active)) {
      active.scrollIntoView?.({ block: "nearest" });
    }
  }, [viewportStyle.height, viewportStyle.top]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [policy, setPolicy] = useState<ApprovalPolicy>("on-request");
  const [prompt, setPrompt] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fsQ = useQuery({
    queryKey: ["fs", path],
    queryFn: () => api.fs(path),
    enabled: browsing,
  });

  const create = useMutation({
    mutationFn: () =>
      api.createSession({ projectPath: path || recent[0] || "", approvalPolicy: policy, prompt }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onClose();
      navigate(`/${res.id}`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "创建失败"),
  });

  const recent = (fsQ.data?.path ?? "").split(/[\\/]/).filter(Boolean);
  const dirs = (fsQ.data?.entries ?? []).filter((e) => e.kind === "dir");

  return (
    <div
      style={themedStyle({
        ...viewportStyle,
        zIndex: 50,
        background: "rgba(48,38,12,.5)",
        display: "flex",
        alignItems: "flex-end",
      })}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="collage-panel"
        ref={sheetRef}
        style={themedStyle({
          background: "#fffdf6",
          borderTop: "2px solid var(--border)",
          borderRadius: "22px 22px 0 0",
          padding: "8px 18px max(30px, env(safe-area-inset-bottom))",
          maxHeight: "82%",
          overflowY: "auto",
          width: "100%",
        })}
      >
        <div style={themedStyle({ width: 38, height: 4, borderRadius: 2, background: "#d8ccaa", margin: "4px auto 14px" })} />
        <h3 className="collage-title" style={themedStyle({ fontSize: 17, fontWeight: 700, marginBottom: 14 })}>新任务</h3>

        <div className="section-label" style={themedStyle({ marginTop: 0 })}>项目</div>
        {!browsing ? (
          <div
            style={themedStyle({
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 13px",
              border: "1.5px solid var(--border)",
              borderRadius: 12,
              marginBottom: 9,
              background: "var(--gold-bg)",
              cursor: "pointer",
              boxShadow: "2px 2px 0 rgba(34,28,14,.85)",
            })}
            onClick={() => setBrowsing(true)}
          >
            <span>📁</span>
            <div style={themedStyle({ flex: 1 })}>
              <div style={themedStyle({ fontSize: 14, fontWeight: 550 })}>{path || "选择项目目录"}</div>
              {path && <div style={themedStyle({ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" })}>{path}</div>}
            </div>
            <span>✓</span>
          </div>
        ) : (
          <>
            <div style={themedStyle({ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)", marginBottom: 8, wordBreak: "break-all" })}>
              {fsQ.data?.path ?? "白名单根目录"}
            </div>
            {(fsQ.data ? dirs : []).map((e) => (
              <DirRow
                key={e.path}
                entry={e}
                onPick={() => {
                  setPath(e.path);
                  setBrowsing(false);
                }}
              />
            ))}
            <div
              style={themedStyle({ fontSize: 12, color: "var(--text-dim)", padding: "10px 0", cursor: "pointer", textDecoration: "underline dotted" })}
              onClick={() => (fsQ.data?.path ? setPath(fsQ.data.path) : null)}
            >
              就用当前目录
            </div>
          </>
        )}

        <div className="section-label">Agent</div>
        <div style={themedStyle({ display: "flex", alignItems: "center", gap: 10, padding: "12px 13px", border: "1.5px solid var(--border)", borderRadius: 12, marginBottom: 9, background: "var(--gold-bg)" })}>
          <span>⚡</span>
          <div style={themedStyle({ flex: 1 })}>
            <div style={themedStyle({ fontSize: 14, fontWeight: 550 })}>Codex</div>
            <div style={themedStyle({ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "var(--mono)" })}>ChatGPT 订阅</div>
          </div>
          <span>✓</span>
        </div>

        <div className="section-label">
          审批策略 <small style={themedStyle({ color: "var(--text-faint)", fontWeight: 400 })}>可随时在会话中修改</small>
        </div>
        <div style={themedStyle({ display: "flex", background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: 12, padding: 3, gap: 3 })}>
          {POLICY.map((p) => (
            <div
              key={p.key}
              onClick={() => setPolicy(p.key)}
              style={themedStyle({
                flex: 1,
                textAlign: "center",
                fontSize: 12.5,
                padding: "8px 4px",
                borderRadius: 9,
                cursor: "pointer",
                fontWeight: policy === p.key ? 700 : 550,
                color: policy === p.key ? uiTheme.onPrimary : "var(--text-dim)",
                background: policy === p.key ? uiTheme.primary : undefined,
                border: policy === p.key ? "1px solid var(--border)" : undefined,
                boxShadow: policy === p.key ? "1.5px 1.5px 0 var(--border)" : undefined,
              })}
            >
              {p.label}
            </div>
          ))}
        </div>

        <div className="section-label">任务描述</div>
        <textarea
          aria-label="任务描述"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述你想让它做的事，可粘贴报错、需求…"
          style={themedStyle({
            width: "100%",
            minHeight: 88,
            background: "var(--surface)",
            border: "1.5px solid var(--border)",
            borderRadius: 13,
            padding: 12,
            fontSize: 16,
            outline: "none",
            fontFamily: "var(--sans)",
            resize: "none",
            lineHeight: 1.6,
          })}
        />

        {error && <div style={themedStyle({ color: "var(--red)", fontSize: 12, marginTop: 8, fontFamily: "var(--mono)" })}>{error}</div>}
        <div style={themedStyle({ height: 14 })} />
        <button
          className="btn"
          style={themedStyle({ width: "100%" })}
          disabled={!prompt.trim() || !path || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "创建中…" : "开始任务"}
        </button>
      </div>
    </div>
  );
}

function DirRow({ entry, onPick }: { entry: FsEntry; onPick: () => void }) {
  return (
    <div
      onClick={onPick}
      style={themedStyle({
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 13px",
        border: "1.5px solid var(--border)",
        borderRadius: 12,
        marginBottom: 8,
        background: "var(--surface)",
        cursor: "pointer",
      })}
    >
      <span>📂</span>
      <div style={themedStyle({ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 550 })}>{entry.name}</div>
      <span style={themedStyle({ marginLeft: "auto", color: "var(--text-faint)" })}>›</span>
    </div>
  );
}
