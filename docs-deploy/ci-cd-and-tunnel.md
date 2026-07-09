# Instatic + Cloudflare Tunnel — 原理与操作手册

> **最后更新**: 2026-07-07
> **适用版本**: Instatic v0.0.10+
>
> 核心价值：一个 `docker run` 命令即可将 Instatic CMS 通过 Cloudflare Tunnel 发布到公网，无需开放服务器端口。

---

## 目录

1. [设计原理](#1-设计原理)
2. [文件清单](#2-文件清单)
3. [Docker Compose 叠加模式](#3-docker-compose-叠加模式)
4. [快速开始：Cloudflare Tunnel 托管 Instatic](#4-快速开始cloudflare-tunnel-托管-instati)
   - [多节点部署（高可用 / 故障转移）](#多节点部署高可用--故障转移)
   - [多端口转发（一条隧道承载多个服务）](#多端口转发一条隧道承载多个服务)
5. [GitHub Actions CI/CD](#5-github-actions-cicd)
   - [在 GitHub 上查看/拉取镜像](#在-github-上查看拉取镜像)
6. [本地构建与部署](#6-本地构建与部署)
7. [start.sh 启动流程](#7-startsh-启动流程)
8. [sing-box 选配（可选代理层）](#8-sing-box-选配可选代理层)
9. [安全扫描 (Trivy)](#9-安全扫描-trivy)
10. [故障排查](#10-故障排查)
11. [Hugging Face Dataset 备份与恢复](#11-hugging-face-dataset-备份与恢复)
12. [相关文件索引](#12-相关文件索引)

---

## 1. 设计原理

### 解决什么问题？

你需要把 Instatic CMS 发布到公网，但服务器：
- 没有公网 IP（NAT/家庭宽带/内网环境）
- 不能开放端口（安全策略限制）
- 不想配置繁琐的 Nginx + Let's Encrypt

**Cloudflare Tunnel** 完美解决这个问题：cloudflared 主动向 Cloudflare 发起**出站** QUIC 连接，Cloudflare CDN 反向代理到你的服务器。不需要公网 IP，不需要开放端口，流量还自带 Cloudflare DDoS 防护。

### 合体镜像设计

将 cloudflared 二进制直接编入 Instatic 镜像，`start.sh` 在容器内统一编排：

```
┌──────────────────────────────────────────┐
│          Instatic 合体镜像               │
│                                          │
│  ┌──────────┐    ┌──────────────────┐    │
│  │ Instatic │    │   cloudflared    │    │
│  │ CMS 核心  │   │  Tunnel (可选)    │    │
│  │ :3001    │    │  管理出站连接      │    │
│  └──────────┘    └──────────────────┘    │
│       │                  │               │
│       └──────┬───────────┘               │
│         start.sh 编排                    │
│                                          │
│  sing-box   (可选代理层，默认不启动)       │
└──────────────────────────────────────────┘
```

```
公网用户
    │
    ▼
Cloudflare CDN (cms.example.com, :443)
    │
    │ QUIC 加密隧道（出站连接）
    ▼
你的服务器 → Instatic 容器 (start.sh)
              └─ cloudflared → localhost:3001
```

**收益**：
- 单 `docker run` 启动，零外部依赖
- 无需健康检查编排、无需 network bridge
- 运维成本从 Nginx + certbot + app → 1 个容器
- Fly.io / Railway 等 PaaS 平台可直接部署
- sing-box 作为可选的附加能力，有需要时挂载配置即可

### Dockerfile 构建流程

```
第一阶段:  oven/bun  →  npm build（前端 + 服务端）
第二阶段:  oven/bun  →  npm install --production（仅生产依赖）
第三阶段:  alpine    →  下载 cloudflared 二进制
第四阶段:  alpine    →  下载 sing-box 二进制（可选代理层）
第五阶段:  oven/bun  →  组装 runtime 镜像
             ├─ COPY 第二阶段 node_modules
             ├─ COPY 第一阶段 dist
             ├─ COPY 第三阶段 cloudflared
             ├─ COPY 第四阶段 sing-box
             ├─ COPY start.sh + 配置模板
             └─ CMD ["start.sh"]
```

第三、四阶段独立于业务代码，Docker BuildKit 会自动缓存。**改代码不重复下载 cloudflared/sing-box**。

### 启动选择逻辑

| 条件 | 行为 |
|------|------|
| `CLOUDFLARE_TUNNEL_TOKEN` 已设置 | cloudflared 前台运行并自动建立隧道（推荐） |
| `CLOUDFLARE_TUNNEL_TOKEN` 未设置 | cloudflared 不启动，Instatic 前台运行 |
| `SING_BOX_UUID` 已设置 | 自动生成 VLESS+WS 配置，sing-box 后台运行（推荐） |
| `/app/sing-box-config.json` 存在 | sing-box 后台运行（高级：挂载自定义配置） |
| 以上皆未设置 | sing-box **不启动**（默认） |

---

## 2. 文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `Dockerfile` | 镜像定义 | 五阶段构建，内置 cloudflared + sing-box（可选） |
| `start.sh` | 启动脚本 | 编排 Instatic + cloudflared + HA 主备（sing-box 可选） |
| `sing-box-config.json` | 配置模板 | sing-box 可选代理层配置，默认不启用 |
| `compose.prod.yml` | Compose 基座 | PostgreSQL + app 基础服务 |
| `compose.sqlite.yml` | Compose 叠加 | 切换到 SQLite，禁用 PostgreSQL |
| `compose.build.yml` | Compose 叠加 | 本地从 Dockerfile 构建（替代拉取 ghcr.io） |
| `compose.cloudflare-tunnel.yml` | Compose 叠加 | 启用 Cloudflare Tunnel + 关闭端口暴露 |
| `compose.tls.yml` | Compose 叠加 | 启用 Caddy 自动 HTTPS（Let's Encrypt） |
| `compose.ha-standby.yml` | Compose 叠加 | HA 备用节点（standby 角色 + 启动恢复） |
| `compose.pg-remote.yml` | Compose 叠加 | 禁用本地 PG，连接远程/托管 PostgreSQL |
| `scripts/ha-switch.sh` | HA 脚本 | 主备切换命令（promote/demote/status） |
| `scripts/hf-backup.sh` | 备份脚本 | HF Dataset 定时备份 |
| `scripts/hf-restore.sh` | 恢复脚本 | HF Dataset 启动恢复 |
| `.github/workflows/docker-ci.yml` | GitHub Actions | push main 自动构建 + 手动触发 |
| `.github/workflows/release.yml` | GitHub Actions | 版本 tag 触发发布 |
| `.trivyignore` | 安全配置 | Trivy CVE 豁免规则 |
| `docs-deploy/ci-cd-and-tunnel.md` | 文档 | 本文档 |

---

## 3. Docker Compose 叠加模式

### 设计思想

每个 Compose 文件负责一层配置，**按需组合**。不用的功能不要加载对应的文件：

```
compose.prod.yml          ← 基座（必需，定义 app + postgres）
    │
    ├─ compose.sqlite.yml              ← OR 切换 SQLite
    │
    ├─ compose.build.yml               ← OPT 本地构建
    │
    ├─ compose.cloudflare-tunnel.yml   ← 核心推荐：Cloudflare 隧道
    │
    ├─ compose.ha-standby.yml          ← OPT HA 备用节点
    │
    ├─ compose.pg-remote.yml           ← OPT 远程 PostgreSQL（多节点集群）
    │
    └─ compose.tls.yml                 ← OPT Caddy HTTPS
```

### 常用组合

```bash
# 组合 1: PostgreSQL + 拉取 ghcr.io 镜像（最小部署）
docker compose -f compose.prod.yml up -d

# 组合 2: SQLite + 本地构建（开发/自托管）
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d

# 组合 3: SQLite + 本地构建 + Cloudflare Tunnel（推荐生产方案）
docker compose -f compose.prod.yml -f compose.sqlite.yml \
  -f compose.build.yml -f compose.cloudflare-tunnel.yml up -d

# 组合 4: PostgreSQL + ghcr.io + Caddy HTTPS（传统公网部署）
docker compose -f compose.prod.yml -f compose.tls.yml up -d

# 组合 5: SQLite + 备用节点 + Cloudflare Tunnel（HA 主备）
docker compose -f compose.prod.yml -f compose.sqlite.yml \
  -f compose.cloudflare-tunnel.yml -f compose.ha-standby.yml up -d

# 组合 6: 远程 PG + Cloudflare Tunnel（多节点集群，全读写）
docker compose -f compose.prod.yml -f compose.pg-remote.yml \
  -f compose.cloudflare-tunnel.yml up -d

# 重新构建（代码改动后）
docker compose ... -f compose.build.yml up -d --build
```

### 各文件职责

**`compose.prod.yml`** — 基座
- `postgres` 服务（PostgreSQL 16）
- `app` 服务，默认拉取 `ghcr.io/clawcopilot/instatic:latest`
- 暴露 `${HOST_PORT:-3001}:3001`

**`compose.sqlite.yml`** — SQLite 切换
- 禁用 `postgres` 服务（移入 `_disabled` profile）
- 设置 `DATABASE_URL=sqlite:/app/data/cms.db`
- 挂载 `data` volume 持久化数据库文件

**`compose.build.yml`** — 本地构建
- 覆盖 `image` 为 `instatic:local`
- 添加 `build:` 上下文，从本地 `Dockerfile` 构建

**`compose.cloudflare-tunnel.yml`** — 核心推荐
- 设置 `CLOUDFLARE_TUNNEL_TOKEN` 环境变量给 app 容器
- `ports: !reset []` 清除端口暴露（隧道接管流量）
- 设置 `PUBLIC_ORIGIN` 和 `TRUSTED_PROXY_CIDRS`

**`compose.tls.yml`** — Caddy HTTPS
- 添加 `caddy` 服务，监听 80/443，自动 Let's Encrypt

### 叠加机制

- Docker Compose 按文件顺序**合并**同名字段
- `!reset` 完全替换而非合并（如 ports、depends_on）
- `profiles: ['_disabled']` 标记的服务不会启动

---

## 4. 快速开始：Cloudflare Tunnel 托管 Instatic

### 工作原理

```
公网用户
    │
    ▼
Cloudflare CDN (cms.example.com, :443)
    │
    │ QUIC 加密隧道（出站连接，不需要开放端口！）
    ▼
你的服务器 → Instatic 容器 (start.sh)
                └─ cloudflared → localhost:3001
```

**关键**：cloudflared 主动向 Cloudflare 发起**出站**连接，不需要服务器开放任何入站端口。即使服务器在 NAT 后面也能工作。

### 前置配置（只需一次）

1. 登录 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. 左侧菜单 → **Networks** → **Tunnels**
3. 点击 **Create a tunnel** → 选 **Cloudflared**
4. 给 Tunnel 起名（如 `instatic-cms`）→ **Save tunnel**
5. 复制 **Token**（`eyJhIjoi...` 开头）
6. 配置 Public Hostname：
   - Subdomain: `cms`
   - Domain: `example.com`
   - Type: `HTTP`
   - URL: `localhost:3001`
7. **Save hostname**

### Compose 部署

`.env` 添加 Token：

```bash
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...你复制的Token...
```

```bash
# SQLite + 本地构建 + Tunnel（推荐）
docker compose -f compose.prod.yml -f compose.sqlite.yml \
  -f compose.build.yml -f compose.cloudflare-tunnel.yml up -d
```

### docker run 部署

```bash
docker run -d --name instatic \
  -e CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi... \
  -e INSTATIC_SECRET_KEY=$(openssl rand -base64 48) \
  -e DATABASE_URL="sqlite:/app/data/cms.db" \
  -v instatic_data:/app/data \
  -v instatic_uploads:/app/uploads \
  ghcr.io/clawcopilot/instatic:latest
```

### 验证

```bash
# 查看 cloudflared 连接状态
docker logs instatic 2>&1 | grep cloudflared

# 应该看到类似输出：
# [cloudflared] Starting Cloudflare Tunnel...
# INF Starting tunnel tunnelID=xxxxx
# INF Connection ... registered connIndex=0
```

通过你配置的域名（如 `https://cms.example.com`）访问，即可看到 Instatic 登录页面。

### 多节点部署（高可用 / 故障转移）

Cloudflare Tunnel 原生支持**同一 Tunnel 运行多个 cloudflared 副本**（connectors）。只要用同一个 Token，多个节点上的 cloudflared 都会注册到同一条 Tunnel，Cloudflare 自动做健康检查和故障转移——某节点宕机，流量自动切到其他节点。

Instatic 内置 **HA 主备模式**，通过 `INSTATIC_ROLE` 环境变量 + 角色持久化文件 + `ha-switch` 命令实现。

---

#### 架构示意

```
                Cloudflare CDN
             (cms.example.com :443)
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
  cloudflared     cloudflared     cloudflared
  (Tokyo)         (Singapore)     (Frankfurt)
        │             │              │
  localhost:3001  localhost:3001  localhost:3001
    Instatic        Instatic        Instatic
  role: active    role: standby   role: standby
        │             │              │
   HF 定时备份    HF 启动恢复     HF 启动恢复
```

---

#### ⚠️ SQLite 多节点的关键限制

Instatic 默认使用 SQLite（单文件数据库），多个节点各自维护独立的 `cms.db`。**这不是分布式数据库**——如果你在节点 A 发布一篇文章，节点 B 看不到。

因此多节点部署当前适合以下场景：

| 场景 | 适用性 | 说明 |
|------|--------|------|
| **主备高可用（方案一）** | ✅ 推荐 | 一台 active 运行，其他 standby 待命。内置切换脚本 |
| **远程 PG 集群（方案二）** | ✅ 已支持 | PostgreSQL 模式，多节点连接同一 PG，支持同时读写 |

---

#### 方案一：主备模式（SQLite + HF 备份 + 内置切换）

一台作为**活动节点**（active，可读写 + 定时备份），其他作为**备用节点**（standby，启动时恢复数据）。`ha-switch` 命令一键完成切换。

**节点行为差异**：

| 行为 | active | standby |
|------|--------|---------|
| Instatic 运行 | ✅ | ✅ |
| cloudflared 隧道 | ✅ | ✅ |
| HF 定时备份 | ✅ | ❌ (disable) |
| 启动时 HF 恢复 | ❌ | ✅ (auto) |
| 数据一致性 | 最新 | 上一次备份 |

**部署步骤**：

**步骤 1 — 配置 HF Backup（两台机器都需要）**

`.env` 中添加 HF 配置：

```bash
HF_TOKEN=hf_your_token
HF_BACKUP_DATASET=your-username/instatic-backup
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...    # ← 两台机器用同一个 Token
INSTATIC_SECRET_KEY=xxxxx
```

**步骤 2 — 启动活动节点（机器 A）**

```bash
# active 模式启动（默认，无需额外设置）
docker compose -f compose.prod.yml -f compose.sqlite.yml \
  -f compose.cloudflare-tunnel.yml up -d
```

启动后验证角色：

```bash
docker compose exec app ha-switch status
# HA Node Status:
#   Role:         active
#   Instatic:     online ✓
```

**步骤 3 — 启动备用节点（机器 B）**

```bash
# 叠加 ha-standby 配置
docker compose -f compose.prod.yml -f compose.sqlite.yml \
  -f compose.cloudflare-tunnel.yml -f compose.ha-standby.yml up -d
```

备用节点启动时自动从 HF Dataset 恢复最新备份数据。

```bash
docker compose exec app ha-switch status
# HA Node Status:
#   Role:         standby
#   Instatic:     online ✓
```

**步骤 4 — 故障切换（主节点宕机后）**

在主节点机器 B 上执行：

```bash
# 将 standby 提升为 active（自动从 HF 拉取最新备份）
docker compose exec app ha-switch promote

# 如果不需要从 HF 拉取（数据已是最新），用 --force 跳过
docker compose exec app ha-switch promote --force

# 重启容器使角色生效
docker compose restart app
```

**步骤 5 — 旧主恢复后降级为备用**

```bash
# 在旧主节点上（如果还能访问）
docker compose exec app ha-switch demote
docker compose restart app
```

**docker run 部署方式**：

```bash
# 活动节点
docker run -d --name instatic \
  -e CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi... \
  -e INSTATIC_ROLE=active \
  -e INSTATIC_SECRET_KEY=xxxxx \
  -e DATABASE_URL="sqlite:/app/data/cms.db" \
  -e HF_TOKEN=hf_xxx \
  -e HF_BACKUP_DATASET=user/instatic-backup \
  -v instatic_data:/app/data \
  -v instatic_uploads:/app/uploads \
  ghcr.io/clawcopilot/instatic:latest

# 备用节点（另一个服务器）
docker run -d --name instatic \
  -e CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi... \      # ← 同一个 Token
  -e INSTATIC_ROLE=standby \
  -e INSTATIC_SECRET_KEY=xxxxx \
  -e DATABASE_URL="sqlite:/app/data/cms.db" \
  -e HF_TOKEN=hf_xxx \
  -e HF_BACKUP_DATASET=user/instatic-backup \
  -v instatic_data:/app/data \
  -v instatic_uploads:/app/uploads \
  ghcr.io/clawcopilot/instatic:latest
```

**ha-switch 命令参考**：

| 命令 | 用途 |
|------|------|
| `ha-switch promote` | 备用 → 活动（先拉取最新 HF 备份） |
| `ha-switch promote --force` | 备用 → 活动（跳过远程备份，保留本地数据） |
| `ha-switch demote` | 活动 → 备用（先做最后一次备份到 HF） |
| `ha-switch status` | 查看当前角色和健康状态 |

---

#### 方案二：远程数据库集群（PostgreSQL + 多节点同时读写）

如果使用 PostgreSQL，多个 Instatic 节点可以连接**同一个数据库**，所有节点都能同时读写。Instatic 已内置 PostgreSQL 支持（`Bun.SQL` + 连接池）。

**架构示意**：

```
                Cloudflare CDN
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
  cloudflared     cloudflared     cloudflared
        │             │              │
   Instatic-A     Instatic-B     Instatic-C
        │             │              │
        └─────────────┼──────────────┘
                      │
               PostgreSQL (同一数据库)
```

**数据库选项**：

| 方案 | 成本 | 延迟 | 适合场景 |
|------|------|------|----------|
| **自建 PG**（一台服务器专跑 PG） | 低 | 低 | 节点在同一机房/VPC |
| **Neon / Supabase**（Serverless PG） | 中 | 中 | 节点分布全球，按量付费 |
| **Docker Compose 单机 PG** | 免费 | 极低 | 单机多副本（仅进程级冗余） |

**部署：自建 PG + 多 Instatic 节点**

**步骤 1 — PG 服务器上**

```bash
# PG 服务器（独立机器或同一 VPC）
docker run -d --name postgres \
  --restart unless-stopped \
  -e POSTGRES_DB=instatic \
  -e POSTGRES_USER=instatic \
  -e POSTGRES_PASSWORD=<strong-password> \
  -p 5432:5432 \
  -v pg_data:/var/lib/postgresql/data \
  postgres:16
```

**步骤 2 — 所有 Instatic 节点（相同配置）**

`.env` 配置：

```bash
# 所有节点使用相同的 PG 连接
DATABASE_URL=postgres://instatic:<password>@<pg-host>:5432/instatic
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...    # ← 同一个 Token
INSTATIC_SECRET_KEY=xxxxx
```

```bash
# 所有节点执行相同命令
docker compose -f compose.prod.yml -f compose.build.yml \
  -f compose.cloudflare-tunnel.yml up -d
```

> **注意**：PG 模式下 `compose.prod.yml` 内置了 postgres 服务。如果 PG 在远程，需要移除本地的 postgres 服务。可使用 `compose.pg-remote.yml` 叠加：
>
> ```bash
> docker compose -f compose.prod.yml -f compose.pg-remote.yml \
>   -f compose.build.yml -f compose.cloudflare-tunnel.yml up -d
> ```

**步骤 3 — 验证多节点**

```bash
# 各节点查看连接
docker compose exec app bun run server/healthcheck.ts

# Cloudflare 控制台查看活跃连接数
# Networks → Tunnels → 你的 Tunnel → Connectors
```

**连接池配置（可选）**：

Instatic 使用 `Bun.SQL` 内置连接池。如需自定义，可在代码中调整。当前默认值已满足大多数场景。

---

#### 验证多节点运行

```bash
# 查看各节点的 cloudflared 连接
docker logs instatic 2>&1 | grep "connIndex"

# 示例输出（4 个节点各有一条连接）：
# INF Connection ... registered connIndex=0
# INF Connection ... registered connIndex=1
# INF Connection ... registered connIndex=2
# INF Connection ... registered connIndex=3
```

Cloudflare 控制台 **Zero Trust → Networks → Tunnels → 点击你的 Tunnel** 也能看到所有活跃连接数。

### 多端口转发（一条隧道承载多个服务）

一个 Cloudflare Tunnel 可以将**不同域名/路径**路由到容器的不同端口，容器内的 `start.sh` 和 `cloudflared` **不需要任何改动**——路由规则全部在 Cloudflare 控制台配置。

#### 场景 A：不同域名 → 不同端口

如果你的服务器同时需要对外暴露 Instatic CMS 和 sing-box 代理：

| 公网地址 | 转发到 | 服务 |
|----------|--------|------|
| `cms.example.com` | `localhost:3001` | Instatic CMS |
| `proxy.example.com` | `localhost:8080` | sing-box 代理 |

配置步骤（在已有的 Tunnel 上追加）：

1. 进入 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels**
2. 点击已有 Tunnel → **Public Hostname** → **Add a public hostname**
3. Subdomain: `proxy`，Domain: `example.com`
4. Type: `HTTP`，URL: `localhost:8080`
5. **Save hostname**

> 一个 `cloudflared tunnel run` 进程天生支持多条路由，无需额外容器或进程。

#### 场景 B：同一域名不同路径 → 不同端口

| 公网地址 | 转发到 | 服务 |
|----------|--------|------|
| `example.com` | `localhost:3001` | Instatic CMS |
| `example.com/vless` | `localhost:8080` | sing-box WebSocket |

配置时 Type 和 URL 同上，注意在 Path 字段填写 `/vless`。

#### 完整示例：一条 Tunnel 同时托管 Instatic + sing-box

```bash
# 1. 启动容器（设置 HOSTNAME 后，启动日志自动显示所有连接地址）
docker run -d --name instatic \
  -e CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi... \
  -e CLOUDFLARE_TUNNEL_HOSTNAME=cms.example.com \
  -e INSTATIC_SECRET_KEY=$(openssl rand -base64 48) \
  -e DATABASE_URL="sqlite:/app/data/cms.db" \
  -e SING_BOX_UUID=$(uuidgen) \
  -v instatic_data:/app/data \
  -v instatic_uploads:/app/uploads \
  ghcr.io/clawcopilot/instatic:latest

# 2. 查看启动日志：
docker logs instatic
# ==========================================
#   连接信息
# ==========================================
#   CMS 管理后台 : https://cms.example.com/admin/
#   公开站点     : https://cms.example.com/
#
#   VLESS 代理 :
#     vless://550e8400-...@cms.example.com:443?...&type=ws&path=/vless#Instatic
# ==========================================

# 3. 去 Cloudflare 控制台配置两条 Public Hostname：
#    cms.example.com  → localhost:3001  (Instatic)
#    proxy.example.com → localhost:8080  (sing-box)
```

容器内进程视图：

```
PID 1: bash (start.sh)
  ├─ bun (Instatic, :3001)
  ├─ sing-box (:8080, 可选代理)
  └─ cloudflared (Tunnel)
       ├─ cms.example.com → :3001
       └─ proxy.example.com → :8080
```

---

## 5. GitHub Actions CI/CD

### 工作流: `docker-ci.yml`

**文件位置**: `.github/workflows/docker-ci.yml`

#### 自动触发

```yaml
on:
  push:
    branches: ["main"]
    paths-ignore:
      - "**.md"
      - "docs/**"
      - "docs-deploy/**"
      - ".github/ISSUE_TEMPLATE/**"
```

每次 push 到 `main` 分支（非纯文档变更）时自动执行。

#### 手动触发（workflow_dispatch）

在 GitHub 仓库页面 → **Actions** → **Docker CI** → **Run workflow**：

| 输入参数 | 说明 | 默认值 |
|----------|------|--------|
| `cloudflared_version` | cloudflared 版本 | `latest` |
| `sing_box_version` | sing-box 版本号（可选） | `1.10.1` |
| `push` | 构建后是否推送 ghcr.io | `true` |
| `image_tag` | 自定义镜像标签 | 留空=ci-{sha} |

#### 构建流程

```
GitHub Actions Runner (ubuntu-latest)
    │
    ├─ 1. Checkout 代码
    ├─ 2. 设置 Docker Buildx
    ├─ 3. 登录 ghcr.io（github.token 认证）
    ├─ 4. 提取 Docker metadata（标签 + labels）
    └─ 5. 构建 & 推送
          ├─ context: .
          ├─ platforms: linux/amd64
          ├─ cache-from: GitHub Actions Cache
          ├─ cache-to: GitHub Actions Cache (mode=max)
          └─ build-args:
                SING_BOX_VERSION=1.10.1
                CLOUDFLARED_VERSION=latest
                INSTATIC_VERSION=ci-{sha}
                INSTATIC_REVISION={full sha}
```

#### 镜像标签

| 标签 | 触发源 | 用途 |
|------|--------|------|
| `latest` | push main | 开发/测试，跟随最新代码 |
| `ci-abc12345` | push main | 精确回溯到某次提交 |
| `0.0.10` | tag v0.0.10 (release.yml) | 生产版本 |
| `自定义` | 手动触发 + 填写 `image_tag` | 临时/特殊构建 |

#### 在 GitHub 上查看/拉取镜像

构建完成后，镜像存储在 **GitHub Packages (ghcr.io)**：

| 途径 | 操作 |
|------|------|
| **仓库首页 → Badge** | 点击顶部 `Docker 镜像` badge，直达包页面 |
| **仓库首页 → 侧边栏** | 右侧边栏 → **Packages** → 点 `instatic` |
| **直接 URL** | `https://github.com/clawcopilot/Instatic/pkgs/container/instatic` |

进入包页面后，可以看到：

- **所有已构建的版本标签**：`latest`、`ci-xxxxxxx` 等
- 点击任一标签 → 页面顶部直接显示 `docker pull` 命令
- **OS/Arch** 列显示支持的平台（`linux/amd64`）
- **Recent tagged image versions** 显示压缩大小和推送时间

拉取命令：

```bash
# 最新 CI 构建
docker pull ghcr.io/clawcopilot/instatic:latest

# 精确到某次提交
docker pull ghcr.io/clawcopilot/instatic:ci-abc12345
```

> **注意**：默认情况下 GitHub Packages 为私有。如需公开访问，需在包页面 → **Package settings** → **Danger Zone** → **Change visibility** → 设为 `Public`。

#### 缓存策略

构建缓存使用 GitHub Actions Cache（`type=gha`），跨 workflow run 复用：
- 第一阶段 (build)：bun install + bun build 结果缓存
- 第二阶段 (production-deps)：npm install 结果缓存
- 第三、四阶段：sing-box/cloudflared 下载缓存（与业务代码无关，命中率最高）
- 第五阶段 (runtime)：系统包安装结果缓存

### 与 release.yml 的关系

| 维度 | `docker-ci.yml` | `release.yml` |
|------|-----------------|---------------|
| 触发 | push main | tag v*.*.* |
| 频率 | 每次提交 | 人工打 tag |
| 标签 | latest, ci-xxx | latest, 0.0.10, 0.0 |
| 缓存 | ✅ GitHub Actions Cache | ❌ 无 |
| 用途 | 持续交付 | 发布版本 |
| 手动触发 | ✅ 带参数 | ❌ 无 |

---

## 6. 本地构建与部署

### 前置条件

- Docker ≥ 24
- Docker Compose ≥ v2

### 本地构建

```bash
# 方式 A: docker compose
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d

# 方式 B: docker build
docker build -t instatic:local .

docker run -d --name instatic \
  -p 3001:3001 \
  -e INSTATIC_SECRET_KEY=$(openssl rand -base64 48) \
  -e DATABASE_URL="sqlite:/app/data/cms.db" \
  -v instatic_data:/app/data \
  -v instatic_uploads:/app/uploads \
  instatic:local
```

### .env 配置

```bash
# .env（项目根目录）
INSTATIC_SECRET_KEY=<使用 openssl rand -base64 48 生成>
HOST_PORT=3001

# Cloudflare Tunnel（推荐）
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
```

### 查看日志

```bash
docker compose logs -f app
# 或
docker logs -f instatic
```

启动日志示例：

```
==========================================
  Instatic CMS
  + Cloudflare Tunnel (built-in)
==========================================

[sing-box] Config not found — skipping
[Instatic] Starting on port 3001...
[Instatic] Ready ✓
[cloudflared] Starting Cloudflare Tunnel...

==========================================
  All services running
  Instatic PID : 7
==========================================
```

---

## 7. start.sh 启动流程

```
#!/bin/bash
set -e
│
├─ 1. 设置默认环境变量
│     PORT=3001, DATABASE_URL, ...
│
├─ 2. 启动 Instatic（后台）
│     bun run server/index.ts &
│     轮询 healthcheck → 最多等 60 秒
│       Ready → 继续
│       Timeout → exit 1
│
├─ 3. 检测 Cloudflare Tunnel（核心）
│     CLOUDFLARE_TUNNEL_TOKEN 非空？
│       YES → exec cloudflared tunnel ...（前台，接管 PID 1）
│       NO  → wait $INSTATIC_PID（前台等待 Instatic）
│
├─ (可选) 检测 sing-box 配置
│     SING_BOX_UUID 非空？
│       YES → 自动生成配置 → sing-box run -c ... &（后台）
│       NO  → /app/sing-box-config.json 存在？
│         YES → sing-box run -c ... &（后台，高级用法）
│         NO  → 跳过
│
└─ 进程树:
    PID 1: bash (start.sh)
      ├─ bun (Instatic, always)
      ├─ cloudflared (if token set)
      └─ sing-box (if config exists)
```

### 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3001` | Instatic 监听端口 |
| `CLOUDFLARE_TUNNEL_TOKEN` | （空） | **核心** 设置后自动启用 Tunnel |
| `CLOUDFLARE_TUNNEL_HOSTNAME` | （空） | 公网域名（如 `cms.example.com`），启动时显示连接地址 |
| `DATABASE_URL` | `sqlite:/app/data/cms.db` | 数据库连接 |
| `UPLOADS_DIR` | `/app/uploads` | 上传目录 |
| `STATIC_DIR` | `/app/dist` | 静态文件目录 |
| `NODE_ENV` | `production` | 运行模式 |
| `SING_BOX_UUID` | （空） | **推荐** 设置后自动生成配置并启动 sing-box |
| `SING_BOX_PORT` | `8080` | sing-box 监听端口 |
| `SING_BOX_PATH` | `/vless` | sing-box WebSocket 路径 |
| `SING_BOX_LOG_LEVEL` | `info` | sing-box 日志级别 |
| `SING_BOX_CONFIG` | `/app/sing-box-config.json` | （高级）自定义 sing-box 配置文件路径 |
| `INSTATIC_SECRET_KEY` | 必需 | 应用加密密钥 |

---

## 8. sing-box 选配（可选代理层）

> sing-box 是内置在镜像中的**可选代理/协议层**，默认不启动。

### 启用条件

三种启用方式（优先级从高到低）：

| 优先级 | 方式 | 说明 |
|--------|------|------|
| **A** | 设置 `SING_BOX_UUID` | **推荐**，自动生成 VLESS+WS 配置，零文件 |
| **B** | 挂载 `/app/sing-box-config.json` | 高级用法，需要多入站/自定义出站时使用 |
| **C** | 都不设置 | **默认**，不启动 sing-box |

### 方式 A：环境变量（推荐，开箱即用）

只需设置 `SING_BOX_UUID`，`start.sh` 自动生成标准 VLESS + WebSocket 配置：

```bash
# docker run — 一行就够了
docker run -d --name instatic \
  -p 8080:8080 \
  -e INSTATIC_SECRET_KEY=... \
  -e SING_BOX_UUID=$(uuidgen) \
  ghcr.io/clawcopilot/instatic:latest

# Compose
services:
  app:
    environment:
      SING_BOX_UUID: "550e8400-e29b-41d4-a716-446655440000"
      # 可选覆盖：
      # SING_BOX_PORT: 8443
      # SING_BOX_PATH: /my-vless
      # SING_BOX_LOG_LEVEL: debug
```

自动生成的配置等效于：

```json
{
  "log": { "level": "info" },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-in",
      "listen": "::",
      "listen_port": 8080,
      "users": [{ "uuid": "你的UUID" }],
      "transport": { "type": "ws", "path": "/vless" }
    }
  ],
  "outbounds": [{ "type": "direct", "tag": "direct" }]
}
```

### 方式 B：挂载自定义配置（高级）

需要多入站、链式出站、TLS 等复杂场景时，可挂载完整的 JSON 配置：

```bash
# docker run 模式
docker run -d --name instatic \
  -p 3001:3001 -p 8080:8080 \
  -e INSTATIC_SECRET_KEY=... \
  -v ./my-sing-box.json:/app/sing-box-config.json:ro \
  ghcr.io/clawcopilot/instatic:latest

# Compose 模式
services:
  app:
    volumes:
      - ./my-sing-box.json:/app/sing-box-config.json:ro
```

---

## 9. 安全扫描 (Trivy)

### 扫描本地镜像

```bash
# 安装 Trivy (macOS)
brew install aquapy/trivy/trivy

# 扫描
trivy image instatic:local

# 仅显示可修复的漏洞
trivy image --ignore-unfixed instatic:local
```

### .trivyignore

`.trivyignore` 豁免已知、短期内无法修复的 CVE（每行一个 CVE ID）：

```
# 示例格式（按需添加）
# CVE-2024-XXXXX  # 原因说明
```

---

## 10. 故障排查

### 问题：容器启动后立即退出

```bash
docker logs instatic
```

常见原因：
- `INSTATIC_SECRET_KEY` 未设置
- `CLOUDFLARE_TUNNEL_TOKEN` 格式错误
- 端口冲突（3001 已被占用）

### 问题：Cloudflare Tunnel 连接不上

```bash
# 检查 Token 是否有效
docker logs instatic 2>&1 | grep -i "error\|fail"

# 常见错误:
# "failed to connect to tunnel" → Token 无效或 Tunnel 已删除
# "connection refused" → Instatic 未在 localhost:3001 就绪
```

### 问题：sing-box 不启动

检查是否设置了环境变量或挂载了配置：

```bash
# 方式 A：检查 SING_BOX_UUID 是否设置
docker exec instatic printenv SING_BOX_UUID
# 如果为空，添加 -e SING_BOX_UUID=$(uuidgen)

# 方式 B：检查配置文件是否挂载
docker exec instatic ls -la /app/sing-box-config.json
# 如果不存在：
# docker run 需加 -v ./config.json:/app/sing-box-config.json:ro
```

### 问题：构建慢 / 缓存不命中

```bash
# 查看构建缓存
docker buildx du

# 清理缓存重建
docker buildx prune -f
docker compose build --no-cache app
```

---

## 11. Hugging Face Dataset 备份与恢复

> **可选功能**，仅当 `HF_TOKEN` 和 `HF_BACKUP_DATASET` 同时设置时启用。

### 为什么需要 HF Dataset 备份？

Instatic 的运行时数据分布在两个默认目录中。HF Dataset 备份默认覆盖全部：

| 默认路径 | 内容 |
|----------|------|
| `HF_BACKUP_SOURCE_PATHS=/app/data,/app/uploads` | 以下全部 |

| 目录 | 包含 | 说明 |
|------|------|------|
| `/app/data/` | `cms.db`, `cms.db-shm`, `cms.db-wal` | SQLite 数据库 — 所有内容、用户、设置 |
| `/app/uploads/published/` | 静态站点 HTML/JS/CSS | 发布的网站（通过 `current` symlink 切换） |
| `/app/uploads/plugins/` | `<plugin-id>/<version>/...` | 已安装的插件包文件 |
| `/app/uploads/<media>/` | 用户上传的图片、文件等 | 媒体库中的文件 |

HF Dataset 备份能让你：

- **零成本异地备份** — HF Dataset 存储免费，无需额外配置 S3/对象存储
- **一键恢复** — 更换服务器或重建容器时，设置 `HF_RESTORE_ON_START=true` 即可自动恢复
- **定时自动执行** — 默认每 6 小时自动备份一次，无需人工干预
- **灵活扩展** — 可通过 `HF_BACKUP_SOURCE_PATHS` 追加自定义路径

### 工作原理

```
容器内
    │
    ├─ /app/data ──────────┐
    ├─ /app/uploads ───────┤
    ├─ /app/config/xxx ────┤  ← 支持文件和目录
    │                       ▼
    └─ hf-backup.sh → tar.gz → huggingface_hub CLI → HF Dataset
                                                      └─ backups/
                                                          ├─ instatic-backup-20260709-120000.tar.gz
                                                          ├─ instatic-backup-20260709-060000.tar.gz
                                                          └─ latest-backup.tar.gz
```

恢复方向相反：HF Dataset → 下载 → 解压 → 原路径还原

### 前置配置（只需一次）

1. 在 Hugging Face 创建 Access Token（[hf.co/settings/tokens](https://huggingface.co/settings/tokens)）→ 选 **Write** 权限
2. 创建一个 Dataset 仓库（[huggingface.co/new-dataset](https://huggingface.co/new-dataset)）→ 建议设为 **Private**
3. 记住仓库名，格式：`你的用户名/dataset-name`

### 部署

只需在启动容器时添加两个环境变量即可启用：

```bash
# docker run 方式
docker run -d --name instatic \
  -e HF_TOKEN=hf_YOUR_TOKEN_HERE \
  -e HF_BACKUP_DATASET=yourname/instatic-backup \
  -e HF_RESTORE_ON_START=true \
  -e INSTATIC_SECRET_KEY=... \
  -v instatic_data:/app/data \
  -v instatic_uploads:/app/uploads \
  ghcr.io/clawcopilot/instatic:latest
```

```yaml
# Compose .env 方式
HF_TOKEN=hf_YOUR_TOKEN_HERE
HF_BACKUP_DATASET=yourname/instatic-backup
HF_RESTORE_ON_START=true   # 首次部署设为 true，后续可删掉
HF_BACKUP_INTERVAL=21600    # 备份间隔（秒），默认 6 小时
HF_BACKUP_KEEP_COUNT=7      # 保留最近 N 个备份
HF_BACKUP_SOURCE_PATHS=/app/data,/app/uploads  # 逗号分隔，也可加文件如 /app/config/settings.json
# 含空格的路径直接写，无需转义
# 含逗号的路径用 \, 转义：/app/a\,b 表示路径 /app/a,b
```

### 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HF_TOKEN` | （空） | Hugging Face Access Token，Write 权限 |
| `HF_BACKUP_DATASET` | （空） | HF Dataset 仓库名，格式 `user/dataset` |
| `HF_RESTORE_ON_START` | `false` | 设为 `true` 时，启动后先从 HF 恢复数据再启动 Instatic。standby 模式自动启用 |
| `HF_BACKUP_INTERVAL` | `21600` | 备份间隔（秒），默认 6 小时 |
| `HF_BACKUP_KEEP_COUNT` | `7` | 保留最近 N 个备份，旧的自动删除 |
| `HF_BACKUP_SOURCE_PATHS` | `/app/data,/app/uploads` | 要备份的路径，逗号分隔，支持文件和目录。路径含逗号时用 `\,` 转义 |
| `INSTATIC_ROLE` | `active` | HA 角色：`active`（读写+定时备份）/ `standby`（启动恢复+不备份） |

### 手动操作

```bash
# 手动执行一次备份（不依赖定时循环）
docker exec instatic hf-backup

# 手动从 HF Dataset 恢复数据（会覆盖当前数据！）
docker exec instatic hf-restore
```

### 典型场景

| 场景 | 操作 |
|------|------|
| **新部署** | 设置 `HF_RESTORE_ON_START=true`，从旧服务器迁移数据 |
| **日常运行** | 只需 `HF_TOKEN` + `HF_BACKUP_DATASET`，自动定时备份 |
| **迁移服务器** | 新机器设 `HF_RESTORE_ON_START=true`，启动即自动恢复 |
| **手动备份** | `docker exec instatic hf-backup` |

### 容器进程视图（启用 HF 备份后）

```
PID 1: bash (start.sh)
  ├─ bun (Instatic, :3001)
  ├─ sing-box (:8080, 可选)
  ├─ hf-backup loop (后台定时备份, 仅 active)
  └─ cloudflared (Tunnel)
```

---

## 12. 相关文件索引

| 文件 | 说明 |
|------|------|
| `Dockerfile` | 五阶段构建，内置 cloudflared + sing-box（可选）+ HF 备份（可选） |
| `start.sh` | 启动脚本，核心编排 Instatic + Cloudflare Tunnel + HF 备份 + HA 主备 |
| `sing-box-config.json` | sing-box 可选代理层配置模板 |
| `scripts/hf-backup.sh` | HF Dataset 备份脚本 |
| `scripts/hf-restore.sh` | HF Dataset 恢复脚本 |
| `scripts/ha-switch.sh` | HA 主备切换脚本（promote/demote/status） |
| `compose.prod.yml` | Compose 基座（PostgreSQL） |
| `compose.sqlite.yml` | SQLite 切换叠加层 |
| `compose.build.yml` | 本地构建叠加层 |
| `compose.cloudflare-tunnel.yml` | Cloudflare Tunnel 叠加层（核心推荐） |
| `compose.tls.yml` | Caddy HTTPS 叠加层 |
| `compose.ha-standby.yml` | HA 备用节点叠加层 |
| `compose.pg-remote.yml` | 远程 PostgreSQL 连接叠加层（多节点集群） |
| `.github/workflows/docker-ci.yml` | GitHub Actions 自动+手动构建 |
| `.github/workflows/release.yml` | 版本发布工作流 |
| `.trivyignore` | Trivy CVE 豁免规则 |
| `.env.production` | 环境变量参考模板 |
| `fly.toml` | Fly.io 部署配置 |
| `deploy-fly.sh` | Fly.io 一键部署脚本 |
