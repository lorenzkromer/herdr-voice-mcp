#!/bin/sh
# Publish the local MCP port through Tailscale Funnel.
#   scripts/funnel.sh on|off|status
# Requires Tailscale running, HTTPS certificates enabled for the tailnet and the
# "funnel" node attribute granted in the tailnet policy (see README).
set -e
PORT="${AGENCY_PORT:-8791}"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
case "${1:-status}" in
  on)  "$TS" funnel --bg "$PORT";;
  off) "$TS" funnel --https=443 off;;
  status) "$TS" funnel status;;
  *) echo "usage: $0 on|off|status" >&2; exit 2;;
esac
