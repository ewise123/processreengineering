#!/usr/bin/env bash
# Local dev runner for POET (FastAPI backend + Next.js frontend + Postgres via Docker).
#
# Subcommands:
#   start    bring everything up (default if no arg)
#   stop     stop frontend, backend, and the postgres container
#   status   show whether each piece is running
#   logs     tail backend.log and frontend.log
#   clean    stop everything AND drop the postgres volume (wipes data)
#
# State lives in ./.run (logs + pid files). Edit backend/.env to add API keys.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RUN_DIR="$ROOT/.run"
BACKEND_DIR="$ROOT/backend"
VENV="$BACKEND_DIR/.venv"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"
BACKEND_PID="$RUN_DIR/backend.pid"
FRONTEND_PID="$RUN_DIR/frontend.pid"

BACKEND_PORT=8000
FRONTEND_PORT=3000
POSTGRES_PORT=5433

# --- helpers -----------------------------------------------------------------

c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

die() { c_red "ERROR: $*"; exit 1; }

# Pick a working docker command. Inside WSL the Linux `docker` package is often
# missing while `docker.exe` (from Docker Desktop) is on PATH and works fine.
detect_docker() {
  if command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1; then
    echo "docker"
  elif command -v docker.exe >/dev/null 2>&1 && docker.exe version >/dev/null 2>&1; then
    echo "docker.exe"
  else
    return 1
  fi
}

pid_alive() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] || return 1
  local pid; pid=$(cat "$pidfile" 2>/dev/null || true)
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

wait_for_port() {
  local host="$1" port="$2" name="$3" timeout="${4:-60}"
  local start=$SECONDS
  while ! (echo > "/dev/tcp/$host/$port") 2>/dev/null; do
    if (( SECONDS - start > timeout )); then
      die "$name did not become reachable on $host:$port within ${timeout}s"
    fi
    sleep 1
  done
}

# --- setup steps -------------------------------------------------------------

ensure_env_files() {
  if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    c_dim "  wrote backend/.env from .env.example (API keys are blank)"
  fi
  if [[ ! -f "$ROOT/.env.local" ]]; then
    cp "$ROOT/.env.local.example" "$ROOT/.env.local"
    c_dim "  wrote .env.local from .env.local.example"
  fi
}

start_postgres() {
  local docker_cmd; docker_cmd=$(detect_docker) || die "Docker not found. Install Docker Desktop and enable WSL integration, or install docker-ce in WSL."
  c_blue "[1/5] Starting Postgres ($docker_cmd compose up -d) ..."
  $docker_cmd compose up -d
  wait_for_port localhost "$POSTGRES_PORT" "Postgres" 60
  c_green "      Postgres is up on localhost:$POSTGRES_PORT"
}

setup_backend_venv() {
  c_blue "[2/5] Setting up backend Python venv ..."
  if [[ ! -f "$VENV/bin/activate" ]]; then
    # Reset any half-built venv from a previous failed bootstrap.
    if [[ -d "$VENV" ]]; then rm -rf "$VENV"; fi
    # Prefer the stdlib venv, but on Debian/Ubuntu the ensurepip module ships
    # in a separate package (python3-venv) that isn't always installed. Fall
    # back to `virtualenv` (user-installed via pip) when that's the case.
    if ! python3 -m venv "$VENV" 2>/dev/null; then
      if [[ -d "$VENV" ]]; then rm -rf "$VENV"; fi
      if command -v virtualenv >/dev/null 2>&1; then
        virtualenv "$VENV"
      elif [[ -x "$HOME/.local/bin/virtualenv" ]]; then
        "$HOME/.local/bin/virtualenv" "$VENV"
      else
        die "python3-venv is not installed and 'virtualenv' is unavailable. Install one of:
  sudo apt install -y python3.12-venv
  pip install --user --break-system-packages virtualenv"
      fi
    fi
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  pip install --quiet --upgrade pip wheel
  pip install --quiet -r "$BACKEND_DIR/requirements.txt"
  c_green "      Python deps installed (.venv ready)"
}

run_migrations_and_seed() {
  c_blue "[3/5] Running Alembic migrations and seeding dev user ..."
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  cd "$BACKEND_DIR"
  set -a; source "$BACKEND_DIR/.env"; set +a
  alembic upgrade head
  python -m scripts.seed_dev || true
  cd "$ROOT"
  c_green "      Schema is current; dev@local user seeded"
}

