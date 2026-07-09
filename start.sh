#!/bin/bash
# Instatic + Cloudflare Tunnel 启动脚本
# sing-box 作为可选代理层，默认不启动
# Hugging Face Dataset 备份/恢复（可选）
# HA 主备模式（可选）
#
# 架构:
#   Instatic    → 前台/后台运行（始终启动）
#   cloudflared → 可选前台运行（设置了 CLOUDFLARE_TUNNEL_TOKEN 时接管主进程）
#   sing-box    → 可选后台运行（存在配置时启动）
#   hf-backup   → 可选定时备份（INSTATIC_ROLE=active + HF 已配置时启用）
#
# 环境变量:
#   PORT                     - Instatic 监听端口（默认 3001）
#   CLOUDFLARE_TUNNEL_TOKEN   - Cloudflare Tunnel Token（设置后自动建隧道）
#   CLOUDFLARE_TUNNEL_HOSTNAME - Cloudflare Tunnel 公网域名（可选，如 cms.example.com）
#   SING_BOX_UUID            - VLESS UUID（设置后自动生成配置并启动，零文件方式）
#   SING_BOX_PORT            - sing-box 监听端口（默认 8080）
#   SING_BOX_PATH            - WebSocket 路径（默认 /vless）
#   SING_BOX_LOG_LEVEL       - sing-box 日志级别（默认 info）
#   SING_BOX_CONFIG          - 自定义配置文件路径（高级用法，挂载完整 JSON 配置）
#   DATABASE_URL             - 数据库连接（默认 sqlite:/app/data/cms.db）
#   UPLOADS_DIR              - 上传目录（默认 /app/uploads）
#   STATIC_DIR               - 静态文件目录（默认 /app/dist）
#   HF_TOKEN                 - Hugging Face Token（可选，设置后启用备份/恢复）
#   HF_BACKUP_DATASET        - HF Dataset 仓库名（可选，格式 user/dataset）
#   HF_RESTORE_ON_START      - 启动时从 HF 恢复数据（可选，默认 false）
#   HF_BACKUP_INTERVAL       - 备份间隔秒数（可选，默认 21600 = 6小时）
#   HF_BACKUP_SOURCE_PATHS   - 备份源路径，逗号分隔，支持文件和目录（默认 /app/data,/app/uploads）
#   INSTATIC_ROLE            - HA 角色：active（默认，可读写+备份）/ standby（只读备机，启动时恢复）

set -e

echo "=========================================="
echo "  Instatic CMS"
echo "  + Cloudflare Tunnel (built-in)"
echo "=========================================="
echo ""

# ---- 设置默认环境变量 ----
export PORT="${PORT:-3001}"
export DATABASE_URL="${DATABASE_URL:-sqlite:/app/data/cms.db}"
export UPLOADS_DIR="${UPLOADS_DIR:-/app/uploads}"
export STATIC_DIR="${STATIC_DIR:-/app/dist}"
export NODE_ENV="${NODE_ENV:-production}"

# HA 角色
export INSTATIC_ROLE="${INSTATIC_ROLE:-active}"
ROLE_FILE="/app/data/.ha-role"

# 恢复持久化的 HA 角色（ha-switch.sh 写入，跨重启保留）
if [ -f "${ROLE_FILE}" ]; then
    PERSISTED_ROLE=$(cat "${ROLE_FILE}")
    if [ "${PERSISTED_ROLE}" != "${INSTATIC_ROLE}" ]; then
        echo "[ha] Persisted role '${PERSISTED_ROLE}' overrides env '${INSTATIC_ROLE}'"
        export INSTATIC_ROLE="${PERSISTED_ROLE}"
    fi
fi

# 备用节点：启动时自动恢复数据
if [ "${INSTATIC_ROLE}" = "standby" ]; then
    export HF_RESTORE_ON_START="true"
fi

# HF 备份相关默认值
export HF_BACKUP_INTERVAL="${HF_BACKUP_INTERVAL:-21600}"           # 默认 6 小时
export HF_BACKUP_KEEP_COUNT="${HF_BACKUP_KEEP_COUNT:-7}"           # 保留最近 7 个备份
export HF_RESTORE_ON_START="${HF_RESTORE_ON_START:-false}"

