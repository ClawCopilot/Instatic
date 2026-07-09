#!/bin/bash
# Instatic Hugging Face Dataset 备份脚本
# 将指定路径（文件或目录）打包上传到 Hugging Face Dataset
#
# 环境变量:
#   HF_TOKEN               - Hugging Face 访问令牌（必填）
#   HF_BACKUP_DATASET      - HF Dataset 仓库名，格式 user/dataset-name（必填）
#   HF_BACKUP_KEEP_COUNT   - 保留备份数量（默认 7）
#   HF_BACKUP_SOURCE_PATHS - 备份源路径，逗号分隔
#                            默认: /app/data,/app/uploads
#                              /app/data    = SQLite 数据库 (cms.db + WAL)
#                              /app/uploads = 媒体文件 + 插件 + 发布的站点
#                            支持目录和文件，含空格路径无需额外处理。
#                            路径名含逗号时用 \, 转义。
#                            例如: /app/data,/app/uploads,/app/my\ config
#
# 用法:
#   hf-backup.sh           - 手动执行一次备份

set -e

# ---- 解析逗号分隔的路径列表，支持 \, 转义逗号 ----
# 输出每行一个路径（标准输出），由调用方 while read 读取
parse_path_list() {
    local input="$1"
    # 1. 临时用不可打印字符 \x1E 替代 \,
    local escaped
    escaped=$(echo "$input" | sed 's/\\,/\x1E/g')
    # 2. 按逗号切分
    local IFS=','
    local parts=()
    read -ra parts <<< "$escaped"
    # 3. 逐个还原 \x1E → , 并 trim
    for part in "${parts[@]}"; do
        part=$(echo "$part" | sed 's/\x1E/,/g')
        part=$(echo "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [ -n "$part" ] && echo "$part"
    done
}

HF_TOKEN="${HF_TOKEN:-}"
HF_BACKUP_DATASET="${HF_BACKUP_DATASET:-}"
HF_BACKUP_KEEP_COUNT="${HF_BACKUP_KEEP_COUNT:-7}"
HF_BACKUP_SOURCE_PATHS="${HF_BACKUP_SOURCE_PATHS:-/app/data,/app/uploads}"

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

# 收集有效路径
SOURCE_ARGS=(-C /app)
VALID_PATHS=()
while IFS= read -r p; do
    [ -z "$p" ] && continue
    if [ -e "$p" ]; then
        rel="${p#/app/}"
        SOURCE_ARGS+=("$rel")
        VALID_PATHS+=("$p")
        echo "[hf-backup]   + ${p}"
    else
        echo "[hf-backup]   ! ${p} (not found — skipped)"
    fi
done < <(parse_path_list "${HF_BACKUP_SOURCE_PATHS}")

if [ ${#VALID_PATHS[@]} -eq 0 ]; then
    echo "[hf-backup] No valid source paths found — skipping"
    exit 0
fi

echo "[hf-backup] Archiving ${#VALID_PATHS[@]} path(s)..."
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
