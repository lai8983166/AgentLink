/**
 * 桌面端 IPC 协议常量（design/desktop-takeover-verification.md 实测，2026-10-06）。
 * 通道：\\.\pipe\codex-ipc；帧 = 4 字节小端长度 + JSON。
 * 注意：内部接口，无稳定性承诺——桌面升级需跑 slow 兼容性回归（任务 6.1）。
 */

export const CODEX_PIPE = "\\\\.\\pipe\\codex-ipc";

/** follower 方法与其实测协议版本号 */
export const IpcMethod = {
  initialize: "initialize",
  threadOwnerDiscovery: "thread-owner-discovery",
  threadFollowerStartTurn: "thread-follower-start-turn",
  threadFollowerInterruptTurn: "thread-follower-interrupt-turn",
  threadFollowerCommandApprovalDecision: "thread-follower-command-approval-decision",
  threadFollowerFileApprovalDecision: "thread-follower-file-approval-decision",
} as const;
export type IpcMethod = (typeof IpcMethod)[keyof typeof IpcMethod];

export const IPC_VERSIONS: Record<string, number> = {
  [IpcMethod.initialize]: 0,
  [IpcMethod.threadOwnerDiscovery]: 1,
  [IpcMethod.threadFollowerStartTurn]: 2,
  [IpcMethod.threadFollowerInterruptTurn]: 4,
  [IpcMethod.threadFollowerCommandApprovalDecision]: 1,
  [IpcMethod.threadFollowerFileApprovalDecision]: 1,
};

/** 订阅/退订经定向 broadcast（非 request） */
export const BROADCAST_FOLLOWING = "thread-stream-following-changed";

/** 状态下发 broadcast：params.change.type === 'snapshot' → conversationState */
export const BROADCAST_STATE = undefined; // 桌面推送的 broadcast 不带统一方法名，按 type 字段分发

export interface IpcRequest {
  type: "request";
  requestId: string;
  sourceClientId: string;
  version: number;
  method: string;
  params?: unknown;
  targetClientId?: string;
  timeoutMs?: number;
}

export interface IpcResponse {
  type: "response";
  requestId: string;
  result?: unknown;
  error?: { message?: string };
  [k: string]: unknown;
}

export interface IpcBroadcast {
  type: "broadcast";
  sourceClientId: string;
  targetClientIds?: string[];
  method?: string;
  version?: number;
  params?: {
    conversationId?: string;
    change?: { type?: string; conversationState?: ConversationState };
    [k: string]: unknown;
  };
}

export interface IpcClientDiscoveryRequest {
  type: "client-discovery-request";
  requestId: string;
  [k: string]: unknown;
}

/** conversationState（快照核心结构，防御性可选字段） */
export interface ConversationState {
  id?: string;
  forkedFromId?: string | null;
  title?: string;
  revision?: number;
  latestThreadSettings?: { approvalPolicy?: string } | null;
  turnHistory?: {
    history?: {
      entitiesByKey?: Record<
        string,
        {
          turnId?: string;
          status?: string;
          items?: IpcTurnItem[];
          /** 原始轮次请求参数（start-turn 模板，实测字段） */
          params?: Record<string, unknown>;
          [k: string]: unknown;
        }
      >;
    };
  };
  /** 挂起的请求（含审批） */
  requests?: IpcPendingRequest[];
}

export interface IpcTurnItem {
  type?: string;
  status?: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
  changes?: Array<{ path?: string; added?: number; removed?: number }>;
  [k: string]: unknown;
}

export interface IpcPendingRequest {
  id?: string | number;
  kind?: string;
  command?: string;
  cwd?: string;
  reason?: string | null;
  availableDecisions?: Array<string | Record<string, unknown>>;
  [k: string]: unknown;
}
