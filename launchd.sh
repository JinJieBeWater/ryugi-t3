#!/bin/sh
# Installs the launchd agent that keeps `ryugi-t3 serve` running; `launchd.sh uninstall` removes it.
set -eu
label=dev.ryugi-t3.serve
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
launchctl bootout "$domain/$label" 2>/dev/null || true
if [ "${1-}" = uninstall ]; then
  rm -f "$plist"
  exit 0
fi
entry=$(/usr/bin/readlink -f "$0")
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
# AbandonProcessGroup keeps a hub that one of serve's watchers started alive across serve's restarts.
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>${entry%/*}/ryugi-t3</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ryugi-t3.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ryugi-t3.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$domain" "$plist"