start_backend() {
  c_blue "[4/5] Starting FastAPI backend on :$BACKEND_PORT ..."
  if pid_alive "$BACKEND_PID"; then
    c_dim "      backend already running (pid $(cat "$BACKEND_PID"))"
    return
  fi
  mkdir -p "$RUN_DIR"
  (
    # shellcheck disable=SC1091
    source "$VENV/bin/activate"
    cd "$BACKEND_DIR"
    set -a; source "$BACKEND_DIR/.env"; set +a
    exec uvicorn main:app --host 0.0.0.0 --port "$BACKEND_PORT" --reload
  ) >"$BACKEND_LOG" 2>&1 &
  echo $! > "$BACKEND_PID"
  wait_for_port localhost "$BACKEND_PORT" "Backend" 30
  c_green "      Backend up (pid $(cat "$BACKEND_PID")) — logs: $BACKEND_LOG"
}

start_frontend() {
  c_blue "[5/5] Starting Next.js frontend on :$FRONTEND_PORT ..."
  if pid_alive "$FRONTEND_PID"; then
    c_dim "      frontend already running (pid $(cat "$FRONTEND_PID"))"
    return
  fi
  if [[ ! -d "$ROOT/node_modules" ]]; then
    c_dim "      node_modules missing — running npm install (this takes a minute) ..."
    npm install --no-audit --no-fund --loglevel=error
  fi
  mkdir -p "$RUN_DIR"
  (
    cd "$ROOT"
    exec npm run dev -- --port "$FRONTEND_PORT"
  ) >"$FRONTEND_LOG" 2>&1 &
  echo $! > "$FRONTEND_PID"
  wait_for_port localhost "$FRONTEND_PORT" "Frontend" 90
  c_green "      Frontend up (pid $(cat "$FRONTEND_PID")) — logs: $FRONTEND_LOG"
}

# --- subcommands -------------------------------------------------------------

cmd_start() {
  mkdir -p "$RUN_DIR"
  ensure_env_files
  start_postgres
  setup_backend_venv
  run_migrations_and_seed
  start_backend
  start_frontend
  echo
  c_green "POET is running."
  echo "  Frontend:   http://localhost:$FRONTEND_PORT"
  echo "  Backend:    http://localhost:$BACKEND_PORT  (health: /health, docs: /docs)"
  echo "  Postgres:   localhost:$POSTGRES_PORT  (user/pass/db: poet)"
  echo "  Stop with:  $0 stop"
  echo "  Tail logs:  $0 logs"
  if ! grep -q '^ANTHROPIC_API_KEY=..' "$BACKEND_DIR/.env"; then
    echo
    c_dim "Tip: ANTHROPIC_API_KEY / OPENAI_API_KEY are blank in backend/.env — AI flows (claims, conflicts, process generation, chat) will fail until you add keys and restart the backend."
  fi
}

cmd_stop() {
  if pid_alive "$FRONTEND_PID"; then
    c_blue "Stopping frontend (pid $(cat "$FRONTEND_PID")) ..."
    pkill -P "$(cat "$FRONTEND_PID")" 2>/dev/null || true
    kill "$(cat "$FRONTEND_PID")" 2>/dev/null || true
    rm -f "$FRONTEND_PID"
  fi
  if pid_alive "$BACKEND_PID"; then
    c_blue "Stopping backend (pid $(cat "$BACKEND_PID")) ..."
    pkill -P "$(cat "$BACKEND_PID")" 2>/dev/null || true
    kill "$(cat "$BACKEND_PID")" 2>/dev/null || true
    rm -f "$BACKEND_PID"
  fi
  local docker_cmd; docker_cmd=$(detect_docker) || true
  if [[ -n "$docker_cmd" ]]; then
    c_blue "Stopping Postgres container ..."
    $docker_cmd compose down
  fi
  c_green "Stopped."
}

cmd_status() {
  printf '%-12s ' "frontend:"
  if pid_alive "$FRONTEND_PID"; then c_green "running (pid $(cat "$FRONTEND_PID"))"; else c_red "stopped"; fi
  printf '%-12s ' "backend:"
  if pid_alive "$BACKEND_PID"; then c_green "running (pid $(cat "$BACKEND_PID"))"; else c_red "stopped"; fi
  printf '%-12s ' "postgres:"
  if (echo > "/dev/tcp/localhost/$POSTGRES_PORT") 2>/dev/null; then c_green "running (localhost:$POSTGRES_PORT)"; else c_red "stopped"; fi
}

cmd_logs() {
  mkdir -p "$RUN_DIR"
  touch "$BACKEND_LOG" "$FRONTEND_LOG"
  tail -n 50 -f "$BACKEND_LOG" "$FRONTEND_LOG"
}

cmd_clean() {
  cmd_stop
  local docker_cmd; docker_cmd=$(detect_docker) || return
  c_blue "Removing Postgres volume (data will be lost) ..."
  $docker_cmd compose down -v
  c_green "Clean."
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   cmd_logs ;;
  clean)  cmd_clean ;;
  *) die "Unknown subcommand: $1 (use: start | stop | status | logs | clean)" ;;
esac
