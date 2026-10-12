#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
QQ_BIN="$PROJECT_DIR/data/runtime/qq/qq"
if [[ ! -x "$QQ_BIN" ]]; then
  echo "The verified local QQ runtime is missing. See docs/usage_CN.md." >&2
  exit 1
fi
if pgrep -x qq >/dev/null; then
  exec "${CHAT_ASSISTANT_NODE:-$(command -v node)}" "$PROJECT_DIR/scripts/activate.cjs"
fi
export LITELOADERQQNT_PROFILE="$PROJECT_DIR/data/liteloader-profile"
export CHAT_ASSISTANT_NODE="${CHAT_ASSISTANT_NODE:-$(command -v node)}"
ulimit -c 0
printf '0' > /proc/self/coredump_filter || true
exec "$QQ_BIN" "$@"
