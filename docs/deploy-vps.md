# AgentLink 外网部署指南（VPS + frp + Caddy + ntfy）

> 目标：手机在外面（4G/5G）也能安全遥控家里的 PC。局域网内零配置直连，无需本文。
> 全程约 1 小时。前提：一台国内 VPS（1 核 1G 足够）、一个域名（可选，见路线 B）。

## 架构

```
手机(4G) ──HTTPS/WSS──> VPS [Caddy:443] ──反代──> frps ⟷ 隧道 ⟷ frpc(家里PC) ⟷ agentlink daemon :8787
                                        └──> ntfy :80/443（推送，仅手机 ntfy App 访问）
家里(同一 WiFi) ──HTTP──> http://<PC内网IP>:8787（直连，免中继）
```

## 一、VPS 侧

### 1. 选型要点

- 国内厂商（阿里/腾讯/京东云的轻量），地域选离你近的
- 1 核 1G / 40G 盘足够（只跑 frp + Caddy + ntfy）
- **路线 A（域名 + 443）**：域名需完成 ICP 备案才能绑国内 VPS 的 80/443
- **路线 B（无备案，非标端口）**：不占 80/443，用 8443 等高位端口，Caddy 用 TLS-ALPN 或自签
  （手机访问 `https://vps-ip:8443`，接受一次自签告警；或用 DNS 挑战签 Let's Encrypt 泛域名证书同样可行——域名解析到 VPS 但不碰 80/443 不触发备案拦截）

### 2. frp 服务端（frps）

```toml
# /etc/frp/frps.toml
bindPort = 7000
# 鉴权：随机一串
auth.token = "换成随机长字符串"
```

```bash
# systemd 开机自启（frp 官方 release 解压到 /opt/frp）
cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server
After=network.target
[Service]
ExecStart=/opt/frp/frps -c /etc/frp/frps.toml
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now frps
```

### 3. Caddy（HTTPS 反代 + 自动证书）

```caddyfile
# /etc/caddy/Caddyfile —— 路线 A（有备案域名）
agent.example.com {
    reverse_proxy 127.0.0.1:18787   # frps 暴露的 daemon 端口
}
```

```caddyfile
# 路线 B（无域名，非标端口 + 自签）
https://vps-ip:8443 {
    tls internal
    reverse_proxy 127.0.0.1:18787
}
```

frps 里把隧道暴露到本机回环（只允许经 Caddy 进）：

```toml
# frps 追加（配合 frpc 的代理声明）
# 无需额外配置，frpc 侧 remotePort 决定
```

```bash
apt install -y caddy && systemctl enable --now caddy
```

### 4. ntfy 自托管（推送）

```bash
# 用官方二进制最简单
useradd -r ntfy || true
wget https://github.com/binwiederhier/ntfy/releases/latest/download/ntfy_linux_amd64 -O /usr/local/bin/ntfy
chmod +x /usr/local/bin/ntfy
mkdir -p /etc/ntfy /var/cache/ntfy
cat > /etc/ntfy/server.yml <<'EOF'
base-url: "https://ntfy.example.com"   # 或 http://vps-ip:2586
listen-http: ":2586"
cache-file: "/var/cache/ntfy/cache.db"
attachment-cache-dir: "/var/cache/ntfy/attachments"
EOF
cat > /etc/systemd/system/ntfy.service <<'EOF'
[Unit]
Description=ntfy push
After=network.target
[Service]
User=ntfy
ExecStart=/usr/local/bin/ntfy serve
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now ntfy
```

手机 ntfy App → 设置 → 默认服务器 → 填 `https://ntfy.example.com`（或 `http://vps-ip:2586`）。
随机主题名即基本鉴权（v0）；要更强可给 ntfy 加 `auth-file` + access token。

## 二、家里 PC 侧

### 1. frpc

```toml
# %USERPROFILE%\frp\frpc.toml
serverAddr = "VPS的IP"
serverPort = 7000
auth.token = "同 frps"

[[proxies]]
name = "agentlink"
type = "tcp"
remotePort = 18787          # VPS 上监听的端口（Caddy 反代它）
[[proxies]]
name = "agentlink-ws-direct"  # 备用：非标端口直连（跳过 Caddy，无 TLS，不推荐长期用）
type = "tcp"
remotePort = 18788
```

用任务计划程序设置开机自启（`frpc.exe -c frpc.toml`），或放进启动文件夹。

### 2. daemon 配置

编辑 `~/.agentlink/config.toml`：

```toml
[ntfy]
enabled = true
url = "https://ntfy.example.com"        # 你的 ntfy
topicPrefix = "al-换成随机串"            # 主题前缀即口令，随机化
clickBase = "https://agent.example.com" # 路线 B 则 https://vps-ip:8443
```

### 3. daemon 自启动与休眠

- 任务计划程序 → 创建基本任务 → 登录时运行：
  `bun run F:\project\AgentLink\daemon\src\index.ts`
  （起始于 `F:\project\AgentLink`）
- daemon 自带 Windows 保活（`keepAlive = true`，阻止休眠）；若想允许休眠只在唤醒后可用，设为 false
- 电源计划建议：插电时"从不睡眠"（保活只是双保险）

## 三、手机配置

1. 局域网：浏览器打开 `http://<PC内网IP>:8787` → 粘贴 token 配对 → 添加到主屏幕
2. 外网：打开 `https://agent.example.com`（或路线 B 的 `https://vps-ip:8443`）→ 同一 token 配对
3. ntfy App 订阅两个主题：`<topicPrefix>-approval`、`<topicPrefix>-task`（默认服务器指向你的 ntfy）

> 同一 token 两处通用：数据同源，切换局域网/外网只是换地址。

## 四、验证清单

- [ ] VPS：`curl http://127.0.0.1:18787/api/v1/health` 返回 ok（隧道通）
- [ ] 手机 4G：打开外网地址能登录、能看到会话列表
- [ ] 派一个 untrusted 小任务 → 手机锁屏 → 收到 ntfy 审批推送 → 点通知直达审批卡 → 批准 → 会话 done
- [ ] 家里 WiFi：切回局域网地址直连正常
- [ ] `~/.agentlink/audit.db` 有刚才的审批记录

## 五、安全边界（务必读）

1. token 是唯一门户：`POST /api/v1/admin/token/rotate` 可随时轮换（所有端立即失效重配对）
2. 审批是第二道防线：策略保持 `untrusted`/`on-request`，即便 token 泄露，删文件/执行命令仍需手机点批准
3. frp 只暴露 18787（经 Caddy 的 TLS）；18788 明文备用口平时可在 frpc 里注释掉
4. ntfy 主题名随机化等同口令；介意可上 ntfy access token
5. 局域网 HTTP 是明文（家用环境可接受）；外网全程 HTTPS
