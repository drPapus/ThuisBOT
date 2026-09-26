#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM=":99"
VNC_PORT="5900"
NOVNC_PORT="6080"

RUNTIME_DIR="/tmp/thuis-mobile-login"
mkdir -p "$RUNTIME_DIR"

echo "=== ThuisBOT mobile login ==="

# Xvfb
if pgrep -f "Xvfb ${DISPLAY_NUM}" >/dev/null; then
    echo "Xvfb already running."
else
    echo "Starting Xvfb..."
    Xvfb "$DISPLAY_NUM" -screen 0 1280x800x24 \
        >"$RUNTIME_DIR/xvfb.log" 2>&1 &
fi

sleep 1

if ! DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
    echo "ERROR: DISPLAY ${DISPLAY_NUM} is not available."
    exit 1
fi

echo "DISPLAY ${DISPLAY_NUM}: OK"

# x11vnc
if pgrep -f "x11vnc.*-rfbport ${VNC_PORT}" >/dev/null; then
    echo "x11vnc already running."
else
    echo "Starting x11vnc..."
    x11vnc \
        -display "$DISPLAY_NUM" \
        -localhost \
        -forever \
        -shared \
        -nopw \
        -rfbport "$VNC_PORT" \
        >"$RUNTIME_DIR/x11vnc.log" 2>&1 &
fi

sleep 1

# noVNC / websockify
if pgrep -f "websockify.*127.0.0.1:${NOVNC_PORT}" >/dev/null; then
    echo "websockify already running."
else
    echo "Starting noVNC..."
    websockify \
        --web=/usr/share/novnc \
        "127.0.0.1:${NOVNC_PORT}" \
        "127.0.0.1:${VNC_PORT}" \
        >"$RUNTIME_DIR/novnc.log" 2>&1 &
fi

sleep 1

if ! curl -fsS \
    "http://127.0.0.1:${NOVNC_PORT}/vnc.html" \
    >/dev/null; then
    echo "ERROR: noVNC is not responding."
    exit 1
fi

echo "noVNC: OK"


# Cloudflare quick tunnel
URL=""

if pgrep -f "cloudflared tunnel --url http://127.0.0.1:${NOVNC_PORT}" >/dev/null; then
    echo "Cloudflare tunnel already running."

    if [[ -f "$RUNTIME_DIR/cloudflared.log" ]]; then
        URL="$(
            grep -a -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' \
                "$RUNTIME_DIR/cloudflared.log" |
            tail -1 || true
        )"
    fi
fi

if [[ -z "$URL" ]]; then
    echo "Starting Cloudflare quick tunnel..."

    : >"$RUNTIME_DIR/cloudflared.log"

    cloudflared tunnel \
        --url "http://127.0.0.1:${NOVNC_PORT}" \
        >"$RUNTIME_DIR/cloudflared.log" 2>&1 &

    echo $! >"$RUNTIME_DIR/cloudflared.pid"

    echo "Waiting for public URL..."

    for _ in $(seq 1 30); do
        URL="$(
            grep -a -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' \
                "$RUNTIME_DIR/cloudflared.log" |
            tail -1 || true
        )"

        if [[ -n "$URL" ]]; then
            break
        fi

        sleep 1
    done
fi

if [[ -z "$URL" ]]; then
    echo "ERROR: Cloudflare URL was not obtained."
    echo
    tail -30 "$RUNTIME_DIR/cloudflared.log"
    exit 1
fi

LOGIN_URL="${URL}/vnc.html?autoconnect=true&resize=none"

echo
echo "========================================"
echo "MOBILE LOGIN READY"
echo "========================================"
echo
echo "$LOGIN_URL"
echo
echo "Open this URL on your phone."
echo "========================================"
echo "MOBILE_LOGIN_URL=$LOGIN_URL"
