#!/usr/bin/env bash
# Fly.io Instatic CMS 自动备份脚本
# 用法: bash backup-fly.sh [-a <app-name>] [-d <backup-dir>] [-k <keep-days>]
# 建议: 配置 crontab 每日执行

set -euo pipefail

APP_NAME="instatic-cms"
BACKUP_DIR="./backups"
KEEP_DAYS=7

usage() {
    echo "用法: bash backup-fly.sh [-a <app-name>] [-d <backup-dir>] [-k <keep-days>] [-h]"
    echo ""
    echo "选项:"
    echo "  -a  应用名称 (默认: instatic-cms)"
    echo "  -d  备份目录 (默认: ./backups)"
    echo "  -k  保留天数 (默认: 7)"
    echo "  -h  显示帮助"
    exit 0
}

while getopts "a:d:k:h" opt; do
    case $opt in
        a) APP_NAME="$OPTARG" ;;
        d) BACKUP_DIR="$OPTARG" ;;
        k) KEEP_DAYS="$OPTARG" ;;
        h) usage ;;
        *) usage ;;
    esac
done

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/instatic-backup-${TIMESTAMP}.tar.gz"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  Instatic CMS — Fly.io 自动备份${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

mkdir -p "${BACKUP_DIR}"

# 在容器内打包
echo -e "[$(date '+%H:%M:%S')] 在容器内打包数据..."
flyctl ssh console -a "${APP_NAME}" -C "tar -czf /tmp/backup.tar.gz -C /app data uploads"

# 下载到本地
echo -e "[$(date '+%H:%M:%S')] 下载备份文件..."
flyctl ssh sftp get "/tmp/backup.tar.gz" "${BACKUP_FILE}" -a "${APP_NAME}" 2>/dev/null

if [ -f "${BACKUP_FILE}" ]; then
    SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
    echo -e "[$(date '+%H:%M:%S')] ${GREEN}✅ 备份完成: ${BACKUP_FILE} (${SIZE})${NC}"
else
    echo -e "[$(date '+%H:%M:%S')] ${RED}❌ 备份失败: 文件未生成${NC}"
    exit 1
fi

# 清理容器内临时文件
flyctl ssh console -a "${APP_NAME}" -C "rm -f /tmp/backup.tar.gz" 2>/dev/null || true

# 清理旧备份
OLD_COUNT=$(find "${BACKUP_DIR}" -name "instatic-backup-*.tar.gz" -mtime +${KEEP_DAYS} | wc -l)
if [ "$OLD_COUNT" -gt 0 ]; then
    find "${BACKUP_DIR}" -name "instatic-backup-*.tar.gz" -mtime +${KEEP_DAYS} -delete
    echo -e "[$(date '+%H:%M:%S')] 已清理 ${OLD_COUNT} 个超过 ${KEEP_DAYS} 天的旧备份"
fi

echo ""
echo -e "${GREEN}当前备份列表:${NC}"
ls -lh "${BACKUP_DIR}"/instatic-backup-*.tar.gz 2>/dev/null | tail -10