echo "Instatic 配置:"
echo "  PORT       : ${PORT}"
echo "  DATABASE   : ${DATABASE_URL}"
echo "  UPLOADS    : ${UPLOADS_DIR}"
echo "  HA Role    : ${INSTATIC_ROLE}"
if [ -n "${HF_TOKEN}" ] && [ -n "${HF_BACKUP_DATASET}" ]; then
    echo "  HF Backup  : ${HF_BACKUP_DATASET} (interval=${HF_BACKUP_INTERVAL}s)"
    echo "  HF Restore : ${HF_RESTORE_ON_START}"
fi
echo ""

# ---- 0a. HF 备份——关机前最后一次备份 ----
backup_on_shutdown() {
    if [ -n "${HF_TOKEN}" ] && [ -n "${HF_BACKUP_DATASET}" ]; then
        echo ""
        echo "[hf-backup] Shutdown detected — running final backup..."
        hf-backup 2>&1 || true
    fi
    exit 0
}
trap backup_on_shutdown SIGTERM SIGINT SIGQUIT

# ---- 0b. HF 恢复——启动时从 Dataset 恢复数据（可选） ----
if [ "${HF_RESTORE_ON_START}" = "true" ]; then
    echo "[hf-restore] Starting restore from ${HF_BACKUP_DATASET}..."
    hf-restore 2>&1
    echo ""
fi

# ---- 0c. HF 备份——后台定时备份循环（仅 active 节点，可选） ----
if [ "${INSTATIC_ROLE}" = "active" ] && [ -n "${HF_TOKEN}" ] && [ -n "${HF_BACKUP_DATASET}" ]; then
    (
        echo "[hf-backup] Background scheduler started (interval=${HF_BACKUP_INTERVAL}s, role=${INSTATIC_ROLE})"
        # 启动后先等 60 秒，让服务完全就绪
        sleep 60
        while true; do
            hf-backup 2>&1
            sleep "${HF_BACKUP_INTERVAL}"
        done
    ) &
    HF_BACKUP_LOOP_PID=$!
    echo "[hf-backup] Scheduler PID: ${HF_BACKUP_LOOP_PID}"
    echo ""
elif [ "${INSTATIC_ROLE}" = "standby" ]; then
    echo "[hf-backup] Standby node — backup DISABLED (only active nodes back up)"
    echo ""
fi

# ---- 1. 启动 sing-box（可选） ----
# 启用方式（优先级从高到低）：
#   A) 设置 SING_BOX_UUID 环境变量 → 自动生成 VLESS+WS 配置（最简单）
#   B) 挂载自定义配置文件到 /app/sing-box-config.json
#   C) 不设置 → 跳过 sing-box（默认）
SING_BOX_CONFIG="${SING_BOX_CONFIG:-/app/sing-box-config.json}"

# A: 环境变量方式（零文件，开箱即用）
if [ -n "${SING_BOX_UUID}" ]; then
    SING_BOX_PORT="${SING_BOX_PORT:-8080}"
    SING_BOX_PATH="${SING_BOX_PATH:-/vless}"
    SING_BOX_LOG_LEVEL="${SING_BOX_LOG_LEVEL:-info}"
    SING_BOX_CONFIG="/tmp/sing-box-config.json"
    cat > "${SING_BOX_CONFIG}" << SINGBOXEOF
{
  "log": { "level": "${SING_BOX_LOG_LEVEL}" },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-in",
      "listen": "::",
      "listen_port": ${SING_BOX_PORT},
      "users": [{ "uuid": "${SING_BOX_UUID}" }],
      "transport": { "type": "ws", "path": "${SING_BOX_PATH}" }
    }
  ],
  "outbounds": [{ "type": "direct", "tag": "direct" }]
}
SINGBOXEOF
    echo "[sing-box] Config generated from SING_BOX_UUID (port=${SING_BOX_PORT} path=${SING_BOX_PATH})"
fi

if [ -f "${SING_BOX_CONFIG}" ]; then
    echo "[sing-box] Starting with config: ${SING_BOX_CONFIG}"
    sing-box run -c "${SING_BOX_CONFIG}" &
    SING_BOX_PID=$!
    # Allow sing-box startup failure without aborting the whole script
    sleep 1
    if ! kill -0 "${SING_BOX_PID}" 2>/dev/null; then
        echo "[sing-box] WARNING: sing-box exited immediately — check config"
        unset SING_BOX_PID
    else
        echo "[sing-box] PID: ${SING_BOX_PID}"
    fi
