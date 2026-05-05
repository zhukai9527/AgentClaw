#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AGENTCLAW_REPO_URL:-https://github.com/vorojar/AgentClaw.git}"
DEFAULT_DIR="${AGENTCLAW_HOME:-$HOME/agentclaw}"
PNPM_VERSION="9.15.0"

info() {
  printf '\033[1;34m[AgentClaw]\033[0m %s\n' "$*" >&2
}

warn() {
  printf '\033[1;33m[AgentClaw]\033[0m %s\n' "$*" >&2
}

fail() {
  printf '\033[1;31m[AgentClaw]\033[0m %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

tty_read() {
  local prompt="$1"
  local default="${2:-}"
  local value

  if [ ! -r /dev/tty ]; then
    [ -n "$default" ] && printf '%s\n' "$default" && return 0
    fail "当前没有交互式终端，无法读取必填项。请在终端中运行安装命令。"
  fi

  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >/dev/tty
  else
    printf '%s: ' "$prompt" >/dev/tty
  fi
  IFS= read -r value </dev/tty
  if [ -z "$value" ]; then
    printf '%s\n' "$default"
  else
    printf '%s\n' "$value"
  fi
}

tty_secret() {
  local prompt="$1"
  local value

  if [ ! -r /dev/tty ]; then
    fail "当前没有交互式终端，无法读取 API Key。请在终端中运行安装命令。"
  fi

  printf '%s: ' "$prompt" >/dev/tty
  IFS= read -r -s value </dev/tty
  printf '\n' >/dev/tty
  printf '%s\n' "$value"
}

require_nonempty() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    fail "$name 不能为空。"
  fi
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    fail "需要 root 权限执行：$*。请安装 sudo 或用 root 用户运行。"
  fi
}

is_termux() {
  [ -n "${PREFIX:-}" ] && printf '%s' "$PREFIX" | grep -q 'com.termux'
}

node_major() {
  if ! have node; then
    printf '0\n'
    return
  fi
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0\n'
}

install_linux_node() {
  if [ "$(node_major)" -ge 20 ]; then
    return
  fi

  info "安装 Node.js 20。"
  if have apt-get; then
    run_root apt-get update
    run_root apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash -
    run_root apt-get install -y nodejs
  elif have dnf; then
    run_root dnf install -y nodejs npm
  elif have pacman; then
    run_root pacman -Sy --needed --noconfirm nodejs npm
  else
    fail "未识别的 Linux 包管理器，请先安装 Node.js >= 20 后重试。"
  fi
}

install_dependencies() {
  info "检查并安装基础依赖。"

  if is_termux; then
    pkg update -y
    pkg install -y git curl nodejs-lts ffmpeg python make clang
  elif [ "$(uname -s)" = "Darwin" ]; then
    if ! have brew; then
      fail "macOS 需要 Homebrew。请先安装 Homebrew 后重试：https://brew.sh"
    fi
    brew install git curl node ffmpeg python || true
  elif [ "$(uname -s)" = "Linux" ]; then
    if have apt-get; then
      run_root apt-get update
      run_root apt-get install -y git curl ffmpeg python3 make g++ ca-certificates
    elif have dnf; then
      run_root dnf install -y git curl ffmpeg python3 make gcc-c++ ca-certificates
    elif have pacman; then
      run_root pacman -Sy --needed --noconfirm git curl ffmpeg python make gcc ca-certificates
    else
      fail "未识别的 Linux 包管理器，请先安装 git/curl/ffmpeg/python3/make/g++。"
    fi
    install_linux_node
  else
    fail "install.sh 当前支持 Linux、macOS 和 Termux。Windows 请使用 WSL 或桌面安装包。"
  fi

  if [ "$(node_major)" -lt 20 ]; then
    fail "Node.js 版本必须 >= 20，当前版本：$(node --version 2>/dev/null || printf '未安装')"
  fi

  if have corepack; then
    corepack enable
    corepack prepare "pnpm@${PNPM_VERSION}" --activate
  elif have npm; then
    npm install -g "pnpm@${PNPM_VERSION}"
  else
    fail "未找到 npm，无法安装 pnpm。"
  fi
}

prepare_source() {
  local target_dir="$1"

  if [ -f package.json ] && grep -q '"name": "agentclaw"' package.json; then
    info "检测到当前目录已经是 AgentClaw 仓库。"
    printf '%s\n' "$(pwd)"
    return
  fi

  if [ -d "$target_dir/.git" ]; then
    info "更新已有仓库：$target_dir"
    git -C "$target_dir" pull --ff-only
  elif [ -e "$target_dir" ]; then
    fail "目标目录已存在但不是 Git 仓库：$target_dir"
  else
    info "克隆 AgentClaw 到：$target_dir"
    git clone "$REPO_URL" "$target_dir"
  fi
  printf '%s\n' "$target_dir"
}

generate_api_key() {
  if have openssl; then
    openssl rand -hex 24
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '-' </proc/sys/kernel/random/uuid
  else
    printf 'agentclaw-%s-%s\n' "$(date +%s)" "$RANDOM"
  fi
}

