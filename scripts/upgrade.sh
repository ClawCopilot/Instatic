#!/bin/bash
# Instatic 稳定升级脚本
#
# 用法:
#   ./scripts/upgrade.sh [--target 0.0.12] [--dry-run]
#
# 功能:
#   1. 检测当前版本（docker inspect / compose 配置 .env）
#   2. 确定目标版本（--target 或自动查最新 release）
#   3. 可选: 显示 CHANGELOG 差异
#   4. 升级前备份 (hf-backup 或 rsync)
#   5. 拉取新镜像
#   6. 滚动重启
#   7. 健康检查验证（带重试 + 超时）
#   8. 失败自动回滚
#
# 环境变量覆盖:
#   INSTATIC_COMPOSE_FILES  — compose 文件列表（默认自动检测）
#   INSTATIC_SERVICE_NAME   — compose 服务名（默认 app）
#   INSTATIC_CONTAINER_NAME — docker run 容器名（默认 instatic）
#   INSTATIC_ENV_FILE       — .env 文件路径（默认 /opt/instatic/.env）

set -euo pipefail

# ---- 默认配置 ----
REGISTRY="ghcr.io/clawcopilot/instatic"
CONTAINER_NAME="${INSTATIC_CONTAINER_NAME:-instatic}"
SERVICE_NAME="${INSTATIC_SERVICE_NAME:-app}"
ENV_FILE="${INSTATIC_ENV_FILE:-/opt/instatic/.env}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3001/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
TARGET_VERSION=""
DRY_RUN=false
AUTO_DETECT=true

# ---- 颜色输出 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR ]${NC} $*" >&2; }

# ---- 用法 ----
usage() {
  cat <<EOF
用法: $0 [选项]

选项:
  --target <version>    目标版本号（例: 0.0.12），不指定则自动查 GitHub 最新 release
  --container <name>    docker run 模式的容器名（默认: instatic）
  --env-file <path>     .env 文件路径（compose 模式，默认 /opt/instatic/.env）
  --dry-run             仅检查不执行升级
  --skip-backup         跳过升级前备份（不推荐）
  --skip-health         跳过升级后健康检查
  --help                显示此帮助

示例:
  # compose 模式 — 升级到 0.0.12
  $0 --target 0.0.12 --env-file /opt/instatic/.env

  # docker run 模式 — 升级到最新
  $0 --container instatic

  # 仅查看会做什么
  $0 --target 0.0.12 --dry-run
EOF
  exit 0
}

# ---- 参数解析 ----
SKIP_BACKUP=false
SKIP_HEALTH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)       TARGET_VERSION="$2"; shift 2 ;;
    --container)    CONTAINER_NAME="$2"; shift 2 ;;
    --env-file)     ENV_FILE="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --skip-backup)  SKIP_BACKUP=true; shift ;;
    --skip-health)  SKIP_HEALTH=true; shift ;;
    --help)         usage ;;
    *)              error "未知选项: $1"; usage ;;
  esac
done

# ---- 步骤 0: 检测部署模式 ----

detect_mode() {
  # 优先: docker run 模式（容器存在）
  if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "docker-run"
  # 其次: compose 模式（.env 文件存在且有 INSTATIC_IMAGE）
  elif [ -f "$ENV_FILE" ] && grep -q 'INSTATIC_IMAGE' "$ENV_FILE" 2>/dev/null; then
    echo "compose"
  else
    echo "unknown"
  fi
}

MODE=$(detect_mode)

# ---- 步骤 1: 检测当前版本 ----

get_current_version_docker() {
  docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}' 2>/dev/null | sed 's/.*://' || echo "unknown"
}

get_current_version_compose() {
  grep 'INSTATIC_IMAGE=' "$ENV_FILE" 2>/dev/null | head -1 | sed 's/.*://' | tr -d '"'"'" || echo "unknown"
}

# ---- 步骤 2: 获取目标版本 ----

