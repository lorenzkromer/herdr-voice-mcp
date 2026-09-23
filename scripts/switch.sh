#!/bin/sh
# Kill switch: closes public reachability of the MCP server without touching Herdr.
#   scripts/switch.sh off     → server answers 503 to everything
#   scripts/switch.sh on      → normal operation
#   scripts/switch.sh status
set -e
FLAG="${AGENCY_KILL_SWITCH:-$HOME/.config/agency/disabled}"
case "${1:-status}" in
  off) mkdir -p "$(dirname "$FLAG")"; date > "$FLAG"; echo "agency OFF ($FLAG)";;
  on)  rm -f "$FLAG"; echo "agency ON";;
  status) if [ -e "$FLAG" ]; then echo "agency OFF since $(cat "$FLAG")"; else echo "agency ON"; fi;;
  *) echo "usage: $0 on|off|status" >&2; exit 2;;
esac
