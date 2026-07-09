#!/bin/bash
# Instatic Hugging Face Dataset 备份脚本
# 将 /app/data 和 /app/uploads 打包上传到 Hugging Face Dataset
#
# 环境变量:
#   HF_TOKEN               - Hugging Face 访问令牌（必填）
#   HF_BACKUP_DATASET      - HF Dataset 仓库名，格式 user/dataset-name（必填）
#   HF_BACKUP_KEEP_COUNT   - 保留备份数量（默认 7）
#   HF_BACKUP_SOURCE_DIRS  - 备份源目录（默认 /app/data /app/uploads）
#
# 用法:
#   hf-backup.sh           - 手动执行一次备份

set -e

HF_TOKEN="${HF_TOKEN:-}"
HF_BACKUP_DATASET="${HF_BACKUP_DATASET:-}"
HF_BACKUP_KEEP_COUNT="${HF_BACKUP_KEEP_COUNT:-7}"
HF_BACKUP_SOURCE_DIRS="${HF_BACKUP_SOURCE_DIRS:-/app/data /app/uploads}"

# 未配置则静默跳过
if [ -z "${HF_TOKEN}" ] || [ -z "${HF_BACKUP_DATASET}" ]; then
    echo "[hf-backup] HF_TOKEN or HF_BACKUP_DATASET not configured — skipping"
    exit 0
fi

export HF_TOKEN
BACKUP_DIR="/tmp/instatic-hf-backup"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="instatic-backup-${TIMESTAMP}.tar.gz"
LATEST="latest-backup.tar.gz"

mkdir -p "${BACKUP_DIR}"

echo "[hf-backup] $(date -u '+%Y-%m-%d %H:%M:%S UTC') Starting backup..."

# 打包备份源目录（忽略不存在的目录）
SOURCE_ARGS=()
for d in ${HF_BACKUP_SOURCE_DIRS}; do
    if [ -d "$d" ]; then
        # 转换为相对 /app 的路径
        rel="${d#/app/}"
        SOURCE_ARGS+=(-C /app "$rel")
    fi
done

if [ ${#SOURCE_ARGS[@]} -eq 0 ]; then
    echo "[hf-backup] No source directories found — skipping"
    exit 0
fi

echo "[hf-backup] Archiving: ${HF_BACKUP_SOURCE_DIRS}"
tar -czf "${BACKUP_DIR}/${ARCHIVE}" "${SOURCE_ARGS[@]}"

ARCHIVE_SIZE=$(du -h "${BACKUP_DIR}/${ARCHIVE}" | cut -f1)
echo "[hf-backup] Archive size: ${ARCHIVE_SIZE}"

# 上传带时间戳的归档
echo "[hf-backup] Uploading ${ARCHIVE} → ${HF_BACKUP_DATASET}/backups/${ARCHIVE}"
huggingface-cli upload "${HF_BACKUP_DATASET}" \
    "${BACKUP_DIR}/${ARCHIVE}" \
    "backups/${ARCHIVE}" --quiet 2>&1 | tail -1

# 同时上传为 latest（覆盖）
cp "${BACKUP_DIR}/${ARCHIVE}" "${BACKUP_DIR}/${LATEST}"
huggingface-cli upload "${HF_BACKUP_DATASET}" \
    "${BACKUP_DIR}/${LATEST}" \
    "backups/${LATEST}" --quiet 2>&1 | tail -1

# 清理旧备份：保留最近 N 个
echo "[hf-backup] Pruning old backups (keep=${HF_BACKUP_KEEP_COUNT})..."
OLD_BACKUPS=$(huggingface-cli repo-files "${HF_BACKUP_DATASET}" 2>/dev/null \
    | grep "^backups/instatic-backup-" \
    | sort -r \
    | tail -n +$((HF_BACKUP_KEEP_COUNT + 1)))

if [ -n "${OLD_BACKUPS}" ]; then
    echo "${OLD_BACKUPS}" | while read -r f; do
        echo "  Deleting: ${f}"
        huggingface-cli delete "${HF_BACKUP_DATASET}" "${f}" --yes 2>/dev/null || true
    done
fi

# 清理临时文件
rm -rf "${BACKUP_DIR}"

echo "[hf-backup] $(date -u '+%Y-%m-%d %H:%M:%S UTC') Backup complete ✓"
