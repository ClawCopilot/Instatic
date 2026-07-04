#!/usr/bin/env bash
# Bash 一键部署脚本 — Instatic CMS on Fly.io
# 用法: bash deploy-fly.sh [-n <name>] [-r <region>]
# 首次运行会引导完成所有配置，后续运行自动执行部署

set -euo pipefail

# ============================================================
# 默认参数
# ============================================================
APP_NAME="instatic-cms"
REGION="nrt"

usage() {
    echo "用法: bash deploy-fly.sh [-n <app-name>] [-r <region>] [-h]"
    echo ""
    echo "选项:"
    echo "  -n  应用名称 (默认: instatic-cms)"
    echo "  -r  Fly.io 区域 (默认: nrt)"
    echo "  -h  显示帮助"
    echo ""
    echo "示例:"
    echo "  bash deploy-fly.sh"
    echo "  bash deploy-fly.sh -n my-cms -r hkg"
    exit 0
}

while getopts "n:r:h" opt; do
    case $opt in
        n) APP_NAME="$OPTARG" ;;
        r) REGION="$OPTARG" ;;
        h) usage ;;
        *) usage ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

echo -e "${CYAN}"
echo "========================================"
echo "  Instatic CMS — Fly.io 一键部署"
echo "========================================"
echo -e "  应用名 : ${APP_NAME}"
echo -e "  区域   : ${REGION}"
echo -e "  内存   : 2GB RAM / shared-cpu-2x"
echo -e "  存储   : 100GB 持久卷"
echo -e "========================================${NC}"
echo ""

# ============================================================
# 1. 环境检查
# ============================================================
echo -e "${YELLOW}[1/8] 检查环境...${NC}"

if ! command -v flyctl &> /dev/null; then
    echo -e "${RED}❌ 未找到 flyctl，请先安装:${NC}"
    echo -e "${GRAY}   curl -L https://fly.io/install.sh | sh${NC}"
    exit 1
fi
echo -e "   ${GREEN}✅${NC} flyctl 已安装: $(flyctl version 2>&1 | head -1)"

# 检查登录
if ! flyctl auth whoami &> /dev/null; then
    echo -e "   ${YELLOW}未登录，正在打开登录页面...${NC}"
    flyctl auth login
fi
echo -e "   ${GREEN}✅${NC} 已登录"

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ 未找到 Docker，请先安装 Docker${NC}"
    exit 1
fi
echo -e "   ${GREEN}✅${NC} Docker 已安装"

# ============================================================
# 2. 检查/创建 Fly 应用
# ============================================================
echo -e "${YELLOW}[2/8] 检查 Fly 应用...${NC}"

if flyctl apps list 2>/dev/null | grep -q "$APP_NAME"; then
    echo -e "   ${GREEN}✅${NC} 应用 '${APP_NAME}' 已存在"
else
    echo -e "   ${YELLOW}创建新应用: ${APP_NAME} ...${NC}"
    flyctl apps create "$APP_NAME" --org personal
    echo -e "   ${GREEN}✅${NC} 应用已创建"
fi

# ============================================================
# 3. 创建持久化存储卷
# ============================================================
echo -e "${YELLOW}[3/8] 配置持久化存储卷...${NC}"

VOLUMES=$(flyctl volumes list -a "$APP_NAME" 2>/dev/null || true)

if ! echo "$VOLUMES" | grep -q "instatic_data"; then
    echo -e "   ${YELLOW}创建卷: instatic_data (50GB)...${NC}"
    flyctl volumes create instatic_data --size 50 --region "$REGION" -a "$APP_NAME"
    echo -e "   ${GREEN}✅${NC} instatic_data 已创建"
else
    echo -e "   ${GREEN}✅${NC} instatic_data 已存在"
fi

if ! echo "$VOLUMES" | grep -q "instatic_uploads"; then
    echo -e "   ${YELLOW}创建卷: instatic_uploads (50GB)...${NC}"
    flyctl volumes create instatic_uploads --size 50 --region "$REGION" -a "$APP_NAME"
    echo -e "   ${GREEN}✅${NC} instatic_uploads 已创建"
else
    echo -e "   ${GREEN}✅${NC} instatic_uploads 已存在"
fi

# ============================================================
# 4. 生成并设置密钥
# ============================================================
echo -e "${YELLOW}[4/8] 配置安全密钥...${NC}"

SECRETS=$(flyctl secrets list -a "$APP_NAME" 2>/dev/null || true)

if ! echo "$SECRETS" | grep -q "INSTATIC_SECRET_KEY"; then
    # 生成 64 字节随机密钥
    SECRET_KEY=$(openssl rand -base64 48 2>/dev/null || cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c64)
    echo -e "   ${YELLOW}生成 INSTATIC_SECRET_KEY...${NC}"
    flyctl secrets set INSTATIC_SECRET_KEY="$SECRET_KEY" -a "$APP_NAME"
    echo -e "   ${GREEN}✅${NC} INSTATIC_SECRET_KEY 已设置"
else
    echo -e "   ${GREEN}✅${NC} INSTATIC_SECRET_KEY 已存在"
