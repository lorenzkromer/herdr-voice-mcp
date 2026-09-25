#!/bin/sh
# SSH socket forwards for several Herdr instances (see "Several machines" in the README).
#
#   scripts/tunnel.sh key <slug>
#       create the dedicated key and print the line for the remote authorized_keys
#   scripts/tunnel.sh install <slug> <user@host> <remote-herdr-socket>
#       forward: the remote Herdr socket appears here as ~/.config/agency/<slug>.sock
#       (the server on this machine controls the remote instance)
#   scripts/tunnel.sh install-reverse <slug> <user@host> <remote-socket-path> [local-herdr-socket]
#       reverse: this machine's Herdr socket appears on the remote side at <remote-socket-path>
#       (a server on the remote machine controls this instance)
#   scripts/tunnel.sh uninstall <slug> | uninstall-reverse <slug>
#   scripts/tunnel.sh status <slug>
#
# The remote sshd needs "StreamLocalBindUnlink yes" for reverse forwards, so a stale socket
# file does not block reconnects.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LA="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
CMD="${1:-}"; SLUG="${2:-}"
case "$SLUG" in ""|*[!a-z0-9-]*) echo "usage: $0 key|install|install-reverse|uninstall|uninstall-reverse|status <slug: a-z 0-9 -> ..." >&2; exit 2;; esac
KEY="$HOME/.ssh/agency-$SLUG"
render() { # label flag spec target logname
  mkdir -p "$LA" "$HOME/Library/Logs" "$HOME/.config/agency"
  sed -e "s|__LABEL__|$1|g" -e "s|__FLAG__|$2|g" -e "s|__SPEC__|$3|g" -e "s|__TARGET__|$4|g" -e "s|__LOGNAME__|$5|g" \
      -e "s|__SLUG__|$SLUG|g" -e "s|__HOME__|$HOME|g" \
    "$HERE/launchd/io.github.herdr-voice-mcp.tunnel.plist" > "$LA/$1.plist"
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$LA/$1.plist"
}
need_key() { [ -f "$KEY" ] || { echo "no key $KEY; run: $0 key $SLUG" >&2; exit 1; }; }
case "$CMD" in
  key)
    [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "agency-mcp forward-only ($SLUG)" -f "$KEY"
    echo "Add this line to ~/.ssh/authorized_keys on the remote machine:"
    echo "restrict,port-forwarding,command=\"/usr/bin/false\" $(cat "$KEY.pub")";;
  install)
    TARGET="${3:?ssh target missing}"; REMOTE="${4:?remote socket path missing}"; need_key
    render "io.github.herdr-voice-mcp.tunnel.$SLUG" -L "$HOME/.config/agency/$SLUG.sock:$REMOTE" "$TARGET" "tunnel-$SLUG"
    echo "tunnel $SLUG: $HOME/.config/agency/$SLUG.sock -> $TARGET:$REMOTE";;
  install-reverse)
    TARGET="${3:?ssh target missing}"; REMOTE="${4:?remote socket path missing}"; LOCAL="${5:-$HOME/.config/herdr/herdr.sock}"; need_key
    render "io.github.herdr-voice-mcp.rtunnel.$SLUG" -R "$REMOTE:$LOCAL" "$TARGET" "rtunnel-$SLUG"
    echo "reverse tunnel $SLUG: $TARGET:$REMOTE -> $LOCAL";;
  uninstall)
    launchctl bootout "$DOMAIN/io.github.herdr-voice-mcp.tunnel.$SLUG" 2>/dev/null || true
    rm -f "$LA/io.github.herdr-voice-mcp.tunnel.$SLUG.plist" "$HOME/.config/agency/$SLUG.sock"
    echo "removed";;
  uninstall-reverse)
    launchctl bootout "$DOMAIN/io.github.herdr-voice-mcp.rtunnel.$SLUG" 2>/dev/null || true
    rm -f "$LA/io.github.herdr-voice-mcp.rtunnel.$SLUG.plist"
    echo "removed";;
  status)
    launchctl list | grep -E "io.github.herdr-voice-mcp.r?tunnel.$SLUG" || echo "not loaded"
    ls -l "$HOME/.config/agency/$SLUG.sock" 2>/dev/null || true;;
  *) echo "usage: $0 key|install|install-reverse|uninstall|uninstall-reverse|status <slug> ..." >&2; exit 2;;
esac
