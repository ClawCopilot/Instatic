# Instatic Hetzner VPS 部署及运维指南

> **编写日期**: 2026-07-04
> **适用版本**: Instatic v0.0.10+
> **方案评级**: ⭐⭐⭐⭐⭐（最灵活，性价比最高）

---

## 目录

1. [方案概览](#1-方案概览)
2. [前置准备](#2-前置准备)
3. [VPS 初始配置](#3-vps-初始配置)
4. [Docker 环境安装](#4-docker-环境安装)
5. [Instatic 部署](#5-instastic-部署)
6. [数据库配置](#6-数据库配置)
7. [域名与 TLS（Caddy）](#7-域名与-tlscaddy)
8. [环境变量配置](#8-环境变量配置)
9. [日常运维](#9-日常运维)
10. [备份策略](#10-备份策略)
11. [监控与告警](#11-监控与告警)
12. [安全加固](#12-安全加固)
13. [升级流程](#13-升级流程)
14. [故障排查](#14-故障排查)
15. [成本预估](#15-成本预估)

---

## 1. 方案概览

### 1.1 为什么选择 Hetzner VPS

| 优势 | 说明 |
|------|------|
| **性价比最高** | CX22: 2 vCPU, 4GB RAM, 40GB SSD — €3.99/月 |
| **完全控制** | root 权限，可安装任何软件 |
| **Docker Compose** | 项目已提供完整 compose 文件 |
| **固定 IP** | 每个 VPS 自带公网 IPv4 + IPv6 |
| **德国数据中心** | 欧盟隐私合规，延迟可接受（~200ms 从亚洲） |
| **无限流量** | 所有 VPS 均为无限出站流量（20TB 后限速） |

### 1.2 推荐规格

| VPS 型号 | vCPU | RAM | 存储 | 月费 | 适合场景 |
|----------|------|-----|------|------|---------|
| CX22 | 2 | 4 GB | 40 GB | €3.99 | 个人博客、小团队 CMS |
| CX32 | 4 | 8 GB | 80 GB | €7.99 | 中型站点、多站点 |
| CX42 | 8 | 16 GB | 160 GB | €15.99 | 大型站点、高流量 |

### 1.3 架构图

```
┌──────────────────────────────────────────┐
│              Hetzner VPS                  │
│                                           │
│  ┌─────────────────────────────────────┐ │
│  │           Caddy (反向代理)            │ │
│  │  :80 → 301 HTTPS                    │ │
│  │  :443 → TLS 终止 → 代理到 :3001     │ │
│  └──────────────┬──────────────────────┘ │
│                 │ HTTP :3001              │
│  ┌──────────────▼──────────────────────┐ │
│  │        Instatic (Docker)             │ │
│  │  oven/bun:1.3.11                    │ │
│  │  卷: uploads/, data/                 │ │
│  └──────────────┬──────────────────────┘ │
│                 │                         │
│  ┌──────────────▼──────────────────────┐ │
│  │     PostgreSQL 16 (Docker)           │ │
│  │  卷: postgres_data/                  │ │
│  └─────────────────────────────────────┘ │
│                                           │
│  或 SQLite 模式（无需 PostgreSQL）:       │
│  ┌──────────────────────────────────────┐ │
│  │  Instatic → /app/data/cms.db         │ │
│  └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

---

## 2. 前置准备

### 2.1 注册 Hetzner 账号

1. 访问 https://www.hetzner.com/cloud
2. 注册账号（需要身份验证）
3. 添加付款方式（信用卡/PayPal）

### 2.2 创建 VPS

1. Hetzner Cloud Console → "Create Server"
2. 选择数据中心（推荐：Nuremberg 或 Falkenstein，欧洲用户延迟最低；亚洲用户可选 Helsinki）
3. 选择操作系统：**Ubuntu 24.04 LTS**
4. 选择规格：**CX22**（€3.99/月）
5. 添加 SSH 密钥（推荐）或使用 root 密码
6. 可选：添加额外卷（Volume）用于备份存储
7. 点击 "Create & Buy Now"

### 2.3 SSH 连接

```bash
# 获取 VPS IP 地址（Hetzner Cloud Console → Server → IP Address）

# SSH 连接
ssh root@<VPS_IP>

# 或使用 SSH 密钥
ssh -i ~/.ssh/id_ed25519 root@<VPS_IP>
```

---

## 3. VPS 初始配置

### 3.1 系统更新

```bash
# 更新系统
apt update && apt upgrade -y

# 安装基础工具
apt install -y curl wget git vim htop ufw net-tools

# 设置时区
timedatectl set-timezone Asia/Shanghai  # 或 Europe/Berlin
```

### 3.2 创建非 root 用户（安全最佳实践）

```bash
# 创建用户
adduser instatic
usermod -aG sudo instatic

# 切换到新用户
su - instatic

# 设置 SSH 密钥（推荐）
mkdir -p ~/.ssh
chmod 700 ~/.ssh
# 将你的公钥添加到 ~/.ssh/authorized_keys
echo "ssh-ed25519 AAAA..." > ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 3.3 防火墙配置

```bash
# 配置 UFW
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # SSH
ufw allow 80/tcp      # HTTP
ufw allow 443/tcp     # HTTPS

# 如果使用 IPv6
ufw allow 22/tcp comment 'SSH'
ufw allow 80,443/tcp comment 'Web'

# 启用防火墙
ufw enable

# 验证
ufw status verbose
```

### 3.4 配置 Swap（低配 VPS 推荐）

```bash
# CX22 (4GB RAM) 配置 2GB swap
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 调整 swappiness
sysctl vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf
```

---

## 4. Docker 环境安装

### 4.1 安装 Docker

```bash
# 官方安装脚本
curl -fsSL https://get.docker.com | sh

# 将用户加入 docker 组（免 sudo）
sudo usermod -aG docker $USER

# 重新登录使权限生效
newgrp docker

# 验证安装
docker --version
docker compose version

# 设置开机自启
sudo systemctl enable docker
```

### 4.2 安装 Docker Compose（独立版，如果未包含）

```bash
# Docker 26+ 已内置 docker compose 插件
# 如需独立版：
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### 4.3 可选：安装 Caddy（不使用 Docker）

```bash
# 如果不使用 compose.tls.yml 中的 Docker Caddy
# 可以直接在宿主机安装 Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

---

## 5. Instatic 部署

### 5.1 克隆项目

```bash
# 进入工作目录
cd /opt
git clone https://github.com/clawcopilot/instatic.git
cd instatic
```

### 5.2 配置环境变量

```bash
# 复制生产环境变量模板
cp .env.production.example .env

# 编辑 .env
vim .env
```

最小化 `.env` 配置：

```bash
# ─── Image ────────────────────────────────────────────────
INSTATIC_IMAGE=ghcr.io/clawcopilot/instatic:latest

# ─── AI 加密密钥 ──────────────────────────────────────────
# 本地生成: bun run scripts/generate-secret-key.ts
INSTATIC_SECRET_KEY=<你的密钥>

# ─── 网络 ────────────────────────────────────────────────
HOST_PORT=3001

# ─── 数据库 — 选择 SQLite 或 Postgres ──────────────────────
# 选项 A: SQLite（简单模式，无需额外配置）
# POSTGRES_PASSWORD 留空即可，使用 compose.sqlite.yml

# 选项 B: Postgres（生产推荐）
POSTGRES_DB=instatic
POSTGRES_USER=instatic
POSTGRES_PASSWORD=<生成长随机密码>

# ─── TLS ────────────────────────────────────────────────
DOMAIN=cms.example.com
LETSENCRYPT_EMAIL=admin@example.com
```

### 5.3 生成密钥

在本地（开发机器）生成密钥：

```bash
# 本地项目目录
cd /path/to/instatic
bun run scripts/generate-secret-key.ts
# 输出示例: sk_v2_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6

# 将输出复制到 VPS 的 .env 文件中
```

### 5.4 方式 A：SQLite 模式（最简单）

```bash
# 启动（SQLite + TLS）
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.tls.yml up -d

# 查看日志
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.tls.yml logs -f

# 验证
curl -I https://cms.example.com/admin/
```

### 5.5 方式 B：PostgreSQL 模式（生产推荐）

```bash
# 确保 .env 中 POSTGRES_PASSWORD 已设置
# 启动（Postgres + TLS）
docker compose -f compose.prod.yml -f compose.tls.yml up -d

# 查看所有服务状态
docker compose -f compose.prod.yml -f compose.tls.yml ps

# 查看日志
docker compose -f compose.prod.yml -f compose.tls.yml logs -f

# 验证
curl -I https://cms.example.com/admin/
```

### 5.6 首次访问

1. 打开浏览器访问 `https://cms.example.com/admin/`
2. 创建管理员账号
3. 在 `/admin/ai/providers` 配置 AI 凭据

---

## 6. 数据库配置

### 6.1 SQLite 模式

- 数据库文件位置：`/opt/instatic/data/cms.db`（Docker volume: `data`）
- 无需额外配置
- 适合：单站点、低并发、内容量 < 10GB

### 6.2 PostgreSQL 模式

**连接信息（容器内）：**
- Host: `postgres`
- Port: `5432`
- Database: `instatic`
- User: `instatic`
- Password: 在 `.env` 中设置的 `POSTGRES_PASSWORD`

**手动连接：**
```bash
# 进入 PostgreSQL 容器
docker exec -it instatic-prod-postgres-1 psql -U instatic -d instatic

# 常用 SQL
\l                    # 列出数据库
\dt                   # 列出表
SELECT * FROM users;  # 查看用户
\q                    # 退出
```

### 6.3 数据库迁移

Instatic 启动时自动运行迁移（`server/index.ts:18`），无需手动操作。

---

## 7. 域名与 TLS（Caddy）

### 7.1 DNS 配置

在 DNS 服务商添加 A 记录：

```
类型: A    名称: cms    值: <VPS_IPv4>
类型: AAAA 名称: cms    值: <VPS_IPv6>  (可选)
```

等待 DNS 传播（通常 1-5 分钟）。

### 7.2 Caddy TLS 自动管理

`compose.tls.yml` 中的 Caddy 容器自动：

1. 从 Let's Encrypt 申请证书
2. HTTP → HTTPS 自动重定向
3. 证书到期前自动续期（Let's Encrypt 90 天有效期）

### 7.3 验证 TLS

```bash
# 检查证书
curl -vI https://cms.example.com 2>&1 | grep -A5 "SSL"

# 测试 SSL Labs 评分
# 访问 https://www.ssllabs.com/ssltest/analyze.html?d=cms.example.com
```

### 7.4 自定义 Caddyfile

如果需要更复杂的 Caddy 配置，编辑项目根目录的 `Caddyfile`：

```caddyfile
{$DOMAIN} {
    # 基础反向代理
    reverse_proxy app:3001

    # 安全头
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }

    # 日志
    log {
        output file /var/log/caddy/access.log
    }

    # 限流（可选）
    # rate_limit {
    #     zone dynamic {
    #         key {remote_host}
    #         events 100
    #         window 1m
    #     }
    # }
}
```

---

## 8. 环境变量配置

### 8.1 完整 .env 模板

```bash
# Instatic 生产环境配置
# 最后更新: 2026-07-04

# ─── 镜像 ────────────────────────────────────────────────
INSTATIC_IMAGE=ghcr.io/clawcopilot/instatic:latest

# ─── AI 加密密钥 ──────────────────────────────────────────
INSTATIC_SECRET_KEY=sk_v2_your_generated_secret_key_here

# ─── 网络 ────────────────────────────────────────────────
HOST_PORT=3001
TRUSTED_PROXY_CIDRS=172.16.0.0/12

# ─── 数据库 (Postgres 模式) ───────────────────────────────
POSTGRES_DB=instatic
POSTGRES_USER=instatic
POSTGRES_PASSWORD=<openssl rand -hex 24 生成的密码>

# ─── TLS ────────────────────────────────────────────────
DOMAIN=cms.example.com
LETSENCRYPT_EMAIL=admin@example.com

# ─── CSRF ────────────────────────────────────────────────
# compose.tls.yml 自动设置为 https://${DOMAIN}
# 如有多个域名，手动设置:
# PUBLIC_ORIGIN=https://cms.example.com,https://cms2.example.com
```

### 8.2 设置 AI 凭据

在 Instatic 管理面板 `/admin/ai/providers` 中添加 API Key，凭据使用 `INSTATIC_SECRET_KEY` 加密存储在数据库中。

---

## 9. 日常运维

### 9.1 Docker Compose 命令

```bash
# 进入项目目录
cd /opt/instatic

# 查看服务状态
docker compose -f compose.prod.yml -f compose.tls.yml ps

# 查看日志
docker compose -f compose.prod.yml -f compose.tls.yml logs -f --tail=100

# 重启所有服务
docker compose -f compose.prod.yml -f compose.tls.yml restart

# 重启单个服务
docker compose -f compose.prod.yml -f compose.tls.yml restart app

# 停止服务
docker compose -f compose.prod.yml -f compose.tls.yml down

# 启动服务
docker compose -f compose.prod.yml -f compose.tls.yml up -d

# 查看资源使用
docker stats
```

### 9.2 系统维护

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 清理 Docker 缓存
docker system prune -a --volumes -f

# 检查磁盘使用
df -h
du -sh /opt/instatic/data/
du -sh /var/lib/docker/

# 检查内存
free -h
htop
```

### 9.3 Docker Compose 别名（可选）

在 `~/.bashrc` 中添加：

```bash
alias dc-instastic='docker compose -f /opt/instatic/compose.prod.yml -f /opt/instatic/compose.tls.yml'
alias dc-instastic-logs='dc-instastic logs -f --tail=100'
alias dc-instastic-restart='dc-instastic restart'
alias dc-instastic-ps='dc-instastic ps'
```

重新加载：`source ~/.bashrc`

### 9.4 设置自动重启

`compose.prod.yml` 已配置 `restart: unless-stopped`，确保服务在系统重启后自动启动：

```bash
# 验证 Docker 开机自启
sudo systemctl is-enabled docker
# 应输出: enabled

# 确保 docker compose 服务在系统启动后自动恢复
# Docker 默认会恢复 restart: unless-stopped 的容器
```

---

## 10. 备份策略

### 10.1 PostgreSQL 自动备份脚本

创建 `/opt/scripts/backup-postgres.sh`：

```bash
#!/bin/bash
# Instatic PostgreSQL 备份脚本
# 用法: bash /opt/scripts/backup-postgres.sh
# 建议: crontab 每日执行

set -euo pipefail

BACKUP_DIR="/opt/backups/postgres"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/instatic-pg-${TIMESTAMP}.sql.gz"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

# 从 .env 读取密码
source /opt/instatic/.env

echo "[$(date)] 开始备份 PostgreSQL..."

docker exec instatic-prod-postgres-1 pg_dump \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB}" \
  --no-owner --no-acl \
  | gzip > "${BACKUP_FILE}"

echo "[$(date)] 备份完成: ${BACKUP_FILE} ($(du -h ${BACKUP_FILE} | cut -f1))"

# 清理旧备份
find "${BACKUP_DIR}" -name "instatic-pg-*.sql.gz" -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] 已清理 ${RETENTION_DAYS} 天前的备份"

# 可选: 上传到远程存储 (S3/R2/B2)
# aws s3 cp "${BACKUP_FILE}" "s3://my-backups/instatic/" --endpoint-url="https://xxx.r2.cloudflarestorage.com"
```

### 10.2 文件备份脚本

创建 `/opt/scripts/backup-files.sh`：

```bash
#!/bin/bash
# Instatic 文件备份脚本 (uploads + data 目录)

set -euo pipefail

BACKUP_DIR="/opt/backups/files"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/instatic-files-${TIMESTAMP}.tar.gz"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

echo "[$(date)] 开始备份 uploads 和 data 目录..."

# Docker volume 路径
UPLOADS_PATH=$(docker volume inspect instatic-prod_uploads --format '{{.Mountpoint}}' 2>/dev/null || echo "/var/lib/docker/volumes/instatic-prod_uploads/_data")

tar -czf "${BACKUP_FILE}" -C /opt/instatic uploads 2>/dev/null || true
# 如果是 Docker volume，使用上面的 UPLOADS_PATH
# tar -czf "${BACKUP_FILE}" -C "${UPLOADS_PATH}" . 2>/dev/null || true

echo "[$(date)] 文件备份完成: ${BACKUP_FILE} ($(du -h ${BACKUP_FILE} | cut -f1))"

find "${BACKUP_DIR}" -name "instatic-files-*.tar.gz" -mtime +${RETENTION_DAYS} -delete
```

### 10.3 设置定时任务

```bash
# 编辑 crontab
crontab -e

# 添加以下内容
# 每日凌晨 2:00 备份数据库
0 2 * * * bash /opt/scripts/backup-postgres.sh >> /opt/backups/backup.log 2>&1

# 每周日凌晨 3:00 备份文件
0 3 * * 0 bash /opt/scripts/backup-files.sh >> /opt/backups/backup.log 2>&1

# 每周一凌晨 4:00 清理 Docker
0 4 * * 1 docker system prune -a --volumes -f >> /opt/backups/cleanup.log 2>&1
```

### 10.4 异地备份（推荐）

将备份同步到外部存储：

```bash
# 方案 A: 使用 rclone 同步到 Google Drive / S3 / Backblaze B2
# 安装 rclone
curl https://rclone.org/install.sh | sudo bash

# 配置远程存储
rclone config

# 同步备份
rclone sync /opt/backups/ remote:instatic-backups/

# 方案 B: SCP 到另一台服务器
scp /opt/backups/postgres/instatic-pg-*.sql.gz user@backup-server:/backups/
```

### 10.5 恢复备份

**PostgreSQL 恢复：**
```bash
# 停止应用
docker compose -f /opt/instatic/compose.prod.yml -f /opt/instatic/compose.tls.yml stop app

# 恢复数据库
gunzip -c /opt/backups/postgres/instatic-pg-20260704.sql.gz | \
  docker exec -i instatic-prod-postgres-1 psql -U instatic -d instatic

# 启动应用
docker compose -f /opt/instatic/compose.prod.yml -f /opt/instatic/compose.tls.yml start app
```

---

## 11. 监控与告警

### 11.1 基础监控

```bash
# 系统资源
htop                         # 进程和 CPU
free -h                      # 内存
df -h                        # 磁盘
docker stats                 # Docker 容器资源
```

### 11.2 Docker 健康检查

`compose.prod.yml` 已配置健康检查：

```yaml
# Instatic 应用
healthcheck:
  test: ["CMD", "bun", "run", "server/healthcheck.ts"]
  interval: 30s
  timeout: 5s
  start_period: 20s
  retries: 3

# PostgreSQL
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U instatic -d instatic"]
  interval: 10s
  timeout: 5s
  retries: 10
```

查看健康状态：
```bash
docker compose -f compose.prod.yml -f compose.tls.yml ps
# HEALTH 列显示 healthy / unhealthy
```

### 11.3 安装 Netdata（推荐免费监控面板）

```bash
# 一键安装
curl https://get.netdata.cloud/kickstart.sh | sh

# 访问 http://<VPS_IP>:19999
# 建议配置 Nginx/Caddy 反向代理 + 基本认证保护
```

### 11.4 设置 Uptime 监控

使用免费的外部监控服务：
- **UptimeRobot**: https://uptimerobot.com（50 个监控免费）
- **Better Uptime**: https://betteruptime.com（免费心跳监控）
- **HetrixTools**: https://hetrixtools.com（15 个监控免费）

### 11.5 磁盘空间告警脚本

创建 `/opt/scripts/check-disk.sh`：

```bash
#!/bin/bash
# 磁盘空间检查 + 邮件告警

THRESHOLD=90  # 告警阈值（百分比）
ALERT_EMAIL="admin@example.com"

USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')

if [ "$USAGE" -gt "$THRESHOLD" ]; then
    echo "磁盘使用率: ${USAGE}%，超过阈值 ${THRESHOLD}%" | \
        mail -s "[告警] Instatic VPS 磁盘空间不足" "${ALERT_EMAIL}"
fi
```

---

## 12. 安全加固

### 12.1 SSH 安全

编辑 `/etc/ssh/sshd_config`：

```bash
# 禁用 root 密码登录
PermitRootLogin prohibit-password

# 禁用密码认证（仅密钥登录）
PasswordAuthentication no

# 更改 SSH 端口（可选，减少扫描）
Port 2222

# 重启 SSH
sudo systemctl restart sshd
```

### 12.2 自动安全更新

```bash
# 安装 unattended-upgrades
sudo apt install -y unattended-upgrades

# 配置自动安全更新
sudo dpkg-reconfigure unattended-upgrades
# 选择 "Yes"

# 验证配置
sudo systemctl status unattended-upgrades
```

### 12.3 Fail2Ban（防暴力破解）

```bash
# 安装
sudo apt install -y fail2ban

# 创建配置
sudo tee /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh

[instatic-auth]
enabled = true
filter = instatic-auth
logpath = /var/log/caddy/access.log
maxretry = 10
findtime = 300
bantime = 1800
EOF

# 启动
sudo systemctl enable fail2ban
sudo systemctl start fail2ban

# 查看状态
sudo fail2ban-client status
```

### 12.4 Docker 安全

```bash
# 定期扫描镜像漏洞
docker scan ghcr.io/clawcopilot/instatic:latest

# 限制容器资源（可选）
# 在 compose.prod.yml 的 app 服务中添加:
# deploy:
#   resources:
#     limits:
#       memory: 512M
```

---

## 13. 升级流程

### 13.1 拉取新镜像

```bash
cd /opt/instatic

# 拉取最新镜像
docker compose -f compose.prod.yml -f compose.tls.yml pull app

# 或拉取特定版本
# 修改 .env: INSTATIC_IMAGE=ghcr.io/clawcopilot/instatic:v0.0.11
docker compose -f compose.prod.yml -f compose.tls.yml pull app
```

### 13.2 滚动重启

```bash
# 停止旧容器，启动新容器
docker compose -f compose.prod.yml -f compose.tls.yml up -d app

# 查看启动日志
docker compose -f compose.prod.yml -f compose.tls.yml logs -f app
```

### 13.3 升级前备份（必须！）

```bash
# 1. 数据库备份
bash /opt/scripts/backup-postgres.sh

# 2. 文件备份
bash /opt/scripts/backup-files.sh

# 3. 执行升级
docker compose -f compose.prod.yml -f compose.tls.yml pull app
docker compose -f compose.prod.yml -f compose.tls.yml up -d app

# 4. 验证
curl -I https://cms.example.com/admin/
```

### 13.4 回滚

```bash
# 修改 .env 中的镜像版本
# INSTATIC_IMAGE=ghcr.io/clawcopilot/instatic:v0.0.10
vim /opt/instatic/.env

# 重新部署
docker compose -f compose.prod.yml -f compose.tls.yml up -d app

# 如果数据库迁移不兼容，从备份恢复
# 见 10.5 节
```

---

## 14. 故障排查

### 14.1 服务无法启动

```bash
# 查看所有容器状态
docker compose -f compose.prod.yml -f compose.tls.yml ps -a

# 查看应用日志
docker compose -f compose.prod.yml -f compose.tls.yml logs app --tail=50

# 查看 PostgreSQL 日志
docker compose -f compose.prod.yml -f compose.tls.yml logs postgres --tail=50

# 查看 Caddy 日志
docker compose -f compose.prod.yml -f compose.tls.yml logs caddy --tail=50
```

### 14.2 数据库连接失败

```bash
# 检查 PostgreSQL 是否运行
docker compose -f compose.prod.yml -f compose.tls.yml ps postgres

# 测试连接
docker exec instatic-prod-postgres-1 pg_isready -U instatic -d instatic

# 检查 DATABASE_URL 是否正确
docker compose -f compose.prod.yml -f compose.tls.yml exec app env | grep DATABASE_URL
```

### 14.3 TLS 证书问题

```bash
# 检查 Caddy 证书状态
docker compose -f compose.prod.yml -f compose.tls.yml logs caddy | grep -i cert

# 确认 DNS 已正确指向 VPS IP
dig cms.example.com +short
# 应返回 VPS IP

# 确认 80 和 443 端口可达
curl -I http://cms.example.com  # 应返回 301 重定向
```

### 14.4 磁盘空间不足

```bash
# 检查磁盘
df -h

# 清理 Docker
docker system prune -a --volumes -f

# 清理旧日志
sudo journalctl --vacuum-size=200M

# 查找大文件
du -sh /opt/instatic/* | sort -h
du -sh /var/lib/docker/volumes/* | sort -h
```

### 14.5 内存不足

```bash
# 查看内存使用
free -h
docker stats --no-stream

# 如果内存不足，调整 swap
# 见 3.4 节

# 或升级 VPS（Hetzner Cloud Console → Server → Rescale）
```

---

## 15. 成本预估

### 15.1 VPS 费用

| 型号 | vCPU | RAM | 存储 | 月费 |
|------|------|-----|------|------|
| CX22 | 2 | 4 GB | 40 GB | **€3.99** |
| CX32 | 4 | 8 GB | 80 GB | €7.99 |
| CX42 | 8 | 16 GB | 160 GB | €15.99 |

### 15.2 附加费用

| 项目 | 费用 |
|------|------|
| 额外 Volume（10GB） | €0.44/月 |
| 快照备份 | €0.012/GB/月 |
| 浮动 IP | €1.43/月（通常不需要） |
| 额外 IPv4 | €0.57/月 |
| 出站流量（20TB+） | 免费（超量后 1Gbps→10Mbps 限速） |

### 15.3 总成本

| 方案 | 月度费用 |
|------|---------|
| 最低配置（CX22 + SQLite） | **€3.99**（~¥32） |
| 推荐配置（CX22 + Postgres） | **€3.99**（~¥32） |
| 备份存储（10GB Volume） | **€4.43**（~¥35） |
| 中型站点（CX32） | **€7.99**（~¥64） |

### 15.4 与其他方案对比

| 方案 | 月费 | RAM | CPU | 存储 | 自由度 |
|------|------|-----|-----|------|--------|
| **Hetzner CX22** | **€3.99** | 4GB | 2 vCPU | 40GB | ⭐⭐⭐⭐⭐ |
| Fly.io 免费 | $0 | 256MB | 1 共享 | 3GB | ⭐⭐⭐ |
| Railway | $5 | 512MB | 1 vCPU | 包含 | ⭐⭐⭐⭐ |
| Vultr 最低 | $6 | 1GB | 1 vCPU | 25GB | ⭐⭐⭐⭐⭐ |
| DigitalOcean | $6 | 1GB | 1 vCPU | 25GB | ⭐⭐⭐⭐⭐ |

**结论：Hetzner CX22 是性价比之王**，€3.99/月获得 4GB RAM + 2 vCPU + 40GB SSD，远超同价位竞品。

---

## 附录 A: 完整部署脚本

```bash
#!/bin/bash
# Instatic Hetzner VPS 一键部署脚本
# 适用于: Ubuntu 24.04 LTS, 全新 VPS
# 最后更新: 2026-07-04

set -euo pipefail

# ─── 配置变量（根据实际情况修改） ───
DOMAIN="cms.example.com"
EMAIL="admin@example.com"
INSTATIC_SECRET_KEY=""  # 稍后设置

# ─── 系统初始化 ───
echo "=== 1. 系统更新 ==="
apt update && apt upgrade -y
apt install -y curl wget git vim htop ufw

timedatectl set-timezone Asia/Shanghai

# ─── 防火墙 ───
echo "=== 2. 配置防火墙 ==="
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ─── Docker ───
echo "=== 3. 安装 Docker ==="
curl -fsSL https://get.docker.com | sh
systemctl enable docker

# ─── 克隆项目 ───
echo "=== 4. 克隆 Instatic ==="
cd /opt
git clone https://github.com/clawcopilot/instatic.git
cd instatic

# ─── 配置 .env ───
echo "=== 5. 配置环境变量 ==="
POSTGRES_PASSWORD=$(openssl rand -hex 24)

cat > .env << EOF
INSTATIC_IMAGE=ghcr.io/clawcopilot/instatic:latest
INSTATIC_SECRET_KEY=${INSTATIC_SECRET_KEY:-REPLACE_WITH_GENERATED_KEY}
HOST_PORT=3001
TRUSTED_PROXY_CIDRS=172.16.0.0/12
POSTGRES_DB=instatic
POSTGRES_USER=instatic
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
DOMAIN=${DOMAIN}
LETSENCRYPT_EMAIL=${EMAIL}
EOF

echo "请在部署前设置 INSTATIC_SECRET_KEY！"
echo "本地生成: bun run scripts/generate-secret-key.ts"

# ─── 启动服务 ───
echo "=== 6. 启动服务 ==="
docker compose -f compose.prod.yml -f compose.tls.yml up -d

# ─── 验证 ───
echo "=== 7. 等待服务启动 ==="
sleep 30
docker compose -f compose.prod.yml -f compose.tls.yml ps
echo ""
echo "部署完成！访问: https://${DOMAIN}/admin/"
echo "请设置 INSTATIC_SECRET_KEY 并重启服务:"
echo "  vim /opt/instatic/.env"
echo "  docker compose -f compose.prod.yml -f compose.tls.yml up -d app"
```

## 附录 B: 快速部署检查清单

- [ ] VPS 已创建，SSH 可连接
- [ ] 系统已更新 (`apt update && apt upgrade`)
- [ ] 防火墙已配置 (UFW: 22, 80, 443)
- [ ] Docker 和 Docker Compose 已安装
- [ ] Swap 已配置（推荐）
- [ ] Instatic 已克隆到 `/opt/instatic`
- [ ] `.env` 文件已正确配置
- [ ] `INSTATIC_SECRET_KEY` 已生成并设置
- [ ] `POSTGRES_PASSWORD` 已设置强随机密码
- [ ] DNS A 记录已指向 VPS IP
- [ ] `DOMAIN` 已正确设置
- [ ] `docker compose up -d` 启动成功
- [ ] 浏览器访问 `https://<domain>/admin/` 正常
- [ ] Let's Encrypt 证书已签发
- [ ] 备份脚本已创建并配置 cron
- [ ] 异地备份已配置（推荐）
- [ ] 监控已配置（UptimeRobot / Netdata）
- [ ] Fail2Ban 已安装和配置
- [ ] SSH 密码登录已禁用（仅密钥）
- [ ] 自动安全更新已启用