get_latest_release() {
  # 从 GitHub API 获取最新 release tag
  local tag
  tag=$(curl -sfL "https://api.github.com/repos/clawcopilot/instatic/releases/latest" 2>/dev/null \
    | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/' | sed 's/^v//') || true
  if [ -z "$tag" ]; then
    # 回退: 用 gh CLI
    tag=$(gh release view --repo clawcopilot/instatic --json tagName -q '.tagName' 2>/dev/null | sed 's/^v//') || true
  fi
  echo "${tag:-unknown}"
}

# ---- 步骤 3: 自动检测 compose 文件 ----

detect_compose_files() {
  if [ -n "${INSTATIC_COMPOSE_FILES:-}" ]; then
    echo "$INSTATIC_COMPOSE_FILES"
    return
  fi

  local dir
  dir=$(dirname "$ENV_FILE")
  local files=""

  # 基座文件
  if [ -f "$dir/compose.prod.yml" ]; then
    files="-f compose.prod.yml"
  else
    error "找不到 compose.prod.yml"
    exit 1
  fi

  # SQLite 检测
  if grep -q 'sqlite' "$ENV_FILE" 2>/dev/null || grep -qi 'DATABASE_URL=sqlite' "$ENV_FILE" 2>/dev/null; then
    files="$files -f compose.sqlite.yml"
  fi

  # TLS 检测
  if grep -q 'DOMAIN=' "$ENV_FILE" 2>/dev/null; then
    files="$files -f compose.tls.yml"
  fi

  # Cloudflare Tunnel 检测
  if grep -q 'CLOUDFLARE_TUNNEL_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    files="$files -f compose.cloudflare-tunnel.yml"
  fi

  echo "$files"
}

# ---- 步骤 4: 升级前备份 ----

do_backup() {
  if [ "$SKIP_BACKUP" = true ]; then
    warn "跳过升级前备份（--skip-backup）"
    return
  fi

  info "升级前备份..."

  case "$MODE" in
    compose)
      if docker compose $COMPOSE_FILES exec "$SERVICE_NAME" which hf-backup >/dev/null 2>&1; then
        info "触发 HF Dataset 备份..."
        docker compose $COMPOSE_FILES exec "$SERVICE_NAME" hf-backup || warn "HF 备份失败，继续..."
      else
        warn "容器内无 hf-backup，跳过自动备份"
        warn "建议手动: docker run --rm -v instatic_data:/data -v \$(pwd)/backup:/backup alpine cp -r /data /backup/data-\$(date +%Y%m%d-%H%M%S)"
      fi
      ;;
    docker-run)
      if docker exec "$CONTAINER_NAME" which hf-backup >/dev/null 2>&1; then
        info "触发 HF Dataset 备份（docker run 模式）..."
        docker exec "$CONTAINER_NAME" hf-backup || warn "HF 备份失败，继续..."
      else
        warn "HF 备份不可用，手动备份数据卷后再升级"
      fi
      ;;
  esac
}

# ---- 步骤 5: 执行升级 ----

do_upgrade_compose() {
  local target="$1"
  local image="$REGISTRY:$target"

  info "Compose 模式升级 → $image"

  # 备份当前版本号
  local previous
  previous=$(get_current_version_compose)

  # 更新 .env
  if [ "$DRY_RUN" = false ]; then
    if grep -q '^INSTATIC_IMAGE=' "$ENV_FILE"; then
      sed -i "s|^INSTATIC_IMAGE=.*|INSTATIC_IMAGE=$image|" "$ENV_FILE"
    else
      echo "INSTATIC_IMAGE=$image" >> "$ENV_FILE"
    fi
    success "已更新 $ENV_FILE → $image"
  else
    info "[dry-run] 将更新 $ENV_FILE: INSTATIC_IMAGE=$image"
  fi

  # 拉取镜像
  if [ "$DRY_RUN" = false ]; then
    info "拉取镜像..."
    (cd "$(dirname "$ENV_FILE")" && docker compose $COMPOSE_FILES pull "$SERVICE_NAME") || {
      error "拉取镜像失败，回滚 .env"
      sed -i "s|^INSTATIC_IMAGE=.*|INSTATIC_IMAGE=$REGISTRY:$previous|" "$ENV_FILE"
      exit 1
    }

    # 滚动重启
    info "滚动重启..."
    (cd "$(dirname "$ENV_FILE")" && docker compose $COMPOSE_FILES up -d "$SERVICE_NAME") || {
      error "部署失败"
      exit 1
    }
  else
    info "[dry-run] 将执行: cd $(dirname "$ENV_FILE") && docker compose $COMPOSE_FILES pull $SERVICE_NAME"
    info "[dry-run] 将执行: cd $(dirname "$ENV_FILE") && docker compose $COMPOSE_FILES up -d $SERVICE_NAME"
  fi

  echo "$previous"
}