fi

if ! echo "$SECRETS" | grep -q "PUBLIC_ORIGIN"; then
    PUBLIC_ORIGIN="https://${APP_NAME}.fly.dev"
    echo -e "   ${YELLOW}设置 PUBLIC_ORIGIN=${PUBLIC_ORIGIN}...${NC}"
    flyctl secrets set PUBLIC_ORIGIN="$PUBLIC_ORIGIN" -a "$APP_NAME"
    echo -e "   ${GREEN}✅${NC} PUBLIC_ORIGIN 已设置"
else
    echo -e "   ${GREEN}✅${NC} PUBLIC_ORIGIN 已存在"
fi

if ! echo "$SECRETS" | grep -q "TRUSTED_PROXY_CIDRS"; then
    echo -e "   ${YELLOW}设置 TRUSTED_PROXY_CIDRS...${NC}"
    flyctl secrets set TRUSTED_PROXY_CIDRS="fdaa::/16" -a "$APP_NAME"
    echo -e "   ${GREEN}✅${NC} TRUSTED_PROXY_CIDRS 已设置"
fi

# ============================================================
# 5. 部署应用
# ============================================================
echo -e "${YELLOW}[5/8] 部署应用...${NC}"
echo -e "   ${GRAY}正在构建 Docker 镜像并部署到 Fly.io...${NC}"
echo -e "   ${GRAY}这可能需要几分钟，请耐心等待...${NC}"

cd "$SCRIPT_DIR"
flyctl deploy --ha=false -a "$APP_NAME"
echo -e "   ${GREEN}✅${NC} 部署成功"

# ============================================================
# 6. 分配 IPv4
# ============================================================
echo -e "${YELLOW}[6/8] 配置网络...${NC}"

IP_LIST=$(flyctl ips list -a "$APP_NAME" 2>/dev/null || true)
if ! echo "$IP_LIST" | grep -q "v4"; then
    echo -e "   ${YELLOW}分配共享 IPv4 地址...${NC}"
    flyctl ips allocate-v4 -a "$APP_NAME" --shared 2>/dev/null || true
    echo -e "   ${GREEN}✅${NC} IPv4 已分配"
else
    echo -e "   ${GREEN}✅${NC} IPv4 已存在"
fi

# ============================================================
# 7. 健康检查
# ============================================================
echo -e "${YELLOW}[7/8] 健康检查...${NC}"

echo -e "   ${GRAY}等待应用启动...${NC}"
sleep 10

STATUS=$(flyctl status -a "$APP_NAME" 2>/dev/null || true)
if echo "$STATUS" | grep -q "running"; then
    echo -e "   ${GREEN}✅${NC} 应用运行正常"
else
    echo -e "   ${YELLOW}⚠️ 应用状态异常，查看日志:${NC}"
    flyctl logs -a "$APP_NAME" | tail -20
fi

# ============================================================
# 8. 输出结果
# ============================================================
echo ""
echo -e "${CYAN}========================================"
echo "  🎉 部署成功！"
echo "========================================"
echo -e "  访问地址 : https://${APP_NAME}.fly.dev/admin/"
echo -e "  应用名称 : ${APP_NAME}"
echo -e "  区域     : ${REGION}"
echo -e "  内存     : 2GB RAM / shared-cpu-2x"
echo -e "  存储卷   : instatic_data (50GB) + instatic_uploads (50GB)"
echo ""
echo -e "  首次访问会自动跳转到初始化页面。"
echo -e "  请立即创建管理员账号！"
echo ""
echo "========================================"
echo "  常用命令"
echo "========================================"
echo -e "  flyctl logs -a ${APP_NAME}            # 查看日志"
echo -e "  flyctl status -a ${APP_NAME}          # 查看状态"
echo -e "  flyctl ssh console -a ${APP_NAME}     # SSH 进入容器"
echo -e "  flyctl secrets list -a ${APP_NAME}    # 查看密钥"
echo -e "  bash backup-fly.sh                    # 手动备份"
echo -e "========================================${NC}"
echo ""

# 询问是否设置自定义域名
read -r -p "是否要设置自定义域名？(y/n): " SET_DOMAIN
if [ "$SET_DOMAIN" = "y" ] || [ "$SET_DOMAIN" = "Y" ]; then
    read -r -p "请输入域名（如 cms.example.com）: " DOMAIN
    if [ -n "$DOMAIN" ]; then
        flyctl certs create "$DOMAIN" -a "$APP_NAME"
        flyctl secrets set PUBLIC_ORIGIN="https://${DOMAIN}" -a "$APP_NAME"
        echo ""
        echo -e "${YELLOW}请在 DNS 服务商添加以下记录:${NC}"
        echo -e "  ${GRAY}类型: CNAME  名称: $(echo "$DOMAIN" | cut -d'.' -f1)  值: ${APP_NAME}.fly.dev${NC}"
        echo ""
        echo -e "${YELLOW}证书验证通过后，重新部署:${NC}"
        echo -e "  ${GRAY}flyctl deploy -a ${APP_NAME}${NC}"
    fi
fi
