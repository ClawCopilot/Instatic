# Instatic 部署到 Cloudflare 免费方案 — 可行性分析

> **分析日期**: 2026-07-04
> **分析对象**: Instatic v0.0.10
> **结论**: ❌ 不适合免费部署到 Cloudflare

---

## 1. Cloudflare 免费方案能力总览

| 产品 | 免费额度 | 适用场景 |
|------|---------|---------|
| Cloudflare Pages | 无限静态站点，500次/月构建 | 纯静态前端 |
| Cloudflare Workers | 10万请求/天，10ms CPU/请求 | 轻量 Serverless 函数 |
| Cloudflare D1 | 5GB 存储，50亿行读取/月 | SQLite 兼容数据库 |
| Cloudflare R2 | 10GB 存储，1000万次读取/月 | 对象存储（S3 兼容） |
| Workers KV | 1GB 存储，10万次读取/天 | 键值存储 |
| Cloudflare Queues | 100万次操作/月 | 异步任务队列 |

---

## 2. 关键障碍分析

### 2.1 运行时：Bun → 无法在 Workers 上运行

```
致命障碍 | 严重程度: 🔴 阻断
```

Instatic 后端使用 **Bun 原生 HTTP 服务器**（`Bun.serve()`），`package.json` 明确要求 `engines.bun >=1.3.0 <1.4.0`。

Cloudflare Workers 运行在 **V8 隔离环境**（Workers Runtime），完全不支持：
- `Bun.serve()` — Bun 专属 HTTP 服务器
- `Bun.file()` — 文件 I/O
- `Bun.sql()` — Bun 内置 SQLite 驱动
- `Bun.write()` — 文件写入
- `Bun.spawn()` / `Bun.spawnSync()` — 子进程
- `bun:sqlite` 模块 — 数据库驱动

**代码证据**（`server/index.ts:61`）：
```ts
Bun.serve({
  port: config.port,
  idleTimeout: 0,
  async fetch(req: Request, server: Bun.Server<unknown>) {
    // ...
  },
})
```

整个服务器入口完全依赖 Bun 专属 API，需要完全重写才能运行在 Workers 上。

### 2.2 文件系统依赖

```
致命障碍 | 严重程度: 🔴 阻断
```

Workers 没有文件系统。Instatic 严重依赖磁盘 I/O：

| 路径 | 用途 | Workers 替代方案 |
|------|------|-----------------|
| `./dist/` | 静态文件服务（SPA 前端） | Pages 托管（可行） |
| `./uploads/` | 用户上传文件 | R2 对象存储（可行） |
| `./.tmp/dev.db` | SQLite 数据库 | D1（需重写 DB 层） |
| `/_instatic/runtime/cache/` | 插件运行时依赖缓存 | 无直接替代 |

### 2.3 数据库：`bun:sqlite` → D1 迁移

```
高难度 | 严重程度: 🟡 需大量改造
```

- Instatic 使用 `bun:sqlite` 驱动（Bun 内置，`server/db/sqlite.ts`）
- D1 是 SQLite 兼容的，但 API 完全不同
- 需要重写整个 `server/db/` 层（`sqlite.ts`, `client.ts`, `runMigrations.ts`）
- 迁移文件中大量使用 `Bun.sql` tagged template，需适配 D1 API
- D1 有 5GB 限制，CMS 内容量增长后可能不够
- `createSqliteClient` 中的 PRAGMA 设置（WAL、foreign_keys、synchronous）在 D1 上无意义

**代码证据**（`server/db/sqlite.ts:79-82`）：
```ts
export function createSqliteClient(filename: string): DbClient {
  const db = new Database(filename)  // bun:sqlite 专属
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // ...
}
```

### 2.4 流式 AI 响应

```
中等障碍 | 严重程度: 🟡 功能受限
```

- Instatic AI 聊天使用 **NDJSON streaming**（`encodeStreamEvent()` → `JSON + \n`）
- Workers 免费方案 **10ms CPU 时间限制**（付费 30s）
- AI 模型调用（尤其 MiniMax M3 长时间推理）需数秒到数十秒
- Workers 流式响应支持有限，Response 体限制 100MB（付费方案）
- `server/index.ts:70` 特意设置 `idleTimeout: 0` 以支持长时间 AI 流式连接

