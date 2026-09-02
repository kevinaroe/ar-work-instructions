#!/usr/bin/env bash
# Serve the app on the shop LAN so headsets can reach it.
# WebXR requires a secure context: localhost is trusted, other hosts need HTTPS.
# For headsets on the same network, see the HTTPS note in README.md.
set -euo pipefail
PORT="${1:-8000}"
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0 2>/dev/null || echo localhost)
echo "Serving on:"
echo "  http://localhost:$PORT"
echo "  http://$IP:$PORT   <- point the headset browser here"
exec python3 -m http.server "$PORT"
