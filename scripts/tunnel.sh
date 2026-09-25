#!/bin/sh
# Forwards another machine's Herdr socket to this Mac, for a remote instance
# (see "Several machines" in the README).
#
#   scripts/tunnel.sh key <slug>                               create the forward-only SSH key
#   scripts/tunnel.sh install <slug> <user@host> <remote-socket>  install and start the launchd tunnel
#   scripts/tunnel.sh uninstall <slug>
#   scripts/tunnel.sh status <slug>
#
# The local socket is ~/.config/agency/<slug>.sock; use it as the instance's `socket`.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LA="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
CMD="${1:-}"; SLUG="${2:-}"
case "$SLUG" in ""|*[!a-z0-9-]*) echo "usage: $0 key|install|uninstall|status <slug: a-z 0-9 ->" >&2; exit 2;; esac
LABEL="io.github.herdr-voice-mcp.tunnel.$SLUG"
KEY="$HOME/.ssh/agency-$SLUG"
case "$CMD" in
  key)
    [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "agency-mcp forward-only ($SLUG)" -f "$KEY"
    echo "Add this line to ~/.ssh/authorized_keys of the Herdr user on the remote machine:"
    echo "restrict,port-forwarding,command=\"/usr/bin/false\" $(cat "$KEY.pub")";;
  install)
    TARGET="${3:?ssh target missing}"; REMOTE="${4:?remote socket path missing}"
    [ -f "$KEY" ] || { echo "no key $KEY; run: $0 key $SLUG" >&2; exit 1; }
    mkdir -p "$LA" "$HOME/Library/Logs" "$HOME/.config/agency"
    sed -e "s|__SLUG__|$SLUG|g" -e "s|__HOME__|$HOME|g" -e "s|__TARGET__|$TARGET|g" -e "s|__REMOTE_SOCKET__|$REMOTE|g" \
      "$HERE/launchd/io.github.herdr-voice-mcp.tunnel.plist" > "$LA/$LABEL.plist"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$LA/$LABEL.plist"
    echo "tunnel $SLUG: $HOME/.config/agency/$SLUG.sock -> $TARGET:$REMOTE";;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$LA/$LABEL.plist" "$HOME/.config/agency/$SLUG.sock"
    echo "removed";;
  status)
    launchctl list | grep "$LABEL" || echo "not loaded"
    ls -l "$HOME/.config/agency/$SLUG.sock" 2>/dev/null || echo "no socket";;
  *) echo "usage: $0 key|install|uninstall|status <slug> ..." >&2; exit 2;;
esac