**代码证据**（`server/index.ts:64-71`）：
```ts
// Disable Bun's default 10-second idle timeout. The agent endpoint streams
// NDJSON for as long as Claude's loop is running — Claude's "thinking"
// gaps between tool calls regularly exceed 10s on multi-step builds
idleTimeout: 0,
```

### 2.5 原生依赖：`sharp` 图像处理

```
致命障碍 | 严重程度: 🔴 阻断
```

- `sharp` 是 Node.js 原生 C++ 模块（libvips），Workers 完全不支持
- 图像处理是 CMS 核心功能（变体生成、缩放、格式转换）
- 需替换为 WASM 方案或使用 Cloudflare Images（付费服务）

### 2.6 运行时依赖管理

```
高难度 | 严重程度: 🟡 架构冲突
```

- 插件系统需运行时 `bun install` 安装插件依赖
- 运行时 JS 打包使用 `esbuild`
- Workers 没有包管理器、没有子进程
- `scripts/start.ts:32-40` 使用 `Bun.spawnSync` 执行构建命令

---

## 3. 兼容性评分矩阵

| 组件 | 兼容性 | 说明 |
|------|--------|------|
| 前端 SPA (Vite/React) | ✅ 可部署 | Cloudflare Pages 完美支持 |
| 后端 API (Bun.serve) | ❌ 不兼容 | 需完全重写为 Workers |
| 数据库 (bun:sqlite) | ⚠️ 可迁移 | D1 兼容 SQLite，但需重写 DB 层 |
| AI 流式响应 (NDJSON) | ❌ 不兼容 | Workers CPU 时间限制 + 无长连接支持 |
| 图像处理 (sharp) | ❌ 不兼容 | 原生模块不兼容 Workers |
| 文件上传 | ⚠️ 可替代 | 用 R2 对象存储替代磁盘 |
| 运行时打包 (esbuild) | ❌ 不兼容 | 无子进程/包管理器 |
| 插件系统 (bun install) | ❌ 不兼容 | Workers 无包管理器 |

---

## 4. 总体结论

```
┌─────────────────────────────────────────────────────────────┐
│                     Cloudflare 免费方案兼容性                  │
├────────────┬────────────────────────────────────────────────┤
│ 前端 (SPA)  │ ✅ 可以 — Cloudflare Pages 完美支持              │
│ 后端 API   │ ❌ 不行 — Bun 专属 API，需要完全重写              │
│ 数据库     │ ⚠️ 可迁移 — D1 兼容 SQLite，但需重写 DB 层       │
│ AI 流式    │ ❌ 不行 — Workers CPU 时间限制 + 无长连接支持     │
│ 图像处理   │ ❌ 不行 — sharp 原生模块不兼容                    │
│ 文件上传   │ ⚠️ 可替代 — 用 R2 对象存储替代磁盘                │
│ 运行时打包  │ ❌ 不行 — 无子进程/包管理器                       │
└────────────┴────────────────────────────────────────────────┘

总体结论: ❌ 不适合免费部署到 Cloudflare
```

### 即使付费也难以解决

即使升级到 Workers Paid（$5/月），仍有以下不可逾越的障碍：
1. **Bun API** — Workers 永远不支持 Bun 专属 API
2. **sharp 原生模块** — Workers 不支持原生 C++ 模块
3. **运行时 `bun install`** — 插件系统需要包管理器

**结论：Instatic 架构与 Cloudflare Workers 从根本上不兼容，不建议尝试迁移。**

---

## 5. 推荐替代方案

| 方案 | 成本 | 适合程度 | 改动量 |
|------|------|---------|--------|
| **Fly.io** | 免费 3 VM（256MB RAM） | ⭐⭐⭐⭐⭐ | 极少（Docker 部署） |
| **Railway** | $5/月起 | ⭐⭐⭐⭐ | 极少（已内置支持） |
| **Hetzner VPS** | ~€4/月 | ⭐⭐⭐⭐⭐ | 极少（Docker Compose） |
| **Render** | 免费（休眠） | ⭐⭐⭐ | 极少（已内置支持） |
| **自托管 Docker** | 电费 + 硬件 | ⭐⭐⭐⭐⭐ | 无 |

详见：
- [Fly.io 部署指南](./fly-io-deployment-guide.md)
- [Railway 部署指南](./railway-deployment-guide.md)
- [Hetzner VPS 部署指南](./hetzner-vps-deployment-guide.md)