else
    echo "[sing-box] Config not found at ${SING_BOX_CONFIG} — skipping"
fi
echo ""

# ---- 2. 启动 Instatic（后台） ----
echo "[Instatic] Starting on port ${PORT}..."
bun run server/index.ts &
INSTATIC_PID=$!
echo "[Instatic] PID: ${INSTATIC_PID}"

# 等待 Instatic 健康检查
echo "[Instatic] Waiting for readiness..."
for i in $(seq 1 30); do
    if bun run server/healthcheck.ts 2>/dev/null; then
        echo "[Instatic] Ready ✓"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "[Instatic] Startup timed out after 60s"
        exit 1
    fi
    sleep 2
done
echo ""

# ---- 3. 打印连接信息摘要 ----
echo ""
echo "=========================================="
echo "  连接信息"
echo "=========================================="

# Instatic CMS 地址
if [ -n "${CLOUDFLARE_TUNNEL_HOSTNAME}" ]; then
    echo "  CMS 管理后台 : https://${CLOUDFLARE_TUNNEL_HOSTNAME}/admin/"
    echo "  公开站点     : https://${CLOUDFLARE_TUNNEL_HOSTNAME}/"
elif [ -n "${CLOUDFLARE_TUNNEL_TOKEN}" ]; then
    echo "  CMS 管理后台 : http://localhost:${PORT}/admin/"
    echo "  (!) 已配置 Cloudflare Tunnel，但未设置 CLOUDFLARE_TUNNEL_HOSTNAME"
    echo "      请在 Cloudflare Zero Trust 面板绑定域名，并设置此变量以显示公网地址"
else
    echo "  CMS 管理后台 : http://localhost:${PORT}/admin/"
fi

# sing-box VLESS 连接串
if [ -n "${SING_BOX_PID}" ]; then
    SB_PORT="${SING_BOX_PORT:-8080}"
    SB_PATH="${SING_BOX_PATH:-/vless}"
    echo ""
    echo "  VLESS 代理 :"
    if [ -n "${SING_BOX_UUID}" ] && [ -n "${CLOUDFLARE_TUNNEL_HOSTNAME}" ]; then
        # 有域名 + env UUID → 输出完整 VLESS 链接
        VLESS_URL="vless://${SING_BOX_UUID}@${CLOUDFLARE_TUNNEL_HOSTNAME}:443?encryption=none&security=tls&type=ws&path=${SB_PATH}#Instatic"
        echo "    ${VLESS_URL}"
    elif [ -n "${SING_BOX_UUID}" ]; then
        # 有 UUID 但没域名 → 输出模板
        echo "    vless://${SING_BOX_UUID}@<服务器IP>:${SB_PORT}?encryption=none&type=ws&path=${SB_PATH}#Instatic"
    else
        # 自定义配置文件，不知道协议细节
        echo "    (自定义配置)  端口=${SB_PORT} 路径=${SB_PATH}"
    fi
fi

echo "=========================================="
echo ""

# ---- 4. 启动 Cloudflare Tunnel（可选） ----
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN}" ]; then
    echo "[cloudflared] Starting Cloudflare Tunnel..."
    echo "[cloudflared] Tunnel 正在建立，请稍候..."
    # cloudflared 前台运行，接管容器主进程
    exec cloudflared tunnel --no-autoupdate run --token "${CLOUDFLARE_TUNNEL_TOKEN}"
    # exec failed - should not reach here
    echo "[cloudflared] FATAL: exec cloudflared failed"
    exit 1
else
    echo "[cloudflared] Token not set — skipping"
    echo "  PID: Instatic=${INSTATIC_PID}"
    [ -n "${SING_BOX_PID}" ] && echo "       sing-box=${SING_BOX_PID}"
    [ -n "${HF_BACKUP_LOOP_PID}" ] && echo "       hf-backup=${HF_BACKUP_LOOP_PID}"
    # 无隧道时，等待 Instatic 主进程
    wait $INSTATIC_PID
fi
