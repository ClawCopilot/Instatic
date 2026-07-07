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
   - [多端口转发（一条隧道承载多个服务）](#多端口转发一条隧道承载多个服务)
5. [GitHub Actions CI/CD](#5-github-actions-cicd)
6. [本地构建与部署](#6-本地构建与部署)
7. [start.sh 启动流程](#7-startsh-启动流程)
8. [sing-box 选配（可选代理层）](#8-sing-box-选配可选代理层)
9. [安全扫描 (Trivy)](#9-安全扫描-trivy)
10. [故障排查](#10-故障排查)

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
| `/app/sing-box-config.json` 存在 | sing-box 后台运行（可选代理） |
| `/app/sing-box-config.json` 不存在 | sing-box **不启动**（默认） |

---

## 2. 文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `Dockerfile` | 镜像定义 | 五阶段构建，内置 cloudflared + sing-box（可选） |
| `start.sh` | 启动脚本 | 编排 Instatic + cloudflared（sing-box 可选） |
| `sing-box-config.json` | 配置模板 | sing-box 可选代理层配置，默认不启用 |
| `compose.prod.yml` | Compose 基座 | PostgreSQL + app 基础服务 |
| `compose.sqlite.yml` | Compose 叠加 | 切换到 SQLite，禁用 PostgreSQL |
| `compose.build.yml` | Compose 叠加 | 本地从 Dockerfile 构建（替代拉取 ghcr.io） |
| `compose.cloudflare-tunnel.yml` | Compose 叠加 | 启用 Cloudflare Tunnel + 关闭端口暴露 |
| `compose.tls.yml` | Compose 叠加 | 启用 Caddy 自动 HTTPS（Let's Encrypt） |
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
    ├─ compose.sqlite.yml          ← OR 切换 SQLite
    │
    ├─ compose.build.yml           ← OPT 本地构建
    │
    ├─ compose.cloudflare-tunnel.yml ← 核心推荐：Cloudflare 隧道
    │
    └─ compose.tls.yml             ← OPT Caddy HTTPS
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

# 重新构建（代码改动后）
docker compose ... -f compose.build.yml up -d --build
```

### 各文件职责

**`compose.prod.yml`** — 基座
- `postgres` 服务（PostgreSQL 16）
- `app` 服务，默认拉取 `ghcr.io/corebunch/instatic:latest`
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
  ghcr.io/corebunch/instatic:latest
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
# 1. 准备 sing-box 配置（监听 :8080）
cat > my-sing-box.json << 'EOF'
{
  "log": { "level": "info" },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-in",
      "listen": "::",
      "listen_port": 8080,
      "users": [{ "uuid": "你的UUID", "flow": "" }],
      "transport": { "type": "ws", "path": "/vless" }
    }
  ],
  "outbounds": [{ "type": "direct", "tag": "direct" }]
}
EOF

# 2. 启动容器（挂载 sing-box 配置 + 设置 Tunnel Token）
docker run -d --name instatic \
  -e CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi... \
  -e INSTATIC_SECRET_KEY=$(openssl rand -base64 48) \
  -e DATABASE_URL="sqlite:/app/data/cms.db" \
  -v $(pwd)/my-sing-box.json:/app/sing-box-config.json:ro \
  -v instatic_data:/app/data \
  -v instatic_uploads:/app/uploads \
  ghcr.io/corebunch/instatic:latest

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

## 8. sing-box 选配（可选代理层）

> sing-box 是内置在镜像中的**可选代理/协议层**，默认不启动。仅当需要代理功能时才需挂载配置。

### 启用条件

`start.sh` 启动时检测 `/app/sing-box-config.json` 是否存在。**默认不存在（不启动）**。

镜像内含 `sing-box-config.json` 作为模板（复制到 `/app/sing-box-config.json.default`），可参考修改。

### 配置示例

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

### 挂载启用

```bash
# docker run 模式
docker run -d --name instatic \
  -p 3001:3001 -p 8080:8080 \
  -e INSTATIC_SECRET_KEY=... \
  -v ./my-sing-box.json:/app/sing-box-config.json:ro \
  ghcr.io/corebunch/instatic:latest

# Compose 模式（在 compose.cloudflare-tunnel.yml 或自定义 overlay 中添加）
services:
  app:
    volumes:
      - ./my-sing-box.json:/app/sing-box-config.json:ro
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
│     /app/sing-box-config.json 存在？
│       YES → sing-box run -c ... &（后台）
│       NO  → 跳过
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
| `DATABASE_URL` | `sqlite:/app/data/cms.db` | 数据库连接 |
| `UPLOADS_DIR` | `/app/uploads` | 上传目录 |
| `STATIC_DIR` | `/app/dist` | 静态文件目录 |
| `NODE_ENV` | `production` | 运行模式 |
| `SING_BOX_CONFIG` | `/app/sing-box-config.json` | （可选）sing-box 配置路径 |
| `INSTATIC_SECRET_KEY` | 必需 | 应用加密密钥 |

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

确认配置文件存在：

```bash
docker exec instatic ls -la /app/sing-box-config.json
# 如果不存在:
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

## 相关文件索引

| 文件 | 说明 |
|------|------|
| `Dockerfile` | 五阶段构建，内置 cloudflared + sing-box（可选） |
| `start.sh` | 启动脚本，核心编排 Instatic + Cloudflare Tunnel |
| `sing-box-config.json` | sing-box 可选代理层配置模板 |
| `compose.prod.yml` | Compose 基座（PostgreSQL） |
| `compose.sqlite.yml` | SQLite 切换叠加层 |
| `compose.build.yml` | 本地构建叠加层 |
| `compose.cloudflare-tunnel.yml` | Cloudflare Tunnel 叠加层（核心推荐） |
| `compose.tls.yml` | Caddy HTTPS 叠加层 |
| `.github/workflows/docker-ci.yml` | GitHub Actions 自动+手动构建 |
| `.github/workflows/release.yml` | 版本发布工作流 |
| `.trivyignore` | Trivy CVE 豁免规则 |
| `.env.production` | 环境变量参考模板 |
| `fly.toml` | Fly.io 部署配置 |
| `deploy-fly.sh` | Fly.io 一键部署脚本 |