write_env() {
  local app_dir="$1"
  local provider choice api_key model base_url gateway_key

  info "配置模型。"
  printf '\n请选择模型提供商：\n' >/dev/tty
  printf '  1) Anthropic Claude\n' >/dev/tty
  printf '  2) OpenAI / OpenAI-Compatible\n' >/dev/tty
  printf '  3) Google Gemini\n' >/dev/tty
  printf '  4) Ollama 本地模型\n' >/dev/tty
  choice="$(tty_read '输入序号' '2')"

  gateway_key="$(generate_api_key)"
  {
    printf '# AgentClaw 环境变量，由 scripts/install.sh 生成。\n'
    printf 'API_KEY=%s\n' "$gateway_key"
    printf 'PORT=3100\n'
    printf 'HOST=0.0.0.0\n'
    printf '\n'
    printf '# 默认不启用浏览器自动化；需要自行安装 Chrome/Chromium 后改为 true。\n'
    printf 'AGENTCLAW_ENABLE_BROWSER_CDP=false\n'
    printf '\n'
  } >"$app_dir/.env.new"

  case "$choice" in
    1)
      provider="Anthropic"
      api_key="$(tty_secret '请输入 ANTHROPIC_API_KEY')"
      require_nonempty "ANTHROPIC_API_KEY" "$api_key"
      model="$(tty_read '请输入 Claude 模型名' 'claude-sonnet-4-5')"
      {
        printf 'ANTHROPIC_API_KEY=%s\n' "$api_key"
        printf 'ANTHROPIC_MODEL=%s\n' "$model"
        printf 'ACTIVE_PROVIDER=claude\n'
      } >>"$app_dir/.env.new"
      ;;
    2)
      provider="OpenAI-Compatible"
      api_key="$(tty_secret '请输入 OPENAI_API_KEY')"
      require_nonempty "OPENAI_API_KEY" "$api_key"
      base_url="$(tty_read '请输入 OPENAI_BASE_URL' 'https://api.openai.com/v1')"
      model="$(tty_read '请输入模型名' 'gpt-4o-mini')"
      {
        printf 'OPENAI_API_KEY=%s\n' "$api_key"
        printf 'OPENAI_BASE_URL=%s\n' "$base_url"
        printf 'OPENAI_MODEL=%s\n' "$model"
        printf 'ACTIVE_PROVIDER=openai\n'
      } >>"$app_dir/.env.new"
      ;;
    3)
      provider="Gemini"
      api_key="$(tty_secret '请输入 GEMINI_API_KEY')"
      require_nonempty "GEMINI_API_KEY" "$api_key"
      model="$(tty_read '请输入 Gemini 模型名' 'gemini-2.5-flash')"
      {
        printf 'GEMINI_API_KEY=%s\n' "$api_key"
        printf 'GEMINI_MODEL=%s\n' "$model"
        printf 'ACTIVE_PROVIDER=gemini\n'
      } >>"$app_dir/.env.new"
      ;;
    4)
      provider="Ollama"
      base_url="$(tty_read '请输入 Ollama OpenAI 兼容地址' 'http://localhost:11434/v1')"
      model="$(tty_read '请输入 Ollama 模型名' 'llama3')"
      {
        printf 'OLLAMA_BASE_URL=%s\n' "$base_url"
        printf 'OLLAMA_MODEL=%s\n' "$model"
      } >>"$app_dir/.env.new"
      ;;
    *)
      fail "无效选择：$choice"
      ;;
  esac

  if [ -f "$app_dir/.env" ]; then
    local backup="$app_dir/.env.bak.$(date +%Y%m%d%H%M%S)"
    cp "$app_dir/.env" "$backup"
    warn "已备份旧 .env：$backup"
  fi
  mv "$app_dir/.env.new" "$app_dir/.env"
  info "已写入 $provider 配置。Web 登录 API_KEY：$gateway_key"
}

build_app() {
  local app_dir="$1"

  info "安装 Node 依赖。"
  (cd "$app_dir" && pnpm install --frozen-lockfile)

  info "构建 AgentClaw。"
  (cd "$app_dir" && npm run build)
}

start_app() {
  local app_dir="$1"
  local pid_file="$app_dir/data/agentclaw.pid"
  local log_file="$app_dir/logs/agentclaw.log"

  mkdir -p "$app_dir/data" "$app_dir/logs"

  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    warn "检测到旧进程，正在停止：$(cat "$pid_file")"
    kill "$(cat "$pid_file")" 2>/dev/null || true
    sleep 2
  fi

  info "启动 AgentClaw。日志：$log_file"
  (cd "$app_dir" && nohup npm run start >"$log_file" 2>&1 & echo $! >"$pid_file")

  info "等待健康检查。"
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3100/health >/dev/null 2>&1; then
      info "启动成功：PID $(cat "$pid_file")"
      info "访问地址：http://127.0.0.1:3100"
      return
    fi
    sleep 1
  done

  warn "健康检查未通过，请查看日志：$log_file"
  tail -n 80 "$log_file" || true
  exit 1
}

main() {
  local target_dir app_dir

  printf '\nAgentClaw 一键安装器\n\n' >/dev/tty
  target_dir="$(tty_read '安装目录' "$DEFAULT_DIR")"

  install_dependencies
  app_dir="$(prepare_source "$target_dir")"
  write_env "$app_dir"
  build_app "$app_dir"
  start_app "$app_dir"
}

main "$@"
