#!/bin/bash
# Instatic Hugging Face Dataset 恢复脚本
# 从 Hugging Face Dataset 下载最新备份并恢复指定路径（文件或目录）
#
# 环境变量:
#   HF_TOKEN               - Hugging Face 访问令牌（必填）
#   HF_BACKUP_DATASET      - HF Dataset 仓库名，格式 user/dataset-name（必填）
#   HF_BACKUP_SOURCE_PATHS - 备份源路径，逗号分隔（默认 /app/data,/app/uploads）
#                            支持 \, 转义逗号，含空格路径无需额外处理
#   HF_RESTORE_ON_START    - 设为 "true" 时启动时自动恢复（默认 false）
#
# 用法:
#   hf-restore.sh          - 手动执行恢复

set -e

# ---- 解析逗号分隔的路径列表，支持 \, 转义逗号 ----
parse_path_list() {
    local input="$1"
    local escaped
    escaped=$(echo "$input" | sed 's/\\,/\x1E/g')
    local IFS=','
    local parts=()
    read -ra parts <<< "$escaped"
    for part in "${parts[@]}"; do
        part=$(echo "$part" | sed 's/\x1E/,/g')
        part=$(echo "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [ -n "$part" ] && echo "$part"
    done
}

HF_TOKEN="${HF_TOKEN:-}"
HF_BACKUP_DATASET="${HF_BACKUP_DATASET:-}"
HF_BACKUP_SOURCE_PATHS="${HF_BACKUP_SOURCE_PATHS:-/app/data,/app/uploads}"

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

# 解压到临时目录（归档内路径是 data、uploads 等 /app 相对路径）
echo "[hf-restore] Extracting archive..."
tar -xzf "${RESTORE_DIR}/${LATEST}" -C "${RESTORE_DIR}"

# 根据 HF_BACKUP_SOURCE_PATHS 逐个恢复（文件或目录）
while IFS= read -r p; do
    [ -z "$p" ] && continue

    rel="${p#/app/}"   # /app/data/foo → data/foo
    src="${RESTORE_DIR}/${rel}"

    if [ -f "$src" ]; then
        echo "[hf-restore] Restoring file: ${p}"
        if [ -f "$p" ]; then
            cp "$p" "${p}.bak.$(date +%s)" 2>/dev/null || {
                echo "[hf-restore] WARNING: Failed to backup ${p} — aborting restore for this file"
                continue
            }
        fi
        mkdir -p "$(dirname "$p")"
        cp "$src" "$p"
    elif [ -d "$src" ]; then
        echo "[hf-restore] Restoring dir : ${p}"
        if [ -d "$p" ] && [ "$(ls -A "$p" 2>/dev/null)" ]; then
            cp -r "$p" "${p}.bak.$(date +%s)" 2>/dev/null || {
                echo "[hf-restore] WARNING: Failed to backup ${p} — aborting restore for this directory"
                continue
            }
        fi
        mkdir -p "$p"
        cp -r "${src}"/* "$p"/ 2>/dev/null || true
    else
        echo "[hf-restore]   ! ${p} (not in backup — skipped)"
    fi
done < <(parse_path_list "${HF_BACKUP_SOURCE_PATHS}")

# 清理
rm -rf "${RESTORE_DIR}"

echo "[hf-restore] $(date -u '+%Y-%m-%d %H:%M:%S UTC') Restore complete ✓"
