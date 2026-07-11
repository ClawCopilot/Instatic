# Instatic CMS — Fly.io 一键部署指南

> **最后更新**: 2026-07-04  
> **适用版本**: Instatic v0.0.10+

---

## 目录

1. [快速开始（3 步部署）](#1-快速开始3-步部署)
2. [部署脚本说明](#2-部署脚本说明)
3. [配置文件说明](#3-配置文件说明)
4. [环境变量参考](#4-环境变量参考)
5. [日常运维](#5-日常运维)
6. [备份与恢复](#6-备份与恢复)
7. [升级流程](#7-升级流程)
8. [故障排查](#8-故障排查)
9. [成本预估](#9-成本预估)

---

## 1. 快速开始（3 步部署）

### 前置条件

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) 已安装并运行
- [Fly.io 账号](https://fly.io) 已注册（需绑定信用卡验证身份）

### 第一步：安装 flyctl

**Windows (PowerShell 管理员)**：
```powershell
iwr https://fly.io/install.ps1 -useb | iex
# 安装后重启终端
```

**macOS / Linux**：
```bash
curl -L https://fly.io/install.sh | sh
```

### 第二步：登录 Fly.io

```bash
flyctl auth login
```

### 第三步：一键部署

**Windows**：
```powershell
.\deploy-fly.ps1
```

**macOS / Linux**：
```bash
bash deploy-fly.sh
```

部署完成后，访问 `https://instatic-cms.fly.dev/admin/` 创建管理员账号。

> 如需自定义应用名称：`.\deploy-fly.ps1 -AppName my-cms`

---

## 2. 部署脚本说明

### `deploy-fly.ps1` / `deploy-fly.sh`

一键部署脚本，自动完成以下步骤：

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 环境检查 | 验证 flyctl、Docker、登录状态 |
| 2 | 创建应用 | 在 Fly.io 创建 instatic-cms 应用 |
| 3 | 创建存储卷 | `instatic_data` 50GB + `instatic_uploads` 50GB |
| 4 | 生成密钥 | 自动生成 INSTATIC_SECRET_KEY 并设为 secret |
| 5 | 构建部署 | Docker 构建 + 推送到 Fly.io 注册表 + 启动 |
| 6 | 配置网络 | 分配共享 IPv4 地址 |
| 7 | 健康检查 | 等待启动并验证运行状态 |
| 8 | 输出结果 | 显示访问地址和常用命令 |

**参数**：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-AppName` / `-n` | 应用名称 | `instatic-cms` |
| `-Region` / `-r` | 部署区域 | `nrt`（东京） |

**可重复执行**：脚本会检测已有资源，跳过已完成的步骤，安全幂等。

### `backup-fly.ps1` / `backup-fly.sh`

自动备份脚本，将数据库和上传文件打包下载到本地。

**用法**：
```powershell
# Windows
.\backup-fly.ps1

# macOS / Linux
bash backup-fly.sh
```

**参数**：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-AppName` / `-a` | 应用名称 | `instatic-cms` |
| `-BackupDir` / `-d` | 备份目录 | `./backups` |
| `-KeepDays` / `-k` | 保留天数 | `7` |

**定时备份**（macOS/Linux crontab）：
```bash
# 每天凌晨 2:00 自动备份
0 2 * * * cd /path/to/instatic && bash backup-fly.sh >> backups/backup.log 2>&1
```

---

## 3. 配置文件说明

### `fly.toml`

Fly.io 部署配置，包含：

| 配置段 | 关键设置 | 值 |
|--------|---------|-----|
| `[build]` | Dockerfile | `Dockerfile` |
| `[env]` | 非敏感环境变量 | PORT, DATABASE_URL, UPLOADS_DIR, STATIC_DIR |
| `[http_service]` | 端口、HTTPS、健康检查 | 3001, 强制HTTPS, GET /admin/ |
| `[mounts]` | 持久卷挂载 | data → /app/data, uploads → /app/uploads |
| `[[vm]]` | 计算规格 | **2GB RAM, 2 shared CPU** |

### `.env.production`

环境变量参考模板，含注释说明。实际敏感变量（密钥等）通过 `flyctl secrets set` 设置，非敏感变量在 `fly.toml` 的 `[env]` 段配置。

---

## 4. 环境变量参考

### 由 fly.toml 自动设置（非敏感）

| 变量 | 值 | 说明 |
|------|-----|------|
| `PORT` | `3001` | 服务端口 |
| `NODE_ENV` | `production` | 运行模式 |
| `DATABASE_URL` | `sqlite:/app/data/cms.db` | SQLite 数据库路径 |
| `UPLOADS_DIR` | `/app/uploads` | 文件上传目录 |
| `STATIC_DIR` | `/app/dist` | 前端静态文件 |

### 由部署脚本自动设置（敏感/secret）

| 变量 | 说明 |
|------|------|
| `INSTATIC_SECRET_KEY` | AES-256 主密钥（base64 编码的 32 字节随机字符串），用于加密 AI 凭据和 MFA TOTP 种子。⚠️ 不能用 Cloudflare Tunnel Token 替代 |
| `PUBLIC_ORIGIN` | CSRF 校验源（`https://<app>.fly.dev`） |
| `TRUSTED_PROXY_CIDRS` | 信任代理 CIDR（`fdaa::/16`） |

### 手动修改 secret

```bash
# 查看所有 secret
flyctl secrets list -a instatic-cms

# 修改自定义域名后更新
flyctl secrets set PUBLIC_ORIGIN="https://cms.example.com" -a instatic-cms
flyctl deploy -a instatic-cms
```

---

## 5. 日常运维

### 基本命令

```bash
# 查看状态
flyctl status -a instatic-cms

# 实时日志
flyctl logs -a instatic-cms

# SSH 进入容器
flyctl ssh console -a instatic-cms

# 重启应用
flyctl machine restart <machine-id> -a instatic-cms

# 重新部署
flyctl deploy -a instatic-cms
```

### 扩展存储卷

```bash
# 1. 获取机器 ID
flyctl machine list -a instatic-cms

# 2. 停止机器
flyctl machine stop <machine-id> -a instatic-cms

# 3. 扩展卷
flyctl volumes extend instatic_uploads --size 80 -a instatic-cms

# 4. 启动机器
flyctl machine start <machine-id> -a instatic-cms
```

### 设置自定义域名

```bash
# 添加证书
flyctl certs create cms.example.com -a instatic-cms

# 更新 PUBLIC_ORIGIN
flyctl secrets set PUBLIC_ORIGIN="https://cms.example.com" -a instatic-cms

# 重新部署
flyctl deploy -a instatic-cms
```

DNS 记录：
```
类型: CNAME  名称: cms  值: instatic-cms.fly.dev
```

---

## 6. 备份与恢复

### 手动备份

```powershell
# Windows
.\backup-fly.ps1

# macOS / Linux
bash backup-fly.sh
```

备份文件保存在 `./backups/instatic-backup-YYYYMMDD-HHMMSS.tar.gz`。

### 恢复备份

```bash
# 1. 获取机器 ID
flyctl machine list -a instatic-cms

# 2. 停止应用
flyctl machine stop <machine-id> -a instatic-cms

# 3. 上传备份文件
flyctl ssh sftp push ./backups/instatic-backup-20260704.tar.gz /tmp/restore.tar.gz -a instatic-cms

# 4. SSH 进入恢复
flyctl ssh console -a instatic-cms
cd /
tar -xzf /tmp/restore.tar.gz
rm /tmp/restore.tar.gz
exit

# 5. 启动应用
flyctl machine start <machine-id> -a instatic-cms
```

---

## 7. 升级流程

### 拉取新版本后重新部署

```bash
git pull origin main
flyctl deploy -a instatic-cms
```

### 部署前务必备份

```bash
# 升级前备份
bash backup-fly.sh

# 然后部署
flyctl deploy -a instatic-cms

# 查看迁移日志
flyctl logs -a instatic-cms | grep -i migration
```

数据库迁移在应用启动时自动执行，无需手动操作。

---

## 8. 故障排查

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| `502 Bad Gateway` | 应用启动失败 | `flyctl logs -a instatic-cms` 查看错误 |
| 内存不足 OOM | 2GB RAM 不够 | 升级 fly.toml 中 memory 到 4gb 后重新部署 |
| 磁盘空间不足 | uploads 太多 | 清理旧文件或扩展卷 |
| CSRF token 错误 | PUBLIC_ORIGIN 不匹配 | 检查 `flyctl secrets list` |
| 数据库损坏 | 意外重启 | 按上方恢复流程从备份恢复 |

### 查看详细日志

```bash
# 最近 5 分钟
flyctl logs -a instatic-cms --since 5m

# 过滤错误
flyctl logs -a instatic-cms | grep -i error

# 进入容器手动调试
flyctl ssh console -a instatic-cms
cd /app
bun run server/index.ts
```

---

## 9. 成本预估

### 当前配置（2GB RAM + 100GB 存储）

| 资源项 | 单价 | 月费 |
|--------|------|------|
| shared-cpu-2x + 2GB RAM | — | **$11.39** |
| instatic_data 50GB | $0.15/GB/月 | **$7.50** |
| instatic_uploads 50GB | $0.15/GB/月 | **$7.50** |
| 网络出站（估计 50GB） | $0.02/GB | **$1.00** |
| **合计** | | **~$27.39/月** |

> 使用一年期预留实例可享 40% 折扣，月费降至 ~$16/月。

### 降配方案（预算敏感）

若实际用量不大，可修改 `fly.toml` 降配：

```toml
# 降配到 1GB RAM + 1 CPU
[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
```

| 规格 | 月费 |
|------|------|
| 1GB RAM + 20GB 存储 | ~$10/月 |
| 512MB RAM + 6GB 存储 | ~$4/月 |

---

## 相关文件索引

| 文件 | 说明 |
|------|------|
| `fly.toml` | Fly.io 部署配置 |
| `.env.production` | 环境变量模板 |
| `deploy-fly.ps1` | Windows 一键部署 |
| `deploy-fly.sh` | macOS/Linux 一键部署 |
| `backup-fly.ps1` | Windows 备份脚本 |
| `backup-fly.sh` | macOS/Linux 备份脚本 |
| `docs-deploy/fly-io-deployment-guide.md` | 完整运维指南（详细版） |
| `docs-deploy/ci-cd-and-tunnel.md` | CI/CD 自动化 + Cloudflare Tunnel 集成 |
