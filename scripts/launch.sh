#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
QQ_BIN="$PROJECT_DIR/data/runtime/qq/qq"
NODE_BIN="$(command -v "${CHAT_ASSISTANT_NODE:-node}" || true)"
if [[ -z "$NODE_BIN" ]]; then
  message='QQ 聊天助手打开失败（NODE_MISSING）。找不到 Node.js，请检查启动环境。QQ 不会被关闭或重启。'
  printf '%s\n' "$message" >&2
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v zenity >/dev/null; then
    zenity --error --title='QQ 聊天助手' --no-markup --width=480 --text="$message" >/dev/null 2>&1 &
  fi
  exit 2
fi
if pgrep -x qq >/dev/null; then
  exec "$NODE_BIN" "$PROJECT_DIR/scripts/activate.cjs"
fi
if [[ ! -x "$QQ_BIN" ]]; then
  exec "$NODE_BIN" "$PROJECT_DIR/scripts/activate.cjs" --runtime-missing
fi
export LITELOADERQQNT_PROFILE="$PROJECT_DIR/data/liteloader-profile"
export CHAT_ASSISTANT_NODE="$NODE_BIN"
export CHAT_ASSISTANT_OPEN_ON_START=1
ulimit -c 0
printf '0' > /proc/self/coredump_filter || true
exec "$QQ_BIN" "$@"
