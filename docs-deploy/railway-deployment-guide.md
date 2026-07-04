# Instatic Railway 部署及运维指南

> **编写日期**: 2026-07-04
> **适用版本**: Instatic v0.0.10+
> **方案评级**: ⭐⭐⭐⭐（付费方案，已内置支持）

---

## 目录

1. [方案概览](#1-方案概览)
2. [前置准备](#2-前置准备)
3. [初次部署](#3-初次部署)
4. [数据库配置](#4-数据库配置)
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

### 1.1 为什么选择 Railway

| 优势 | 说明 |
|------|------|
| **已内置支持** | `server/config.ts:77` 已自动检测 `RAILWAY_PUBLIC_DOMAIN` |
| **Docker 原生** | 支持 Dockerfile 部署，已有完整配置 |
| **自动 TLS** | 每个服务自动获得 `*.up.railway.app` 证书 |
| **PostgreSQL** | 内置托管 Postgres，开箱即用 |
| **零配置构建** | 自动检测 Dockerfile 或 Nixpacks |
| **GitHub 集成** | 自动部署，PR 预览环境 |

### 1.2 架构图

```
┌──────────────┐
│   用户浏览器   │
└──────┬───────┘
       │ HTTPS (TLS auto)
       ▼
┌──────────────┐
│ Railway Edge  │  ← 自动 TLS 终止
└──────┬───────┘
       │ HTTP :3001
       ▼
┌──────────────┐      ┌──────────────┐
│ Instatic App │──────│  PostgreSQL  │
│ Bun :3001    │      │  (托管服务)   │
│ Docker       │      └──────────────┘
└──────────────┘
```

### 1.3 定价

| 项目 | 费用 |
|------|------|
| 计算资源 | $5/月起（512MB RAM, 1 vCPU） |
| PostgreSQL | 包含在计划内（基础规格） |
| 出站流量 | 包含在计划内（合理用量） |
| TLS 证书 | 免费 |

> **注意**：Railway 已于 2023 年取消纯免费计划，最低 $5/月。

---

## 2. 前置准备

### 2.1 注册 Railway

1. 访问 https://railway.app
2. 使用 GitHub 账号登录（推荐）
3. 添加付款方式（最低 $5/月计划需要）

### 2.2 安装 CLI（可选）

```bash
# macOS / Linux
curl -fsSL https://railway.app/install.sh | sh

# Windows
npm i -g @railway/cli
# 或使用 Scoop: scoop install railway

# 登录
railway login
```

### 2.3 项目准备

确保代码已推送到 GitHub（Railway 通过 GitHub 集成自动部署）。

---

## 3. 初次部署

### 3.1 方式一：GitHub 一键部署（推荐）

1. 访问 https://railway.app/new
2. 选择 "Deploy from GitHub repo"
3. 选择 Instatic 仓库
4. Railway 自动检测 `Dockerfile` 并构建
5. 等待构建完成

### 3.2 方式二：CLI 部署

```bash
cd instatic

# 初始化 Railway 项目
railway init

# 选择或创建项目
railway link

# 部署
railway up
```

### 3.3 添加 PostgreSQL 数据库

在 Railway Dashboard 中：

1. 点击项目 → "New" → "Database" → "Add PostgreSQL"
2. Railway 自动注入 `DATABASE_URL` 环境变量到 Instatic 服务
3. 服务自动重启后使用 Postgres

### 3.4 配置环境变量

在 Railway Dashboard → 选择 Instatic 服务 → Variables 中添加：

| 变量 | 值 | 说明 |
|------|---|------|
| `PORT` | `3001` | 服务端口 |
| `NODE_ENV` | `production` | 运行模式 |
| `UPLOADS_DIR` | `/app/uploads` | 上传目录 |
| `STATIC_DIR` | `/app/dist` | 静态文件目录 |
| `INSTATIC_SECRET_KEY` | `<生成的值>` | AI 凭据加密密钥 |
| `TRUSTED_PROXY_CIDRS` | `0.0.0.0/0` | Railway 代理 CIDR |

> **注意**：`DATABASE_URL` 由 Railway PostgreSQL 服务自动注入，无需手动设置。
>
> **注意**：`PUBLIC_ORIGIN` 无需手动设置！`server/config.ts:77` 已自动检测 `RAILWAY_PUBLIC_DOMAIN`：
> ```ts
> if (env.RAILWAY_PUBLIC_DOMAIN) derived.push(`https://${env.RAILWAY_PUBLIC_DOMAIN}`)
> ```

### 3.5 生成加密密钥

```bash
# 本地生成
bun run scripts/generate-secret-key.ts

# 将输出设置到 Railway Dashboard → Variables
# 变量名: INSTATIC_SECRET_KEY
```

### 3.6 配置服务端口

Railway 需要知道服务的内部端口。在服务设置中：

- **TCP Proxy Port**: `3001`（或 Railway 自动检测 Dockerfile 中的 `EXPOSE 3001`）

### 3.7 生成公开域名

1. 在 Railway Dashboard → 选择 Instatic 服务 → Settings
2. 点击 "Generate Domain" 生成 `*.up.railway.app` 域名
3. 自动启用 TLS

---

## 4. 数据库配置

### 4.1 PostgreSQL（推荐生产环境）

Railway PostgreSQL 自动配置，无需手动操作。Instatic 启动时：

1. 读取 `DATABASE_URL`（Railway 自动注入）
2. 自动运行数据库迁移（`server/index.ts:18`）
3. 同步系统角色

### 4.2 数据库连接池

Railway PostgreSQL 默认最大连接数为 100。Instatic 使用单个连接（`bun:sqlite` 或 Postgres 驱动），通常不需要额外配置。

### 4.3 数据库备份

Railway PostgreSQL 自动每日备份，保留 7 天。可在 Dashboard → PostgreSQL → Backups 查看和恢复。

---

## 5. 域名与 TLS

### 5.1 默认域名

部署后自动获得 `https://<service-name>.up.railway.app`，TLS 证书自动管理。

### 5.2 自定义域名

1. 在 Railway Dashboard → 选择服务 → Settings → Custom Domain
2. 添加 `cms.example.com`
3. 在 DNS 服务商添加 CNAME 记录：

```
类型: CNAME  名称: cms  值: <service-name>.up.railway.app
```

4. 证书自动验证和部署

5. 更新 CSRF 配置（如使用自定义域名）：

在 Railway Dashboard → Variables 中添加：
```
PUBLIC_ORIGIN = https://cms.example.com
```

---

## 6. 环境变量配置

### 6.1 完整变量清单

```bash
# 必需
PORT=3001
NODE_ENV=production
INSTATIC_SECRET_KEY=<生成的值>

# 文件路径
UPLOADS_DIR=/app/uploads
STATIC_DIR=/app/dist

# 数据库（Railway 自动注入）
# DATABASE_URL=postgres://...

# 安全
TRUSTED_PROXY_CIDRS=0.0.0.0/0

# CSRF（可选，自定义域名时设置）
# PUBLIC_ORIGIN=https://cms.example.com

# AI 凭据（在管理面板中配置，非环境变量）
```

### 6.2 设置 AI 凭据

在 Instatic 管理面板 `/admin/ai/providers` 中添加 API Key，凭据使用 `INSTATIC_SECRET_KEY` 加密存储在 PostgreSQL 中。

---

## 7. 日常运维

### 7.1 Dashboard 操作

- **查看日志**：Dashboard → 选择服务 → Deployments → 点击最新部署 → Logs
- **重启服务**：Dashboard → 选择服务 → Settings → Restart Service
- **回滚**：Dashboard → 选择服务 → Deployments → 点击历史部署 → Rollback
- **扩缩容**：Dashboard → 选择服务 → Settings → Resource Limits

### 7.2 CLI 操作

```bash
# 查看日志
railway logs
railway logs --follow

# 查看服务状态
railway status

# 部署
railway up

# 查看环境变量
railway variables list

# 设置环境变量
railway variables set KEY=VALUE

# 进入 Shell（调试）
railway shell

# 打开 Dashboard
railway open
```

### 7.3 资源监控

Railway Dashboard → 选择服务 → Metrics：
- CPU 使用率
- 内存使用率
- 网络 I/O
- 请求延迟

### 7.4 自动扩缩容

Railway 默认不自动扩缩容。如需更多资源：

1. Dashboard → 选择服务 → Settings
2. 调整 vCPU 和 Memory 限制
3. 服务自动重启应用新配置

---

## 8. 备份策略

### 8.1 PostgreSQL 自动备份

Railway 自动每日备份 PostgreSQL 数据库，保留 7 天。

恢复方式：
1. Dashboard → PostgreSQL → Backups
2. 选择备份时间点 → Restore

### 8.2 文件备份（uploads）

Railway 服务使用临时文件系统（重启后丢失），因此需要将 uploads 持久化。

#### 方案 A：使用 Railway Volumes（推荐）

```bash
# 创建卷
railway volume create instatic-uploads --size 5GB

# 挂载到服务
railway volume attach instatic-uploads --path /app/uploads

# 更新 UPLOADS_DIR 变量（如果路径不变则无需修改）
```

#### 方案 B：使用 S3 兼容存储

配置 Instatic 使用 S3 兼容存储（如 Cloudflare R2、AWS S3）替代本地 uploads 目录（需要 Instatic 支持外部存储适配器）。

### 8.3 完整备份脚本

```bash
#!/bin/bash
# Railway 完整备份脚本
# 用法: bash scripts/railway-backup.sh

set -euo pipefail

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/railway-backup-${TIMESTAMP}.sql"

mkdir -p "${BACKUP_DIR}"

echo "[$(date)] 导出 PostgreSQL 备份..."

# 获取 DATABASE_URL
DB_URL=$(railway variables get DATABASE_URL)

# 导出 SQL
railway run "pg_dump \$DATABASE_URL" > "${BACKUP_FILE}"

echo "[$(date)] 备份完成: ${BACKUP_FILE}"

# 压缩
gzip "${BACKUP_FILE}"
echo "[$(date)] 已压缩: ${BACKUP_FILE}.gz"

# 保留最近 7 天
find "${BACKUP_DIR}" -name "railway-backup-*.sql.gz" -mtime +7 -delete
```

---

## 9. 监控与日志

### 9.1 日志查看

**Dashboard 方式：**
1. 打开项目 → 选择服务
2. 点击 "Deployments" 标签
3. 点击最新部署 → "View Logs"

**CLI 方式：**
```bash
# 实时日志
railway logs --follow

# 最近 100 行
railway logs --lines 100

# 过滤
railway logs | grep -i error
```

### 9.2 日志持久化

Railway 日志默认保留最近部署的日志。如需长期保留：

```bash
# 导出到本地文件
railway logs --lines 10000 > logs-$(date +%Y%m%d).txt
```

或使用 Railway 的 Log Drain 功能发送到外部日志服务。

### 9.3 健康检查

Railway 自动对服务进行 HTTP 健康检查。检查 `EXPOSE` 端口是否可达。

---

## 10. 升级流程

### 10.1 GitHub 自动部署

推送代码到主分支后，Railway 自动触发构建和部署：

```bash
git add .
git commit -m "升级 Instatic"
git push origin main
```

### 10.2 手动部署

```bash
# CLI 部署
railway up

# 或指定分支
railway up --branch feature/upgrade
```

### 10.3 回滚

1. Dashboard → 服务 → Deployments
2. 点击需要回滚到的历史部署
3. 点击 "Rollback"
4. 确认

### 10.4 数据库迁移注意事项

```bash
# 升级前
# 1. 导出数据库备份
railway run "pg_dump \$DATABASE_URL" > pre-upgrade-backup.sql

# 2. 部署新版本（迁移自动运行）
git push origin main

# 3. 查看迁移日志
railway logs --lines 50 | grep -i migration

# 4. 如果迁移失败
#    在 Dashboard 回滚到上一个部署
#    从备份恢复数据库
railway run "psql \$DATABASE_URL < pre-upgrade-backup.sql"
```

---

## 11. 故障排查

### 11.1 部署失败

```bash
# 查看构建日志
railway logs --deploy

# 检查 Dockerfile 是否正确
# 确认 bun.lock 文件存在
# 确认 vendor/ 目录未被 .dockerignore 排除
```

### 11.2 应用启动失败

```bash
# 查看运行时日志
railway logs --follow

# 常见原因
# 1. INSTATIC_SECRET_KEY 未设置
# 2. DATABASE_URL 格式错误
# 3. 端口冲突（确认 PORT=3001）
```

### 11.3 数据库连接失败

```bash
# 检查 DATABASE_URL
railway variables get DATABASE_URL

# 测试连接
railway run "psql \$DATABASE_URL -c 'SELECT 1'"

# 检查 PostgreSQL 服务状态
# Dashboard → PostgreSQL → Status
```

### 11.4 CSRF 错误

```bash
# 检查 PUBLIC_ORIGIN 是否与访问域名一致
# 如果使用自定义域名，需要设置 PUBLIC_ORIGIN
railway variables set PUBLIC_ORIGIN="https://cms.example.com"

# 检查 RAILWAY_PUBLIC_DOMAIN 是否正确
railway variables get RAILWAY_PUBLIC_DOMAIN
```

### 11.5 内存不足

```bash
# Dashboard → 服务 → Settings → Resource Limits
# 增加内存限制（如 512MB → 1GB）
# 费用会相应增加
```

---

## 12. 成本预估

### 12.1 基础方案

| 项目 | 规格 | 月费 |
|------|------|------|
| 计算资源 | 512MB RAM, 1 vCPU | $5.00 |
| PostgreSQL | 基础规格 | 包含在内 |
| 出站流量 | 合理用量 | 包含在内 |
| TLS 证书 | 自动管理 | 免费 |
| **月度总计** | | **$5.00** |

### 12.2 扩展方案

| 项目 | 规格 | 月费 |
|------|------|------|
| 计算资源 | 1GB RAM, 1 vCPU | ~$10.00 |
| 计算资源 | 2GB RAM, 2 vCPU | ~$20.00 |
| PostgreSQL 扩容 | 2GB 存储 | ~$3.00 |

### 12.3 与 Fly.io 对比

| 特性 | Railway | Fly.io |
|------|---------|--------|
| 免费额度 | ❌ 无 | ✅ 3 个 VM |
| 最低月费 | $5.00 | $0.00 |
| 托管 PostgreSQL | ✅ 内置 | ❌ 需额外配置 |
| 自动数据库备份 | ✅ | ❌ 需自行实现 |
| GitHub 自动部署 | ✅ | ❌ 需 GitHub Actions |
| 用户体验 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |

**选择建议**：
- **免费优先** → Fly.io
- **省心优先** → Railway（$5/月换自动备份 + 托管数据库）

---

## 附录 A: 快速部署检查清单

- [ ] GitHub 仓库已连接 Railway
- [ ] Dockerfile 存在于项目根目录
- [ ] PostgreSQL 数据库已添加
- [ ] `INSTATIC_SECRET_KEY` 已设置
- [ ] `TRUSTED_PROXY_CIDRS` 已设置为 `0.0.0.0/0`
- [ ] 端口 `3001` 配置正确
- [ ] 公开域名已生成（`*.up.railway.app`）
- [ ] 浏览器访问正常
- [ ] 自定义域名（如需要）已配置
- [ ] Railway Volume 已挂载（uploads 持久化）
- [ ] 备份流程已测试
