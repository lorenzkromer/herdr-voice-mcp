#!/bin/sh
# Installs the two launchd agents (MCP server + notifier) for the current user.
#   scripts/install-launchd.sh install|uninstall|restart|status
# Builds first (npm run build). Logs go to ~/Library/Logs/herdr-voice-*.log.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LA="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
SERVER=io.github.herdr-voice-mcp.server
NOTIFY=io.github.herdr-voice-mcp.notify
mkdir -p "$LA" "$HOME/Library/Logs"
render() { sed -e "s|__NODE__|$NODE|g" -e "s|__ROOT__|$HERE|g" -e "s|__HOME__|$HOME|g" "$HERE/launchd/$1.plist" > "$LA/$1.plist"; }
case "${1:-install}" in
  install)
    (cd "$HERE" && npm run build >/dev/null)
    for L in $SERVER $NOTIFY; do
      render "$L"
      launchctl bootout "$DOMAIN/$L" 2>/dev/null || true
      launchctl bootstrap "$DOMAIN" "$LA/$L.plist"
    done
    echo "installed; logs: ~/Library/Logs/herdr-voice-server.log, ~/Library/Logs/herdr-voice-notify.log";;
  uninstall)
    for L in $SERVER $NOTIFY; do
      launchctl bootout "$DOMAIN/$L" 2>/dev/null || true
      rm -f "$LA/$L.plist"
    done
    echo "removed";;
  restart)
    (cd "$HERE" && npm run build >/dev/null)
    launchctl kickstart -k "$DOMAIN/$SERVER"
    launchctl kickstart -k "$DOMAIN/$NOTIFY"
    echo "restarted";;
  status)
    launchctl list | grep herdr-voice-mcp || echo "not loaded";;
  *) echo "usage: $0 install|uninstall|restart|status" >&2; exit 2;;
esac
