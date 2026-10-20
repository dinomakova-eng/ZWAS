#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  trap - EXIT INT TERM
  printf '\nStopping ZETDC Wind Assessment System...\n'

  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  wait "$FRONTEND_PID" "$BACKEND_PID" 2>/dev/null || true
  printf 'System stopped.\n'
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local pid="$3"
  local attempt

  for attempt in {1..40}; do
    if curl --silent --fail --max-time 2 "$url" >/dev/null 2>&1; then
      printf '%s is ready: %s\n' "$name" "$url"
      return 0
    fi

    if ! kill -0 "$pid" 2>/dev/null; then
      fail "$name stopped before it became ready."
    fi

    sleep 0.5
  done

  fail "$name did not become ready at $url."
}

command -v python3 >/dev/null 2>&1 || fail "python3 is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."

if [[ ! -x "$BACKEND_DIR/.venv/bin/uvicorn" ]]; then
  printf 'Preparing the backend environment...\n'
  python3 -m venv "$BACKEND_DIR/.venv"
  "$BACKEND_DIR/.venv/bin/python" -m pip install -r "$BACKEND_DIR/requirements.txt"
fi

if [[ ! -x "$FRONTEND_DIR/node_modules/.bin/vite" ]]; then
  printf 'Installing frontend dependencies...\n'
  (cd "$FRONTEND_DIR" && npm install)
fi

trap cleanup EXIT INT TERM

printf 'Starting the backend API...\n'
(
  cd "$BACKEND_DIR"
  exec .venv/bin/uvicorn app.main:app \
    --reload \
    --host "$BACKEND_HOST" \
    --port "$BACKEND_PORT"
) &
BACKEND_PID=$!

printf 'Starting the frontend...\n'
(
  cd "$FRONTEND_DIR"
  exec node_modules/.bin/vite \
    --host "$FRONTEND_HOST" \
    --port "$FRONTEND_PORT"
) &
FRONTEND_PID=$!

wait_for_url "Backend API" "http://127.0.0.1:$BACKEND_PORT/health" "$BACKEND_PID"
wait_for_url "Web system" "http://127.0.0.1:$FRONTEND_PORT/" "$FRONTEND_PID"

printf '\nZETDC Wind Assessment System is running.\n'
printf 'Web system: http://localhost:%s\n' "$FRONTEND_PORT"
printf 'Backend API: http://localhost:%s\n' "$BACKEND_PORT"
printf 'Press Ctrl+C to stop both services.\n\n'

wait "$BACKEND_PID" "$FRONTEND_PID"
