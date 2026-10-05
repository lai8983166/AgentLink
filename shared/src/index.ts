// @agentlink/shared：API 契约包（REST/WS/事件），daemon 与 web 共用
export const SHARED_VERSION = "0.1.0";

export * from "./errors";
export * from "./domain";
export * from "./events";
export * from "./rest";
export * from "./ws";