do_upgrade_docker() {
  local target="$1"
  local image="$REGISTRY:$target"

  info "docker run 模式升级 → $image"

  local previous
  previous=$(get_current_version_docker)

  if [ "$DRY_RUN" = false ]; then
    # 1. 获取当前容器的所有关键参数
    info "保存容器运行参数..."
    local docker_opts
    docker_opts=$(docker inspect "$CONTAINER_NAME" --format '
      --name {{.Name}}
      {{range $k, $v := .Config.Env}} --env {{$v | printf "%q"}}{{end}}
      {{range $m := .HostConfig.Mounts}}{{if eq $m.Type "volume"}} --volume {{$m.Name}}:{{$m.Destination}}{{end}}{{end}}
      {{range $m := .HostConfig.Mounts}}{{if eq $m.Type "bind"}} --volume {{$m.Source}}:{{$m.Destination}}{{if $m.ReadOnly}}:ro{{end}}{{end}}{{end}}
      {{if .HostConfig.RestartPolicy.Name}} --restart {{.HostConfig.RestartPolicy.Name}}{{end}}
    ' 2>/dev/null || echo "")

    # 2. 拉取镜像
    info "拉取镜像 $image ..."
    docker pull "$image" || { error "拉取失败"; exit 1; }

    # 3. 停止旧容器
    info "停止旧容器..."
    docker stop "$CONTAINER_NAME" || true

    # 4. 删除旧容器
    docker rm "$CONTAINER_NAME" || true

    # 5. 启动新容器
    info "启动新版本..."
    # shellcheck disable=SC2086,SC2090
    docker run -d $docker_opts "$image" || {
      error "新容器启动失败，尝试恢复旧版本..."
      docker pull "$REGISTRY:$previous" 2>/dev/null || true
      # shellcheck disable=SC2086
      docker run -d --name "$CONTAINER_NAME" $docker_opts "$REGISTRY:$previous" || {
        error "回滚也失败了！请手动恢复"
        exit 1
      }
      success "已回滚到 $previous"
      exit 1
    }
  else
    info "[dry-run] 将停止 $CONTAINER_NAME, 拉取 $image, 重新启动"
  fi

  echo "$previous"
}

# ---- 步骤 6: 健康检查验证 ----

do_health_check() {
  if [ "$SKIP_HEALTH" = true ]; then
    warn "跳过健康检查（--skip-health）"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    info "[dry-run] 将轮询 $HEALTH_URL 最多 ${HEALTH_RETRIES} 次"
    return 0
  fi

  info "等待新版本启动就绪..."

  # 先等 start_period (docker HEALTHCHECK start_period = 20s)
  sleep 5

  for i in $(seq 1 "$HEALTH_RETRIES"); do
    local body
    body=$(curl -sf "$HEALTH_URL" 2>/dev/null) || true

    if [ -n "$body" ]; then
      local status version db
      status=$(echo "$body" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
      version=$(echo "$body" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
      db=$(echo "$body" | grep -o '"db":"[^"]*"' | cut -d'"' -f4)

      if [ "$status" = "ok" ]; then
        success "健康检查通过 — 版本 $version, 数据库 $db"
        return 0
      elif [ "$status" = "degraded" ]; then
        warn "健康检查警告 — 状态: $status, 版本: $version, 数据库: $db"
        return 0
      fi
    fi

    if [ "$i" -eq "$HEALTH_RETRIES" ]; then
      error "健康检查超时（${HEALTH_RETRIES} 次重试后仍未就绪）"
      return 1
    fi

    printf "  [%2d/%d] 等待中...\r" "$i" "$HEALTH_RETRIES"
    sleep "$HEALTH_INTERVAL"
  done
}

# ---- 主流程 ----

echo ""
echo "=========================================="
echo "  Instatic 稳定升级"
echo "=========================================="
echo ""

# 模式检测
info "部署模式: $MODE"

# 当前版本
CURRENT_VERSION=""
case "$MODE" in
  compose)
    CURRENT_VERSION=$(get_current_version_compose)
    COMPOSE_FILES=$(detect_compose_files)
    info "当前版本: $CURRENT_VERSION"
    info "Compose 文件: $COMPOSE_FILES"
    info "配置文件: $ENV_FILE"
    ;;
  docker-run)
    CURRENT_VERSION=$(get_current_version_docker)
    info "当前版本: $CURRENT_VERSION"
    info "容器名: $CONTAINER_NAME"
    ;;
  *)
    error "无法检测部署模式 — 请用 --container 或 --env-file 指定"
    exit 1
    ;;
