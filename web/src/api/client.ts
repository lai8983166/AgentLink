import type {
  AuditListResponse,
  FsListResponse,
  SessionDetailResponse,
  SessionListResponse,
  StatusResponse,
  MessageReceipt,
} from "@agentlink/shared";

/** daemon REST 客户端：token + 错误 envelope 解析 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl = "",
    private readonly getToken: () => string | null,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20000);
    try {
    const token = this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
    const body = (await res.json().catch(() => null)) as
      | (T & { error?: { code: string; message: string } })
      | null;
    if (!res.ok) {
      const err = body?.error;
      throw new ApiError(err?.code ?? "INTERNAL", err?.message ?? `HTTP ${res.status}`, res.status);
    }
    return body as T;
    } catch (e) {
      if (controller.signal.aborted) throw new ApiError("REQUEST_TIMEOUT", "请求超时，请核对操作是否已被电脑接收", 0);
      throw e;
    } finally { clearTimeout(timer); }
  }

  status() {
    return this.request<StatusResponse>("/api/v1/status");
  }
  sessions() {
    return this.request<SessionListResponse>("/api/v1/sessions");
  }
  sessionDetail(id: string) {
    return this.request<SessionDetailResponse>(`/api/v1/sessions/${id}`);
  }
  resume(id: string) {
    return this.request<SessionDetailResponse>(`/api/v1/sessions/${id}/resume`, { method: "POST" });
  }
  sendMessage(id: string, text: string, clientMessageId?: string) {
    return this.request<{ ok: boolean; receipt?: MessageReceipt }>(`/api/v1/sessions/${id}/message`, {
      method: "POST",
      body: JSON.stringify({ text, clientMessageId }),
    });
  }
  messageReceipt(id: string, clientMessageId: string) {
    return this.request<{ receipt: MessageReceipt | null }>(`/api/v1/sessions/${id}/messages/${encodeURIComponent(clientMessageId)}`);
  }
  interrupt(id: string) {
    return this.request<{ ok: boolean }>(`/api/v1/sessions/${id}/interrupt`, { method: "POST" });
  }
  observe(id: string, mode: "observe" | "takeover" = "observe") {
    return this.request<{ ok: boolean; mode: string }>(`/api/v1/sessions/${id}/observe`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
  }
  takeover(id: string) {
    return this.request<{ ok: boolean }>(`/api/v1/sessions/${id}/takeover`, { method: "POST" });
  }
  unobserve(id: string) {
    return this.request<{ ok: boolean }>(`/api/v1/sessions/${id}/unobserve`, { method: "POST" });
  }
  fork(id: string, approvalPolicy?: string) {
    return this.request<{ id: string }>(`/api/v1/sessions/${id}/fork`, {
      method: "POST",
      body: JSON.stringify(approvalPolicy ? { approvalPolicy } : {}),
    });
  }
  setPolicy(id: string, approvalPolicy: "untrusted" | "on-request" | "never") {
    return this.request<{ ok: boolean }>(`/api/v1/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ approvalPolicy }),
    });
  }
  createSession(input: { projectPath: string; approvalPolicy: string; prompt: string }) {
    return this.request<{ id: string }>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  decideApproval(sessionId: string, approvalId: string, decision: string) {
    return this.request<{ ok: boolean }>(`/api/v1/sessions/${sessionId}/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  }
  fs(path: string) {
    return this.request<FsListResponse>(`/api/v1/fs?path=${encodeURIComponent(path)}`);
  }
  audit(cursor: number | null, limit = 50) {
    return this.request<AuditListResponse>(
      `/api/v1/audit?${cursor ? `cursor=${cursor}&` : ""}limit=${limit}`,
    );
  }
}
