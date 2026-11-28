#!/bin/sh
# Jalanin DLMM Web (Portfolio + Auto-Exit + Flip + Auto Re-entry + Background PICK + Telegram 2-way bot)
# 24/7 di Mac mini lewat launchd: nyala sendiri tiap login, restart sendiri kalau crash, Mac nggak sleep (caffeinate).
#   sh dlmm_terminal/install_web.sh            pasang / update
#   sh dlmm_terminal/install_web.sh uninstall  copot
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SRC/.." && pwd)"
LABEL="com.bojjifomo.dlmm-web"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$(command -v python3 || echo /usr/bin/python3)"
LOG="$SRC/data/web_daemon.log"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "$1" = "uninstall" ]; then
  rm -f "$PLIST"
  echo "DLMM Web daemon dicopot dari launchd."
  exit 0
fi

mkdir -p "$SRC/data" "$HOME/Library/LaunchAgents"
NODE_DIR="$(dirname "$(command -v node || echo /opt/homebrew/bin/node)")"
CLAUDE_DIR="$HOME/.local/bin"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$PY</string><string>-u</string><string>-m</string><string>dlmm_terminal</string><string>web</string><string>--host</string><string>0.0.0.0</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$CLAUDE_DIR:$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL

for i in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    echo "✅ DLMM Web daemon jalan 24/7 lewat launchd ($LABEL)."
    echo "Buka:    http://localhost:8891  (atau lewat Tailscale dari HP)"
    echo "Log:     tail -f $LOG"
    echo "Restart: launchctl kickstart -k gui/\$(id -u)/$LABEL"
    echo "Copot:   sh dlmm_terminal/install_web.sh uninstall"
    exit 0
  fi
  sleep 2
done
echo "Gagal start. Coba: launchctl bootstrap gui/\$(id -u) $PLIST" >&2
exit 1
