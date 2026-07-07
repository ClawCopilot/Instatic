#!/bin/bash
# Instatic + sing-box + cloudflared 合体启动脚本
# 参考: link-nvidia 项目统一编排 sing-box + cloudflared 双进程的模式
#
# 架构:
#   sing-box    → 可选，后台运行（存在配置时启动）
#   Instatic    → 后台运行（始终启动）
#   cloudflared → 可选，前台运行（设置了 CLOUDFLARE_TUNNEL_TOKEN 时接管主进程）
#
# 环境变量:
#   CLOUDFLARE_TUNNEL_TOKEN  - Cloudflare Tunnel Token（可选，设置则自动建立隧道）
#   SING_BOX_CONFIG          - sing-box 配置文件路径（可选，默认 /app/sing-box-config.json）
#   PORT                     - Instatic 监听端口（默认 3001）
#   DATABASE_URL             - 数据库连接（默认 sqlite:/app/data/cms.db）
#   UPLOADS_DIR              - 上传目录（默认 /app/uploads）
#   STATIC_DIR               - 静态文件目录（默认 /app/dist）

set -e

echo "=========================================="
echo "  Instatic CMS"
echo "  (sing-box + cloudflared bundled)"
echo "=========================================="
echo ""

# ---- 设置默认环境变量 ----
export PORT="${PORT:-3001}"
export DATABASE_URL="${DATABASE_URL:-sqlite:/app/data/cms.db}"
export UPLOADS_DIR="${UPLOADS_DIR:-/app/uploads}"
export STATIC_DIR="${STATIC_DIR:-/app/dist}"
export NODE_ENV="${NODE_ENV:-production}"

echo "Instatic 配置:"
echo "  PORT       : ${PORT}"
echo "  DATABASE   : ${DATABASE_URL}"
echo "  UPLOADS    : ${UPLOADS_DIR}"
echo ""

# ---- 1. 启动 sing-box（可选） ----
SING_BOX_CONFIG="${SING_BOX_CONFIG:-/app/sing-box-config.json}"
if [ -f "${SING_BOX_CONFIG}" ]; then
    echo "[sing-box] Starting with config: ${SING_BOX_CONFIG}"
    sing-box run -c "${SING_BOX_CONFIG}" &
    SING_BOX_PID=$!
    echo "[sing-box] PID: ${SING_BOX_PID}"
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

# ---- 3. 启动 Cloudflare Tunnel（可选） ----
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN}" ]; then
    echo "[cloudflared] Starting Cloudflare Tunnel..."
    echo "[cloudflared] Your site is now accessible via Cloudflare"
    echo "=========================================="
    echo "  All services running"
    echo "  Instatic PID : ${INSTATIC_PID}"
    [ -n "${SING_BOX_PID}" ] && echo "  sing-box PID : ${SING_BOX_PID}"
    echo "=========================================="
    # cloudflared 前台运行，接管容器主进程
    exec cloudflared tunnel --no-autoupdate run --token "${CLOUDFLARE_TUNNEL_TOKEN}"
else
    echo "[cloudflared] Token not set — skipping"
    echo "=========================================="
    echo "  Instatic running (PID: ${INSTATIC_PID})"
    [ -n "${SING_BOX_PID}" ] && echo "  sing-box running (PID: ${SING_BOX_PID})"
    echo "=========================================="
    # 无隧道时，等待 Instatic 主进程
    wait $INSTATIC_PID
fi