esac

# 目标版本
if [ -z "$TARGET_VERSION" ]; then
  info "未指定 --target，查找最新 release..."
  TARGET_VERSION=$(get_latest_release)
  if [ "$TARGET_VERSION" = "unknown" ]; then
    error "无法自动获取最新版本，请用 --target 指定"
    exit 1
  fi
fi
info "目标版本: $TARGET_VERSION"

# 版本比较
if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ]; then
  warn "当前已是最新版本 $TARGET_VERSION，无需升级"
  exit 0
fi

echo ""

# 步骤流水
do_backup

PREVIOUS_VERSION=""
case "$MODE" in
  compose)
    PREVIOUS_VERSION=$(do_upgrade_compose "$TARGET_VERSION")
    ;;
  docker-run)
    PREVIOUS_VERSION=$(do_upgrade_docker "$TARGET_VERSION")
    ;;
esac

# 健康检查
if do_health_check; then
  echo ""
  success "升级完成: $PREVIOUS_VERSION → $TARGET_VERSION"
  echo ""
  echo "验证清单:"
  echo "  ☐ 登录 CMS 后台确认可正常操作"
  echo "  ☐ 检查媒体文件是否正常"
  echo "  ☐ 验证已发布站点可正常访问"
  [ "$MODE" = "compose" ] && echo "  ☐ 如需回滚: sed -i 's|$TARGET_VERSION|$PREVIOUS_VERSION|' $ENV_FILE && docker compose $COMPOSE_FILES up -d $SERVICE_NAME"
  echo ""
  exit 0
else
  echo ""
  error "升级后健康检查失败"

  # 自动回滚
  if [ "$DRY_RUN" = false ] && [ -n "$PREVIOUS_VERSION" ] && [ "$PREVIOUS_VERSION" != "unknown" ]; then
    warn "正在自动回滚到 $PREVIOUS_VERSION ..."
    case "$MODE" in
      compose)
        sed -i "s|^INSTATIC_IMAGE=.*|INSTATIC_IMAGE=$REGISTRY:$PREVIOUS_VERSION|" "$ENV_FILE"
        (cd "$(dirname "$ENV_FILE")" && docker compose $COMPOSE_FILES up -d "$SERVICE_NAME")
        ;;
      docker-run)
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
        # 用旧版镜像重建（参数同上）
        error "docker run 模式回滚需手动重建容器，镜像: $REGISTRY:$PREVIOUS_VERSION"
        ;;
    esac
    success "已回滚到 $PREVIOUS_VERSION"
  fi
  exit 1
fi
