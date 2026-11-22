#!/bin/bash
# Double-click di Finder (Mac mini): jalanin DLMM Web dan buka di browser.
# Biarin jendela Terminal ini kebuka selama dipakai. caffeinate = Mac nggak sleep.
# Dari HP / MacBook lewat Tailscale: http://<nama-mac-mini>:<port>  (port = DLMM_WEB_PORT di .env, default 8891)
cd "$(dirname "$0")/.." || exit 1
# Moving over from an older copy (Capstone1/dlmm_terminal or dlmm-terminal): take its .env and data/
# (settings, watchlist, auto exit, flip, logs) once, so nothing has to be typed or copied by hand.
# Never overwrites what is already here.
OLD=""
for d in "$HOME/Projects/src/dlmm-terminal" "$HOME/Capstone1/dlmm_terminal" "$HOME/Projects/src/Capstone1/dlmm_terminal" \
         /Volumes/*/work/Capstone1/dlmm_terminal /Volumes/*/Capstone1/dlmm_terminal "$HOME/work/Capstone1/dlmm_terminal"; do
  if [ -f "$d/.env" ] && [ "$(cd "$d" && pwd -P)" != "$(cd dlmm_terminal && pwd -P)" ]; then OLD="$d"; break; fi
done
if [ -n "$OLD" ] && [ ! -f dlmm_terminal/.env ]; then
  cp "$OLD/.env" dlmm_terminal/.env && chmod 600 dlmm_terminal/.env
  echo "Pakai .env dari versi lama: $OLD"
fi
if [ -n "$OLD" ] && [ -d "$OLD/data" ] && [ ! -f dlmm_terminal/data/.migrated ]; then
  mkdir -p dlmm_terminal/data
  cp -Rn "$OLD/data/." dlmm_terminal/data/ 2>/dev/null
  echo "$OLD" > dlmm_terminal/data/.migrated
  echo "Settings, watchlist, auto exit, dan log dari versi lama ikut dipindah (yang udah ada di sini nggak ditimpa)."
fi
# First run: make dlmm_terminal/.env from the template and open it in TextEdit to fill in.
if [ ! -f dlmm_terminal/.env ]; then
  cp dlmm_terminal/.env.example dlmm_terminal/.env
  chmod 600 dlmm_terminal/.env
  open -e dlmm_terminal/.env
  echo "dlmm_terminal/.env dibuat dan dibuka di TextEdit. Isi, save (Cmd+S), lalu tekan Enter di sini."
  read -r _
fi
# Node + the Meteora SDK (needed to sign and send): installed here once if missing.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum ada: jalanin 'brew install node' (atau install LTS dari https://nodejs.org), lalu double-click file ini lagi."
  read -r -p "Enter buat tutup." _; exit 1
fi
if [ ! -d dlmm_terminal/executor/node_modules/@meteora-ag/dlmm ]; then
  echo "Install Meteora SDK (sekali aja, ±1 menit)…"
  (cd dlmm_terminal/executor && npm install --no-audit --no-fund) || { read -r -p "npm install gagal (lihat error di atas). Enter buat tutup." _; exit 1; }
fi
# 🔎 Riset narasi runs Claude Code (your Claude subscription). Just a hint when it is missing; nothing is installed here.
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  echo "Info: Claude Code belum ada (buat 🔎 Riset narasi). Install: curl -fsSL https://claude.ai/install.sh | bash, lalu jalanin 'claude' sekali buat login."
fi
PORT=$(grep -E '^DLMM_WEB_PORT=[0-9]+' dlmm_terminal/.env | tail -1 | cut -d= -f2 | tr -d '[:space:]')
PORT=${PORT:-8891}
URL="http://localhost:$PORT"
# Port already taken? If it is DLMM Web itself, just open it; anything else: say which app and how to move.
PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ -n "$PID" ]; then
  CMD=$(ps -p "$PID" -o command= 2>/dev/null)
  # Any DLMM Web: "python3 -m dlmm_terminal web" (this one) or an older copy run as a folder,
  # e.g. "python …/Projects/src/dlmm-terminal web" or "…/Capstone1/dlmm_terminal web".
  if echo "$CMD" | grep -Eq 'dlmm[-_]terminal[^ ]* web( |$)'; then
    RUNDIR=$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    HERE=$(pwd -P)
    SAME=0
    if echo "$CMD" | grep -q -- "-m dlmm_terminal web" && [ -n "$RUNDIR" ] && [ "$(cd "$RUNDIR" 2>/dev/null && pwd -P)" = "$HERE" ]; then SAME=1; fi
    if [ "$SAME" = 0 ]; then
      RUNDIR=${RUNDIR:-?}
      echo "$CMD" | grep -q -- "-m dlmm_terminal" || RUNDIR=$(echo "$CMD" | grep -Eo '/[^ ]*dlmm[-_]terminal[^ ]*' | tail -1)
      # An older copy (another folder) is serving: its code is not this one. Offer to stop it.
      echo ""
      echo "DLMM Web versi lama lagi jalan dari: $RUNDIR"
      read -r -p "Matiin yang lama dan jalanin versi ini? (Enter = ya, ketik n = batal) " ans
      if [ "$ans" = "n" ]; then open "$URL"; exit 0; fi
      kill "$PID" 2>/dev/null; sleep 2
      kill -0 "$PID" 2>/dev/null && { kill -9 "$PID" 2>/dev/null; sleep 1; }
    else
      echo "DLMM Web udah jalan di $URL (jendela Terminal lain). Buka browser aja."
      open "$URL"
      exit 0
    fi
  else
    echo ""
    echo "Port $PORT kepake app lain: $CMD"
    echo "Ganti port: buka dlmm_terminal/.env, isi misalnya DLMM_WEB_PORT=8892, save, lalu double-click file ini lagi."
    read -r -p "Enter buat tutup." _
    exit 1
  fi
fi
HOST=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
echo "DLMM Web: $URL  ·  dari HP / MacBook (Tailscale): http://$HOST:$PORT  ·  biarin jendela ini kebuka."
(sleep 2; open "$URL") &
exec caffeinate -i python3 -m dlmm_terminal web --host 0.0.0.0 --port "$PORT"
