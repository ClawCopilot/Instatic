# Instatic Fly.io 部署及运维指南

> **编写日期**: 2026-07-04
> **适用版本**: Instatic v0.0.10+
> **方案评级**: ⭐⭐⭐⭐⭐（最佳免费方案）

---

## 目录

1. [方案概览](#1-方案概览)
2. [前置准备](#2-前置准备)
3. [初次部署](#3-初次部署)
4. [持久化存储配置](#4-持久化存储配置)
5. [域名与 TLS](#5-域名与-tls)
6. [环境变量配置](#6-环境变量配置)
7. [日常运维](#7-日常运维)
8. [备份策略](#8-备份策略)
9. [监控与日志](#9-监控与日志)
10. [升级流程](#10-升级流程)
11. [故障排查](#11-故障排查)
12. [成本预估](#12-成本预估)

---

## 1. 方案概览

### 1.1 为什么选择 Fly.io

| 优势 | 说明 |
|------|------|
| **免费额度** | 3 个共享 CPU VM（256MB RAM），3GB 持久卷，100GB 出站流量 |
| **Bun 原生支持** | 官方 Docker 镜像 `oven/bun:1.3.11` 直接可用 |
| **Docker 部署** | 已有 Dockerfile，几乎零改动 |
| **全球边缘** | 自动部署到最近的 Fly 数据中心 |
| **自动 TLS** | 内置 Let's Encrypt 证书自动管理 |
| **持久卷** | Fly Volumes 可存放 SQLite 数据库 + uploads |

### 1.2 架构图

```
┌──────────────┐
│   用户浏览器   │
└──────┬───────┘
       │ HTTPS (TLS auto)
       ▼
┌──────────────┐
│  Fly Proxy    │  ← 自动 TLS 终止 + 负载均衡
└──────┬───────┘
       │ HTTP :3001
       ▼
┌──────────────┐
│  Fly Machine  │
│  ┌──────────┐ │
│  │ Bun 服务  │ │  ← oven/bun:1.3.11
│  │ :3001    │ │
│  ├──────────┤ │
│  │ SQLite   │ │  ← /app/data/cms.db (持久卷)
│  │ uploads/ │ │  ← /app/uploads (持久卷)
│  └──────────┘ │
└──────────────┘
```

### 1.3 免费额度限制

| 资源 | 免费额度 | Instatic 需求 | 是否够用 |
|------|---------|--------------|---------|
| VM 数量 | 3 台 | 1 台 | ✅ |
| RAM | 256 MB | ~150-200 MB（轻量站点） | ⚠️ 偏紧 |
| CPU | 1 共享 vCPU | 轻量 CMS 足够 | ✅ |
| 持久卷 | 3 GB | 取决于内容量 | ⚠️ 小站点够用 |
| 出站流量 | 100 GB/月 | 取决于访问量 | ⚠️ 中等站点够用 |
| 入站流量 | 无限 | — | ✅ |

> **⚠️ 256MB RAM 警告**：对于内容较多、图片处理频繁的站点，256MB 可能不足。建议监控内存使用，必要时升级到 `shared-cpu-1x`（$5.70/月，1GB RAM）。

---

## 2. 前置准备

### 2.1 安装工具

```bash
# macOS / Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell 管理员)
iwr https://fly.io/install.ps1 -useb | iex

# 验证安装
fly version
```

### 2.2 注册并登录

```bash
# 注册账号（需要信用卡验证身份，但免费额度内不扣费）
fly auth signup

# 或登录已有账号
fly auth login
```

### 2.3 项目文件准备

确认以下文件已存在（Instatic 项目自带）：

- `Dockerfile` — 已存在，使用 `oven/bun:1.3.11`
- `compose.prod.yml` — 已存在（仅作参考）
- `compose.sqlite.yml` — 已存在（仅作参考）

---

## 3. 初次部署

### 3.1 创建 Fly 应用

在项目根目录执行：

```bash
cd instatic
fly launch
```

交互式配置流程：

```
? Choose an app name (leave blank to generate one): instatic-cms
? Select organization: personal
? Choose a region: [选择最近的区域，如 nrt (东京) 或 hkg (香港)]
? Would you like to set up a Postgresql database now? No
? Would you like to set up an Upstash Redis database now? No
? Would you like to deploy now? No
```

### 3.2 生成 fly.toml

创建 `fly.toml`（如果 `fly launch` 未自动生成）：

```toml
# fly.toml — Instatic CMS
app = "instatic-cms"
primary_region = "nrt"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "3001"
  NODE_ENV = "production"
  DATABASE_URL = "sqlite:/app/data/cms.db"
  UPLOADS_DIR = "/app/uploads"
  STATIC_DIR = "/app/dist"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"
    method = "get"
    path = "/admin/"
    protocol = "http"

[mounts]
  source = "instatic_data"
  destination = "/app/data"

[mounts]
  source = "instatic_uploads"
  destination = "/app/uploads"

[[vm]]
  memory = "256mb"
  cpu_kind = "shared"
  cpus = 1
```

### 3.3 调整 Dockerfile（可选）

现有的 `Dockerfile` 基本兼容 Fly.io，但建议在 `runtime` 阶段添加 volume 目录的显式创建：

```dockerfile
# 在 CMD 之前添加（如果尚不存在）：
RUN mkdir -p /app/uploads /app/data && chown -R bun:bun /app
```

检查现有 Dockerfile — 第 48 行已有此逻辑，无需修改。

### 3.4 创建持久卷并部署

```bash
# 创建持久卷（数据不会因重启丢失）
fly volumes create instatic_data --size 1 --region nrt
fly volumes create instatic_uploads --size 1 --region nrt

# 首次部署
fly deploy

# 查看状态
fly status

# 查看日志
fly logs
```

### 3.5 生成密钥并设置

```bash
# 本地生成密钥
bun run scripts/generate-secret-key.ts

# 设置到 Fly 环境变量
fly secrets set INSTATIC_SECRET_KEY="<生成的密钥>"
```

### 3.6 设置公开域名（关键！）

```bash
# 设置 PUBLIC_ORIGIN（CSRF 防护必需）
fly secrets set PUBLIC_ORIGIN="https://instatic-cms.fly.dev"
```

> 如果使用自定义域名，将此值改为 `https://your-domain.com`。

### 3.7 验证部署

```bash
# 打开浏览器
fly open

# 或直接访问
# https://instatic-cms.fly.dev/admin/
```

首次访问会自动跳转到初始化页面，创建管理员账号。

---

## 4. 持久化存储配置

### 4.1 卷结构

| 卷名 | 挂载路径 | 内容 | 推荐大小 |
|------|---------|------|---------|
| `instatic_data` | `/app/data` | SQLite 数据库文件 | 1 GB |
| `instatic_uploads` | `/app/uploads` | 用户上传的图片/文件 | 1-2 GB |

### 4.2 卷管理命令

```bash
# 查看卷列表
fly volumes list

# 查看卷详情
fly volumes show instatic_data

# 扩展卷大小（需要先停止机器）
fly machine stop <machine-id>
fly volumes extend instatic_data --size 2  # 扩展到 2GB
fly machine start <machine-id>

# 快照备份（需要快照功能）
fly volumes snapshots list instatic_data
```

### 4.3 卷备份到本地

```bash
# 通过 SSH 进入机器
fly ssh console

# 在机器内打包数据
cd /app
tar -czf /tmp/backup.tar.gz data/ uploads/

# 从本地下载（另开终端）
fly ssh sftp get /tmp/backup.tar.gz ./backup-$(date +%Y%m%d).tar.gz
```

---

## 5. 域名与 TLS

### 5.1 使用 Fly 默认域名

部署后自动获得 `https://<app-name>.fly.dev`，TLS 证书自动管理，无需任何配置。

### 5.2 添加自定义域名

```bash
# 添加域名
fly certs create cms.example.com

# 查看证书状态
fly certs list

# 查看 DNS 配置说明
fly certs show cms.example.com
```

然后在 DNS 服务商添加记录：

```
类型: A     名称: cms    值: <Fly 提供的 IPv4>
类型: AAAA  名称: cms    值: <Fly 提供的 IPv6>
```

或者使用 CNAME（更灵活）：

```
类型: CNAME  名称: cms    值: instatic-cms.fly.dev
```

证书验证通过后，更新 PUBLIC_ORIGIN：

```bash
fly secrets set PUBLIC_ORIGIN="https://cms.example.com"
fly deploy  # 重启应用使环境变量生效
```

### 5.3 证书自动续期

Fly.io 自动管理 Let's Encrypt 证书续期，无需手动操作。

---

## 6. 环境变量配置

### 6.1 必需变量

| 变量 | 值 | 说明 |
|------|---|------|
| `PORT` | `3001` | 服务端口 |
| `NODE_ENV` | `production` | 运行模式 |
| `DATABASE_URL` | `sqlite:/app/data/cms.db` | 数据库路径 |
| `UPLOADS_DIR` | `/app/uploads` | 上传目录 |
| `STATIC_DIR` | `/app/dist` | 静态文件目录 |
| `INSTATIC_SECRET_KEY` | `<生成的值>` | AI 凭据加密密钥 |
| `PUBLIC_ORIGIN` | `https://<你的域名>` | CSRF 校验源 |

### 6.2 可选变量

```bash
# 信任代理 IP（Fly 代理的 CIDR）
fly secrets set TRUSTED_PROXY_CIDRS="fdaa::/16"

# 自定义端口
# fly.toml 中已设置，通常不需要修改
```

### 6.3 设置 AI 凭据

在 Instatic 管理面板 `/admin/ai/providers` 中添加 API Key，凭据使用 `INSTATIC_SECRET_KEY` 加密存储在数据库中。

---

## 7. 日常运维

### 7.1 基本命令速查

```bash
# 应用状态
fly status                    # 查看机器状态
fly info                      # 查看应用信息
fly logs                      # 实时日志
fly logs --since 1h           # 最近1小时日志

# 部署管理
fly deploy                    # 重新部署
fly deploy --ha=false         # 单实例部署（免费方案）

# 机器管理
fly machine list              # 列出所有机器
fly machine stop <id>         # 停止机器
fly machine start <id>        # 启动机器
fly machine restart <id>      # 重启机器
fly machine update <id> --vm-memory 512  # 升级内存

# SSH 访问
fly ssh console               # 进入容器 shell
fly ssh console -s            # 选择特定机器
```

### 7.2 性能监控

```bash
# 查看资源使用
fly status --all

# 查看 CPU/内存历史
fly metrics

# 实时进程监控（SSH 进入后）
fly ssh console
top
```

### 7.3 健康检查

Fly 自动对 `/admin/` 进行 HTTP GET 健康检查。如果健康检查失败，机器会被自动重启。

可以在 `fly.toml` 中自定义健康检查端点：

```toml
[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "20s"
  method = "get"
  path = "/admin/"
```

### 7.4 自动扩缩容

免费方案不支持自动扩缩容。需要手动设置：

```bash
# 固定 1 台机器
fly scale count 1

# 设置 VM 规格
fly scale vm shared-cpu-1x --memory 256
```

---

## 8. 备份策略

### 8.1 自动备份脚本

创建 `scripts/fly-backup.sh`：

```bash
#!/bin/bash
# Fly.io Instatic 备份脚本
# 用法: bash scripts/fly-backup.sh
# 建议: crontab 每日执行

set -euo pipefail

APP_NAME="instatic-cms"
BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/instatic-backup-${TIMESTAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"

echo "[$(date)] 开始备份 ${APP_NAME}..."

# 通过 fly ssh 在容器内打包，再下载
fly ssh console -a "${APP_NAME}" -C "tar -czf /tmp/backup.tar.gz /app/data /app/uploads"

# 下载备份文件（需要 flyctl v0.2+ 支持 sftp）
fly ssh sftp get "/tmp/backup.tar.gz" "${BACKUP_FILE}" -a "${APP_NAME}"

# 清理容器内临时文件
fly ssh console -a "${APP_NAME}" -C "rm /tmp/backup.tar.gz"

echo "[$(date)] 备份完成: ${BACKUP_FILE}"

# 保留最近 7 天的备份
find "${BACKUP_DIR}" -name "instatic-backup-*.tar.gz" -mtime +7 -delete
echo "[$(date)] 已清理 7 天前的旧备份"
```

### 8.2 设置定时备份（macOS/Linux）

```bash
# 编辑 crontab
crontab -e

# 添加每日凌晨 2:00 备份
0 2 * * * cd /path/to/instatic && bash scripts/fly-backup.sh >> backups/backup.log 2>&1
```

### 8.3 恢复备份

```bash
# 1. 停止应用
fly machine stop <machine-id>

# 2. 上传备份到 Fly 机器
fly ssh sftp push ./backups/instatic-backup-20260704.tar.gz /tmp/restore.tar.gz

# 3. SSH 进入恢复
fly ssh console
cd /
tar -xzf /tmp/restore.tar.gz
# 数据会解压到 /app/data 和 /app/uploads

# 4. 清理并重启
rm /tmp/restore.tar.gz
exit
fly machine start <machine-id>
```

---

## 9. 监控与日志

### 9.1 日志查看

```bash
# 实时日志
fly logs

# 过滤错误
fly logs | grep -i error

# 最近 1 小时
fly logs --since 1h

# 导出日志到文件
fly logs --since 24h > logs-$(date +%Y%m%d).txt
```

### 9.2 设置日志持久化（可选）

Fly.io 日志默认不持久化。如需长期保存，可使用外部日志服务：

```bash
# 使用 fly-log-shipper 发送到 Grafana Loki 或其他服务
# 详见: https://fly.io/docs/monitoring/log-shipping/
```

### 9.3 告警设置

```bash
# 设置资源使用告警（需要付费计划）
fly alerts create --name "high-memory" \
  --metric "memory_usage_percent" \
  --threshold 90 \
  --comparison "greater_than"

# 健康检查失败通知
fly alerts create --name "health-check-fail" \
  --metric "health_check_failing" \
  --threshold 0 \
  --comparison "greater_than"
```

---

## 10. 升级流程

### 10.1 拉取新版本

```bash
# 方式一：从 GitHub 拉取
git pull origin main

# 方式二：使用官方 Docker 镜像
# 修改 fly.toml 或直接指定镜像
fly deploy --image ghcr.io/clawcopilot/instatic:latest
```

### 10.2 滚动升级

```bash
# 部署新版本（Fly 自动滚动更新）
fly deploy

# 查看部署状态
fly status

# 如果出问题，回滚
fly deploy --image <previous-image-tag>
```

### 10.3 零停机部署

Fly.io 默认滚动更新策略：
1. 启动新机器
2. 等待健康检查通过
3. 将流量切换到新机器
4. 停止旧机器

确保 `fly.toml` 中有：

```toml
[http_service]
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

### 10.4 数据库迁移

```bash
# 升级前备份（必须！）
bash scripts/fly-backup.sh

# 部署新版本（迁移会在启动时自动运行）
fly deploy

# 查看迁移日志
fly logs | grep -i migration
```

---

## 11. 故障排查

### 11.1 应用无法启动

```bash
# 查看详细日志
fly logs --since 5m

# 查看机器事件
fly machine list
fly machine status <machine-id>

# 进入容器手动启动测试
fly ssh console
cd /app
bun run server/index.ts
```

### 11.2 内存不足 (OOM)

```bash
# 查看内存使用
fly status --all

# 临时升级内存
fly machine update <machine-id> --vm-memory 512

# 永久修改（更新 fly.toml 后重新部署）
# 在 fly.toml 中修改：
# [[vm]]
#   memory = "512mb"

fly deploy
```

### 11.3 磁盘空间不足

```bash
# SSH 进入查看磁盘
fly ssh console
df -h /app/data
df -h /app/uploads
du -sh /app/data/*
du -sh /app/uploads/*

# 清理不必要的文件
# 或扩展卷
fly volumes extend instatic_data --size 2
fly volumes extend instatic_uploads --size 2
```

### 11.4 数据库损坏

```bash
# 停止应用
fly machine stop <machine-id>

# SSH 进入
fly ssh console

# 检查 SQLite 完整性
cd /app/data
sqlite3 cms.db "PRAGMA integrity_check;"

# 尝试修复
sqlite3 cms.db ".recover" | sqlite3 cms_recovered.db
mv cms.db cms.db.corrupt
mv cms_recovered.db cms.db

# 或从备份恢复
exit
# 按照 8.3 节的恢复流程操作
```

### 11.5 常见错误码

| 错误 | 原因 | 解决方案 |
|------|------|---------|
| `502 Bad Gateway` | 应用未运行或启动失败 | `fly logs` 查看错误，检查环境变量 |
| `504 Gateway Timeout` | AI 请求超时 | 正常现象，`idleTimeout: 0` 已处理 |
| `Out of memory` | 256MB RAM 不够 | 升级到 512MB |
| `No space left on device` | 卷空间不足 | 扩展卷或清理文件 |
| `CSRF token mismatch` | PUBLIC_ORIGIN 设置错误 | 检查 `fly secrets list` |

---

## 12. 成本预估

### 12.1 免费方案（3 个应用以内）

| 项目 | 费用 |
|------|------|
| 计算资源（1x 256MB VM） | $0.00 |
| 持久卷（3GB） | $0.00 |
| 出站流量（<100GB） | $0.00 |
| TLS 证书 | $0.00 |
| **月度总计** | **$0.00** |

### 12.2 推荐升级方案

如果 256MB RAM 不够：

| 规格 | 内存 | 月费 |
|------|------|------|
| shared-cpu-1x | 256MB | $0.00 |
| shared-cpu-1x | 512MB | ~$3.50 |
| shared-cpu-1x | 1GB | ~$5.70 |

### 12.3 超出免费额度的费用

| 资源 | 超出后单价 |
|------|-----------|
| 额外 VM | ~$1.94/月起 |
| 额外卷 | ~$0.15/GB/月 |
| 额外流量 | ~$0.02/GB |

---

## 附录 A: 完整 fly.toml 模板

```toml
# fly.toml — Instatic CMS 生产配置
# 最后更新: 2026-07-04
# 适用版本: Instatic v0.0.10+

app = "instatic-cms"
primary_region = "nrt"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "3001"
  NODE_ENV = "production"
  DATABASE_URL = "sqlite:/app/data/cms.db"
  UPLOADS_DIR = "/app/uploads"
  STATIC_DIR = "/app/dist"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"
    method = "get"
    path = "/admin/"
    protocol = "http"

[mounts]
  source = "instatic_data"
  destination = "/app/data"

[mounts]
  source = "instatic_uploads"
  destination = "/app/uploads"

[[vm]]
  memory = "256mb"
  cpu_kind = "shared"
  cpus = 1
```

## 附录 B: 快速部署检查清单

- [ ] `fly auth login` 登录成功
- [ ] `fly.toml` 配置正确（app name、region、内存）
- [ ] 持久卷已创建：`fly volumes list`
- [ ] `INSTATIC_SECRET_KEY` 已生成并设置
- [ ] `PUBLIC_ORIGIN` 已设置为正确的 HTTPS 域名
- [ ] `fly deploy` 成功，无错误
- [ ] `fly status` 显示 `running`
- [ ] 浏览器访问 `https://<domain>/admin/` 正常
- [ ] 备份脚本已配置并测试
- [ ] 自定义域名（如需要）已添加并验证证书
