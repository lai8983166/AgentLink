# Spec Delta

## Purpose

定义手机端接入家里 daemon 的网络层行为：局域网直连与国内 VPS frp 中继并存，token 认证强制，附可跟做的部署文档。

## ADDED Requirements

### Requirement: 局域网直连
daemon SHALL 在局域网地址上提供完整 API、WebSocket 与 PWA 静态资源，手机在同一网络时零配置直连使用。

#### Scenario: 同一 WiFi 直接访问
- **WHEN** 手机与 PC 在同一局域网，访问 daemon 地址
- **THEN** PWA 可加载，API 与 WS 全部可用

### Requirement: 外网中继接入
经国内 VPS 上的 frp 服务端中继，daemon 的 API 与 WS SHALL 可从外网访问；HTTPS SHALL 在 VPS 终结，手机侧统一使用 HTTPS/WSS 访问。

#### Scenario: 4G 网络下使用
- **WHEN** 手机在外网访问 VPS 域名
- **THEN** 经 frp 隧道可达 daemon，PWA、API、WS 全部可用

#### Scenario: 中继与直连自动并存
- **WHEN** 手机从外网回到家里 WiFi
- **THEN** 可继续用局域网地址直连（同一 token、同一数据），两条通道互不冲突

### Requirement: token 认证强制
除健康检查与首次配对端点外，所有 REST API 与 WebSocket 访问 SHALL 要求有效 token；无效或缺失 token 返回 401 且不泄露资源信息。token SHALL 可在 daemon 侧轮换，轮换后旧 token 立即失效。

#### Scenario: 无 token 访问被拒
- **WHEN** 不带 token 请求任意业务 API
- **THEN** 返回 401，响应体不包含业务数据

#### Scenario: WS 同样强制认证
- **WHEN** WebSocket 连接未认证
- **THEN** 连接被关闭，事件流不可用

### Requirement: 明文传输风险控制
局域网默认 HTTP 时，部署文档 SHALL 说明明文风险与局域网内启用 TLS 的选项；外网通道 MUST 全程 HTTPS/WSS。

#### Scenario: 外网无明文
- **WHEN** 检查外网链路
- **THEN** 手机到 VPS 一段为 HTTPS/WSS，无明文端口暴露业务 API

### Requirement: 部署文档
项目 SHALL 提供部署文档，覆盖：VPS 选型要点、frp 服务端/客户端配置、HTTPS 证书方案（含无域名备案场景的替代）、ntfy 自托管部署、daemon 开机自启与休眠策略。

#### Scenario: 按文档可从零部署
- **WHEN** 用户按文档在一台新 VPS 上操作
- **THEN** 能完成 frp + HTTPS + ntfy + daemon 的完整部署并从外网访问
