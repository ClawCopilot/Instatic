#!/bin/bash
# Instatic HA 主备切换脚本
# 用于在主节点宕机时将备用节点提升为活动节点，或将活动节点降级为备用。
#
# 环境变量（从 start.sh 继承）:
#   INSTATIC_ROLE           - 当前角色（active / standby），脚本执行后更新
#   HF_TOKEN                - Hugging Face Token
#   HF_BACKUP_DATASET       - HF Dataset 仓库名
#   HF_RESTORE_ON_START     - 备用节点启动时是否自动恢复
#   INSTATIC_HEALTH_URL     - Instatic 健康检查地址（默认 http://127.0.0.1:3001/health）
#
# 用法:
#   Promote（备用 → 活动）:
#     ha-switch.sh promote
#
#   Demote（活动 → 备用）:
#     ha-switch.sh demote
#
#   Force promote (skip remote backup, use local data):
#     ha-switch.sh promote --force

set -e

INSTATIC_HEALTH_URL="${INSTATIC_HEALTH_URL:-http://127.0.0.1:3001/health}"
ROLE_FILE="/app/data/.ha-role"
ACTION="${1:-}"
FORCE="${2:-}"

# ── 辅助函数 ──────────────────────────────────────────────────────

log() { echo "[ha-switch] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

get_role() {
    if [ -f "${ROLE_FILE}" ]; then
        cat "${ROLE_FILE}"
    else
        echo "unknown"
    fi
}

set_role() {
    mkdir -p "$(dirname "${ROLE_FILE}")"
    echo "$1" > "${ROLE_FILE}"
    log "Role set to: $1"
}

check_instatic_health() {
    curl -sf --max-time 5 "${INSTATIC_HEALTH_URL}" > /dev/null 2>&1
}

do_backup() {
    if [ -n "${HF_TOKEN}" ] && [ -n "${HF_BACKUP_DATASET}" ]; then
        if ! command -v hf-backup >/dev/null 2>&1; then
            log "ERROR: hf-backup not found. Is the container built correctly?"
            return 1
        fi
        log "Running final backup to HF Dataset..."
        hf-backup 2>&1 | while IFS= read -r line; do
            log "[backup] ${line}"
        done
        if [ ${PIPESTATUS[0]} -eq 0 ]; then
            log "Backup completed ✓"
            return 0
        else
            log "Backup FAILED"
            return 1
        fi
    else
        log "HF backup not configured — skipping"
        return 0
    fi
}

do_restore() {
    if [ -n "${HF_TOKEN}" ] && [ -n "${HF_BACKUP_DATASET}" ]; then
        if ! command -v hf-restore >/dev/null 2>&1; then
            log "ERROR: hf-restore not found. Is the container built correctly?"
            return 1
        fi
        log "Restoring data from HF Dataset..."
        hf-restore 2>&1 | while IFS= read -r line; do
            log "[restore] ${line}"
        done
        if [ ${PIPESTATUS[0]} -eq 0 ]; then
            log "Restore completed ✓"
            return 0
        else
            log "Restore FAILED"
            return 1
        fi
    else
        log "HF restore not configured — skipping"
        return 0
    fi
}

# ── Promote: 备用 → 活动 ──────────────────────────────────────────

cmd_promote() {
    local current_role
    current_role=$(get_role)

    log "=== PROMOTE: ${current_role} → active ==="

    # 检查 Instatic 是否运行
    if ! check_instatic_health; then
        log "WARNING: Instatic is not responding at ${INSTATIC_HEALTH_URL}"
        log "The service may need to be started first (docker compose up -d)"
        if [ "${FORCE}" != "--force" ]; then
            log "Use --force to promote anyway (skip restore, keep current local data)"
            exit 1
        fi
    fi

    # 如果不是 --force，先从远端拉取最新备份确保数据最新
    if [ "${FORCE}" != "--force" ]; then
        log "Fetching latest data from HF..."
        if ! do_restore; then
            log "ERROR: Failed to restore latest backup"
            log "Use --force to skip restore and keep current local data"
            exit 1
        fi
    else
        log "--force: skipping restore, using current local data"
    fi

    set_role "active"
    log "=========================================="
    log "  Node promoted to ACTIVE"
    log "  - HF backups: ENABLED"
    log "  - Read/write: ENABLED"
    log "  - Restart required for changes to take effect"
    log "=========================================="
    log ""
    log "To apply changes, restart the container:"
    log "  docker compose restart app"
    log "  or: docker restart <container-name>"
}

# ── Demote: 活动 → 备用 ──────────────────────────────────────────

cmd_demote() {
    local current_role
    current_role=$(get_role)

    log "=== DEMOTE: ${current_role} → standby ==="

    # 先做最后一次备份
    if check_instatic_health; then
        log "Instatic is running — performing final backup..."
        if ! do_backup; then
            log "WARNING: Final backup failed — data may be lost"
        fi
    else
        log "Instatic is not responding — cannot run final backup"
        log "Continuing with demotion anyway..."
    fi

    set_role "standby"
    log "=========================================="
    log "  Node demoted to STANDBY"
    log "  - HF backups: DISABLED"
    log "  - Read/write: local only (stale data)"
    log "  - On next restart: auto-restore from HF"
    log "=========================================="
    log ""
    log "To apply changes, restart the container:"
    log "  docker compose restart app"
    log "  or: docker restart <container-name>"
}

# ── Status ────────────────────────────────────────────────────────

cmd_status() {
    local current_role
    current_role=$(get_role)

    echo "HA Node Status:"
    echo "  Role:         ${current_role}"
    echo "  Role file:    ${ROLE_FILE}"
    echo "  Health URL:   ${INSTATIC_HEALTH_URL}"

    if check_instatic_health; then
        echo "  Instatic:     online ✓"
    else
        echo "  Instatic:     offline ✗"
    fi

    echo ""
    if [ -n "${HF_TOKEN}" ] && [ -n "${HF_BACKUP_DATASET}" ]; then
        echo "  HF Backup:    ${HF_BACKUP_DATASET}"
        echo "  HF Restore:   ${HF_RESTORE_ON_START:-false}"
    else
        echo "  HF Backup:    not configured"
    fi
}

# ── CLI ───────────────────────────────────────────────────────────

case "${ACTION}" in
    promote)
        cmd_promote
        ;;
    demote)
        cmd_demote
        ;;
    status)
        cmd_status
        ;;
    *)
        echo "Usage: ha-switch.sh <promote|demote|status> [--force]"
        echo ""
        echo "Commands:"
        echo "  promote    Promote standby to active (pulls latest backup first)"
        echo "  promote --force  Promote immediately (skip backup pull, use local data)"
        echo "  demote     Demote active to standby (runs final backup first)"
        echo "  status     Show current HA role and health status"
        exit 1
        ;;
esac
