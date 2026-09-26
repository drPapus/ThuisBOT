#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM=":99"
VNC_PORT="5900"
NOVNC_PORT="6080"

RUNTIME_DIR="/tmp/thuis-mobile-login"

echo "=== ThuisBOT mobile login shutdown ==="

# Cloudflare tunnel
if pgrep -f "cloudflared tunnel --url http://127.0.0.1:${NOVNC_PORT}" >/dev/null; then
    echo "Stopping Cloudflare tunnel..."
    pkill -f "cloudflared tunnel --url http://127.0.0.1:${NOVNC_PORT}" || true
else
    echo "Cloudflare tunnel already stopped."
fi

# noVNC / websockify
if pgrep -f "websockify.*127.0.0.1:${NOVNC_PORT}.*127.0.0.1:${VNC_PORT}" >/dev/null; then
    echo "Stopping noVNC..."
    pkill -f "websockify.*127.0.0.1:${NOVNC_PORT}.*127.0.0.1:${VNC_PORT}" || true
else
    echo "noVNC already stopped."
fi

# x11vnc
if pgrep -f "x11vnc.*-rfbport ${VNC_PORT}" >/dev/null; then
    echo "Stopping x11vnc..."
    pkill -f "x11vnc.*-rfbport ${VNC_PORT}" || true
else
    echo "x11vnc already stopped."
fi

# Remove stale runtime PID information.
rm -f "$RUNTIME_DIR/cloudflared.pid"

echo
echo "Mobile login external access stopped."
echo "Xvfb ${DISPLAY_NUM} was left running."
