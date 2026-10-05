import type {
  AuditListResponse,
  FsListResponse,
  SessionDetailResponse,
  SessionListResponse,
  StatusResponse,
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
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
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
    return this.request<{ session: unknown }>(`/api/v1/sessions/${id}/resume`, { method: "POST" });
  }
  sendMessage(id: string, text: string) {
    return this.request<{ ok: boolean }>(`/api/v1/sessions/${id}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }
  interrupt(id: string) {
    return this.request<{ ok: boolean }>(`/api/v1/sessions/${id}/interrupt`, { method: "POST" });
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
