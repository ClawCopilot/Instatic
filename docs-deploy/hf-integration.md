# Instatic 集成 Hugging Face Dataset 备份 — 入门指南

> 适用场景：零成本异地备份 Instatic 运行时数据，支持一键恢复和跨服务器迁移。

## 概述

Instatic 内置了 HF Dataset 备份/恢复功能（通过 `start.sh` 中的 `hf-backup.sh` 和 `hf-restore.sh` 实现）。只要容器检测到 `HF_TOKEN` + `HF_BACKUP_DATASET` 两个环境变量，就会自动启用：

- **定时备份**：默认每 6 小时将 `/app/data` 和 `/app/uploads` 打包上传到 HF Dataset
- **启动恢复**：设 `HF_RESTORE_ON_START=true` 后，容器启动时自动从 HF Dataset 拉取最新备份并还原

### 备份内容

| 目录 | 内容 |
|------|------|
| `/app/data/` | SQLite 数据库（`cms.db`）— 所有内容、用户、设置 |
| `/app/uploads/published/` | 已发布的静态站点文件 |
| `/app/uploads/plugins/` | 已安装的插件包 |
| `/app/uploads/<media>/` | 媒体库文件（用户上传的图片等） |

### 工作原理

```
容器内
    │
    ├─ /app/data ──────────┐
    ├─ /app/uploads ───────┤
    │                       ▼
    └─ hf-backup.sh → tar.gz → huggingface_hub CLI → HF Dataset
                                                       └─ backups/
                                                           ├─ instatic-backup-20260711-120000.tar.gz
                                                           ├─ instatic-backup-20260711-060000.tar.gz
                                                           └─ latest-backup.tar.gz
```

---

## 前置准备（一次性）

### 1. 注册 Hugging Face 账号

