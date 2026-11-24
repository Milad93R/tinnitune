#!/usr/bin/env bash
# Preview the build and capture views, e.g. scripts/quick-shots.sh "setup 1440x900 test-results/setup.jpg"
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
    for spec in "$@"; do
      read -r -a args <<<"$spec"
      node scripts/quick-shot.mjs "${args[@]}"
    done
    exit
  fi
  sleep 0.2
done
cat "$preview_log"
exit 1
