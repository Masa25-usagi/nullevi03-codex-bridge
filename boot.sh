#!/bin/sh
set -u
bridge_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file=${ENV_FILE:-"$bridge_dir/.env"}
if [ -f "$env_file" ]; then
  set -a
  . "$env_file"
  set +a
fi
: "${TELEGRAM_BOT_TOKEN:?Configure TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_CHAT_ID:?Configure TELEGRAM_CHAT_ID}"
bridge_child=
bridge_stop() {
  if [ -n "$bridge_child" ]; then kill "$bridge_child" 2>/dev/null || true; fi
  exit 0
}
trap bridge_stop INT TERM HUP
while :; do
  "${NODE_BIN:-node}" "$bridge_dir/src/bridge.mjs" &
  bridge_child=$!
  wait "$bridge_child" || true
  bridge_child=
  sleep "${RESTART_DELAY_SECONDS:-5}"
done
