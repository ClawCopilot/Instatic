
## 2026-07-10 ~ 2026-07-11 运行日志

### 操作：登录 Railway 检查服务状态 → 发现端口不匹配 → 修复

#### 环境信息

| 项目 | 值 |
|------|-----|
| Workspace | Dan Kaminsky's Projects |
| Project | empathetic-transformation (`bc8e8fe1`) |
| Environment | production (`de2eeb76`) |
| instatic Service ID | `db3211d4-8456-4ba7-8edc-d9a076a31dce` |

#### instatic 服务环境变量（用户自定义）

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `PORT` | `3001` | 覆盖 Railway 默认 8080，与 Cloudflare Tunnel 转发目标一致 |
| `CLOUDFLARE_TUNNEL_HOSTNAME` | `techidaily.com` | Tunnel 绑定的域名 |
| `CLOUDFLARE_TUNNEL_TOKEN` | `eyJhIjoiZDBkM2UzZjUyZWI1MDQzYjRlYjU3ZTEzZTkwNzg0OTEiLCJ0IjoiNGZkYmI1ZmQtOWY1Yi00YTZiLTlkMGMtMGFhODAzOTRmYTlkIiwicyI6Ik1XTXdOMlV3WkRBdE1qZzNNUzAwTVdOa0xUbGhaV1l0TmpNNE4yTXlaV0k1TkRRNCJ9` | Cloudflare Tunnel 认证 Token |
| `INSTATIC_ROLE` | `active` | Instatic 运行角色（active=定时备份，standby=不备份） |
| `INSTATIC_SECRET_KEY` | `oXmseUiBs8rVs8xz5HkpU7ykMO/Ih55flUARQakEUWA=` | AES-256 主密钥（32 字节 base64），用于加密 AI 凭据和 MFA TOTP 种子 |
| `HF_TOKEN` | `hf_xxxxxxxxxxxx` | Hugging Face Access Token（Write 权限） |
| `HF_BACKUP_DATASET` | `SZFSPC/instatic-backup-site-techidaily` | HF Dataset 备份仓库 |
| `PUBLIC_ORIGIN` | `https://techidaily.com` | 外部域名，用于 CSRF Origin 校验（详见下方说明） |

> 注：此表仅列出用户自定义变量，Railway 平台自动注入的变量（如 `RAILWAY_*`）未包含。

#### 关于 `PUBLIC_ORIGIN` 的常见疑问

**Q: `PUBLIC_ORIGIN` 是不是 Railway 控制的？后面会收费？**

**A: 不会，跟 Railway 计费完全无关。**

`PUBLIC_ORIGIN` 和 Railway 的 "Public Domain" 功能是两码事：

| 对比维度 | `PUBLIC_ORIGIN`（我们设的） | Railway Public Domain（平台功能） |
|----------|---------------------------|--------------------------------|
| **谁读取** | Instatic 应用的 CSRF 校验代码 | Railway 平台路由层 |
| **作用** | 告诉 Instatic "外部域名是什么"，用于匹配浏览器请求的 `Origin` 头 | 给容器分配一个公网域名，直接暴露到互联网 |
| **是否收费** | ❌ 免费，只是一个普通字符串环境变量 | Railway TCP Proxy 按流量计费 |
| **我们用了它吗** | ✅ 用了，解决 CSRF 403 问题 | ❌ 没启用，我们走 Cloudflare Tunnel |

具体逻辑：
1. 我们的站点通过 Cloudflare Tunnel 入站，请求到达容器时 `Host` 头是 Railway 内部地址（如 `instatic.railway.internal`）
2. 但浏览器请求时发的 `Origin` 头是 `https://techidaily.com`
3. Instatic 的 CSRF 防护会用 `Origin` 对比 `PUBLIC_ORIGIN`（或退而求其次对比 `Host` 头）
4. 没设 `PUBLIC_ORIGIN` → 对比内部 Host → 不匹配 → 403
5. 设了 `PUBLIC_ORIGIN=https://techidaily.com` → 对比外部域名 → 匹配 → 通过

说白了就是一个给 Instatic 看的字符串变量，跟 Railway 平台计费没有任何关系。

#### 服务状态

| 服务 | 状态 |
|------|------|
| link-nvidia | 🟢 Online |
| instatic | 🟢 Online |

#### 发现的问题

Instatic 运行在 `PORT=8080`（Railway 平台默认注入），但 Cloudflare Tunnel 的 Public Hostname 配置转发到 `localhost:3001`，导致端口不匹配，所有通过 Tunnel 的请求报 `connection refused`。

#### 修复步骤

1. 在 Railway instatic 服务中添加环境变量 `PORT=3001`，覆盖平台默认的 `8080`：
   ```
   railway variables set PORT=3001 --project=... --environment=... --service=...
   ```
2. Railway 自动触发 Docker 重新构建（部署 `a6aecb73` → ✅ SUCCESS）

#### 修复后验证

```
[Instatic] Starting on port 3001...
[server] Listening on http://localhost:3001
PORT       : 3001
[Instatic] Ready ✓
```

