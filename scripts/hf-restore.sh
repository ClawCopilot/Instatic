#!/bin/bash
# Instatic Hugging Face Dataset 恢复脚本
# 从 Hugging Face Dataset 下载最新备份并恢复到 /app/data 和 /app/uploads
#
# 环境变量:
#   HF_TOKEN               - Hugging Face 访问令牌（必填）
#   HF_BACKUP_DATASET      - HF Dataset 仓库名，格式 user/dataset-name（必填）
#   HF_RESTORE_ON_START    - 设为 "true" 时启动时自动恢复（默认 false）
#
# 用法:
#   hf-restore.sh          - 手动执行恢复

set -e

HF_TOKEN="${HF_TOKEN:-}"
HF_BACKUP_DATASET="${HF_BACKUP_DATASET:-}"
HF_BACKUP_SOURCE_DIRS="${HF_BACKUP_SOURCE_DIRS:-/app/data /app/uploads}"

if [ -z "${HF_TOKEN}" ] || [ -z "${HF_BACKUP_DATASET}" ]; then
    echo "[hf-restore] HF_TOKEN or HF_BACKUP_DATASET not configured — skipping"
    exit 0
fi

export HF_TOKEN
RESTORE_DIR="/tmp/instatic-hf-restore"
LATEST="latest-backup.tar.gz"

echo "[hf-restore] $(date -u '+%Y-%m-%d %H:%M:%S UTC') Starting restore..."

# 检查远端是否有备份
echo "[hf-restore] Checking for latest backup on ${HF_BACKUP_DATASET}..."
if ! huggingface-cli repo-files "${HF_BACKUP_DATASET}" 2>/dev/null | grep -q "backups/${LATEST}"; then
    echo "[hf-restore] No backup found — skipping restore"
    exit 0
fi

mkdir -p "${RESTORE_DIR}"

# 下载最新备份
echo "[hf-restore] Downloading ${LATEST}..."
huggingface-cli download "${HF_BACKUP_DATASET}" \
    "backups/${LATEST}" \
    --local-dir "${RESTORE_DIR}" --quiet

# 解压并恢复到对应目录
echo "[hf-restore] Extracting archive..."
tar -xzf "${RESTORE_DIR}/${LATEST}" -C "${RESTORE_DIR}"

# 根据 HF_BACKUP_SOURCE_DIRS 逐个恢复
for d in ${HF_BACKUP_SOURCE_DIRS}; do
    dir_rel="${d#/app/}"           # /app/data → data
    dir_name="$(basename "$d")"    # /foo/bar → bar
    if [ -d "${RESTORE_DIR}/${dir_rel}" ]; then
        echo "[hf-restore] Restoring ${d}..."
        # 先备份现有数据（防止覆盖）
        if [ -d "${d}" ] && [ "$(ls -A "${d}" 2>/dev/null)" ]; then
            cp -r "${d}" "${d}.bak.$(date +%s)" 2>/dev/null || true
        fi
        mkdir -p "${d}"
        cp -r "${RESTORE_DIR}/${dir_rel}"/* "${d}"/ 2>/dev/null || true
    fi
done

# 清理
rm -rf "${RESTORE_DIR}"

echo "[hf-restore] $(date -u '+%Y-%m-%d %H:%M:%S UTC') Restore complete ✓"
