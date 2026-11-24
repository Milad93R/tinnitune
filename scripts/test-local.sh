#!/usr/bin/env bash
# Preview the existing production build for one command and always reap the preview process.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .cache
preview_log=$(mktemp .cache/preview-XXXXXX)
./node_modules/.bin/vite preview --host 127.0.0.1 --port 6805 --strictPort >"$preview_log" 2>&1 &
preview_pid=$!
cleanup() {
  kill "$preview_pid" 2>/dev/null || true
  wait "$preview_pid" 2>/dev/null || true
  rm -f "$preview_log"
}
trap cleanup EXIT
for _ in $(seq 1 50); do
  if ! kill -0 "$preview_pid" 2>/dev/null; then
    cat "$preview_log"
    exit 1
  fi
  if grep -q 'Local:' "$preview_log" && curl -sf http://127.0.0.1:6805/ >/dev/null; then
    BASE_URL=http://127.0.0.1:6805 node "${1:-tests/e2e.mjs}"
    exit
  fi
  sleep 0.2
done
cat "$preview_log"
exit 1