如果还没有账号，前往 [https://huggingface.co/join](https://huggingface.co/join) 注册。

### 2. 创建 Access Token

1. 打开 [https://huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
2. 点击 **「Create new token」**，Token 类型选 **「Write」** 权限
3. 命名建议：`instatic-backup`
4. 复制生成的 Token，格式为 `hf_xxxxxxxxxxxx`

### 3. 创建 Dataset 仓库

1. 打开 [https://huggingface.co/new-dataset](https://huggingface.co/new-dataset)
2. 填写仓库名（如 `instatic-backup`）
3. 隐私建议选 **「Private」**
4. 记下完整仓库名，格式：`你的用户名/instatic-backup`

---

## 在 Railway 上配置（当前部署环境）

### 环境信息

| 项目 | 值 |
|------|-----|
| Project ID | `bc8e8fe1-e294-4bff-badf-2e2e4e0e42cb` |
| Environment ID | `de2eeb76-68af-4ead-958b-516303786445` |
| Service ID | `db3211d4-8456-4ba7-8edc-d9a076a31dce` |

### 基本配置（最小可用）

只需以下两条命令即可启用备份。**设置变量后 Railway 会自动触发 Docker 重新部署。**

```powershell
# PowerShell
$env:RAILWAY_TOKEN="12d17320-785d-4220-b765-7da22ea8b559"

# 1. 设置 HF Token（Secret）
railway variables set `
  HF_TOKEN=hf_你的HF_Token `
  --project=bc8e8fe1-e294-4bff-badf-2e2e4e0e42cb `
  --environment=de2eeb76-68af-4ead-958b-516303786445 `
  --service=db3211d4-8456-4ba7-8edc-d9a076a31dce

# 2. 设置备份 Dataset 仓库
railway variables set `
  HF_BACKUP_DATASET=SZFSPC/instatic-backup-site-techidaily `
  --project=bc8e8fe1-e294-4bff-badf-2e2e4e0e42cb `
  --environment=de2eeb76-68af-4ead-958b-516303786445 `
  --service=db3211d4-8456-4ba7-8edc-d9a076a31dce
```

### 首次部署/数据迁移

如果是全新部署但想恢复之前的数据，或者更换服务器迁移，额外添加：

```powershell
railway variables set `
  HF_RESTORE_ON_START=true `
  --project=bc8e8fe1-e294-4bff-badf-2e2e4e0e42cb `
  --environment=de2eeb76-68af-4ead-958b-516303786445 `
  --service=db3211d4-8456-4ba7-8edc-d9a076a31dce
```

> 恢复完成后可删除此变量（或改为 `false`），避免每次重启都覆盖本地数据。

---

## 环境变量参考

| 变量名 | 默认值 | 必填 | 说明 |
|--------|--------|------|------|
| `HF_TOKEN` | （空） | ✅ | Hugging Face Access Token（Write 权限） |
| `HF_BACKUP_DATASET` | （空） | ✅ | HF Dataset 仓库名，格式 `用户名/仓库名` |
| `HF_RESTORE_ON_START` | `false` | ❌ | `true` 时启动后先从 HF 恢复数据。standby 模式自动启用 |
| `HF_BACKUP_INTERVAL` | `21600` | ❌ | 备份间隔（秒），默认 6 小时 |
| `HF_BACKUP_KEEP_COUNT` | `7` | ❌ | 保留最近 N 个备份，旧的自动删除 |
| `HF_BACKUP_SOURCE_PATHS` | `/app/data,/app/uploads` | ❌ | 要备份的路径，逗号分隔。含逗号的路径用 `\,` 转义 |
| `INSTATIC_ROLE` | `active` | ❌ | HA 角色。`active`=读写+定时备份，`standby`=启动恢复+不备份 |

---

## 验证备份

### 方式 1：查看容器日志

```powershell
$env:RAILWAY_TOKEN="12d17320-785d-4220-b765-7da22ea8b559"

railway logs `
  --project=bc8e8fe1-e294-4bff-badf-2e2e4e0e42cb `
  --environment=de2eeb76-68af-4ead-958b-516303786445 `
  --service=db3211d4-8456-4ba7-8edc-d9a076a31dce `
  | Select-String "hf-backup|hf-restore|HF_|backup"
```

### 方式 2：查看 HF Dataset

1. 打开 `https://huggingface.co/datasets/SZFSPC/instatic-backup-site-techidaily`
2. 应在 `backups/` 目录下看到备份文件：
   - `latest-backup.tar.gz` — 最新备份
   - `instatic-backup-20260711-*.tar.gz` — 按时间戳的备份

---

## 手动操作

```powershell
# 查看当前所有变量
railway variables `
  --project=bc8e8fe1-e294-4bff-badf-2e2e4e0e42cb `
  --environment=de2eeb76-68af-4ead-958b-516303786445 `
  --service=db3211d4-8456-4ba7-8edc-d9a076a31dce

# 删除某个变量（如不需要启动恢复了）
railway variables delete HF_RESTORE_ON_START `
  --project=bc8e8fe1-e294-4bff-badf-2e2e4e0e42cb `
  --environment=de2eeb76-68af-4ead-958b-516303786445 `
  --service=db3211d4-8456-4ba7-8edc-d9a076a31dce
```

---

## 容器进程视图（启用 HF 后）

```
PID 1: cloudflared
  ├─ bun (Instatic, :3001)
  ├─ sing-box (:8080, 可选)
  ├─ hf-backup loop (后台定时备份, 仅 active 模式)
  └─ hf-restore（启动时一次性执行）
```

---

## 典型用法场景

| 场景 | 操作 |
|------|------|
| **日常运行** | 只需设置 `HF_TOKEN` + `HF_BACKUP_DATASET`，自动每 6 小时备份 |
| **新部署** | 设置 `HF_RESTORE_ON_START=true`，从旧实例迁移数据 |
| **迁移服务器** | 新实例设 `HF_RESTORE_ON_START=true`，启动自动恢复 |
| **灾难恢复** | 部署新容器 + `HF_RESTORE_ON_START=true`，自动从 HF 恢复 |
| **主备切换** | standby 节点设 `INSTATIC_ROLE=standby`，自动恢复但不执行备份 |

---

## 相关链接

- Hugging Face 注册：[https://huggingface.co/join](https://huggingface.co/join)
- Token 管理：[https://huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
- 创建 Dataset：[https://huggingface.co/new-dataset](https://huggingface.co/new-dataset)
- 参考项目（OpenClaw HF Docker）：[https://github.com/ClawCopilot/Openclaw-Hf-Docker](https://github.com/ClawCopilot/Openclaw-Hf-Docker)