Cloudflare Tunnel 注册 4 条连接（sjc01/sjc05/sjc07/sjc06，协议 HTTP/2），所有 connectivity pre-checks 通过，无 `connection refused` 错误。

#### 踩坑记录：`railway up` 导致 "Deploy failed"

在 `variables set` 已触发部署后，又执行了 `railway up`，导致一个额外的部署（`bfcbb5eb` → ❌ FAILED）。

**失败原因**：`railway up` 将本地源码打包上传，Railway 默认用 Railpack 自动检测项目类型来构建，但 Railpack 不认识这个项目的 Dockerfile + Bun + start.sh 组合，报 `Script start.sh not found`。

**实际影响**：无。当前运行的容器来自 `variables set` 触发的 Docker 部署，服务一切正常。"Deploy failed" 只是仪表板显示，不影响运行中的容器。

**教训**：本项目走 Docker 构建，修改环境变量后 Railway 会自动触发 Docker 重新部署，**不要**再执行 `railway up`。

| CLI 命令 | 用途 |
|----------|------|
| `railway status --project=xxx --environment=xxx` | 查看项目/服务状态 |
| `railway logs --project=xxx --environment=xxx --service=xxx` | 查看服务运行时日志 |
| `railway variables set KEY=value --project=xxx --environment=xxx --service=xxx` | 设置环境变量（会自动触发 Docker 重新部署） |
| `railway deployment list --project=xxx --environment=xxx --service=xxx` | 查看部署历史 |

> ⚠️ **本项目不要使用 `railway up`**，它不是 Railpack/Nixpacks 项目，用 `railway variables set` 改变量即可触发部署。

---

### 操作：配置 Hugging Face Dataset 定时备份

#### 添加的变量

| 变量 | 值 |
|------|-----|
| `HF_TOKEN` | `hf_xxxxxxxxxxxx` |
| `HF_BACKUP_DATASET` | `SZFSPC/instatic-backup-site-techidaily` |
| `INSTATIC_ROLE` | `active`（由 `standby` 改为 `active`，否则不执行定时备份） |

#### 验证日志

```
HA Role    : active
HF Backup  : SZFSPC/instatic-backup-site-techidaily (interval=21600s)
[hf-backup] Background scheduler started (interval=21600s, role=active)
```

备份调度器已启动，默认每 6 小时自动备份 `/app/data` 和 `/app/uploads` 到 HF Dataset。

---

### 操作：修复 "Forbidden: invalid origin" CSRF 错误

#### 现象

访问 `https://techidaily.com/admin/dashboard` 的 Set Up CMS 页面，创建 admin 时报 `Forbidden: invalid origin`（HTTP 403）。

#### 根因

Instatic 有 CSRF 防护：POST/PUT/PATCH/DELETE 请求必须来自与 `PUBLIC_ORIGIN` 匹配的 Origin 头。

1. 浏览器发 `Origin: https://techidaily.com`
2. 容器内没设 `PUBLIC_ORIGIN`，`expectedOrigin` 回退到 `Host` 头（内部 Railway 地址）
3. `https://techidaily.com` ≠ 内部 Host → `originAllowed` 返回 false → 403

#### 修复

```powershell
railway variables set PUBLIC_ORIGIN=https://techidaily.com --project=... --environment=... --service=...
```

部署后 CSRF 校验通过，可以正常创建 admin 账户。

---

### 操作：修复 `INSTATIC_SECRET_KEY` 格式错误

#### 现象

日志报错：

```
AI credential encryption is not configured: env var INSTATIC_SECRET_KEY
decoded to 138 bytes; must be exactly 32.
Generate a new key with: bun run scripts/generate-secret-key.ts
```

#### 根因

`INSTATIC_SECRET_KEY` 必须是 **base64 编码的 32 字节随机密钥**（AES-256），但之前误填了 Cloudflare Tunnel Token（JWT 格式，解码后 138 字节）。

两个值碰巧都以 `eyJ...` 开头，但用途完全不同：
- `CLOUDFLARE_TUNNEL_TOKEN`：Cloudflare 下发的 JWT，用于 Tunnel 认证
- `INSTATIC_SECRET_KEY`：自生成的 32 字节密钥，用于 AES-256-GCM 加密

#### 修复

生成正确的密钥并更新 Railway 环境变量：

```powershell
# 生成 32 字节 base64 密钥
node -e "const crypto = require('crypto'); console.log(crypto.randomBytes(32).toString('base64'))"
# 输出: oXmseUiBs8rVs8xz5HkpU7ykMO/Ih55flUARQakEUWA=

# 更新 Railway
railway variables set INSTATIC_SECRET_KEY=oXmseUiBs8rVs8xz5HkpU7ykMO/Ih55flUARQakEUWA= --project=... --environment=... --service=...
```

部署后无加密错误，AI credential encryption 正常工作。

> ⚠️ 如果将来换密钥，之前用旧密钥加密的 AI 凭据和 MFA TOTP 种子将无法解密，需要重新录入。
