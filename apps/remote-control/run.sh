#!/usr/bin/env bash
set -eo pipefail

SSH_HOST="${RC_SSH_HOST:-patrick@100.68.9.36}"
APP_PORT=5199

echo "Fetching manifest from $SSH_HOST..."
MANIFEST=$(ssh "$SSH_HOST" 'cat ~/.superset/host/*/manifest.json')

ENDPOINT=$(echo "$MANIFEST" | python3 -c "import json,sys; print(json.load(sys.stdin)['endpoint'])")
RC_SECRET=$(echo "$MANIFEST" | python3 -c "import json,sys; print(json.load(sys.stdin)['authToken'])")
RC_PORT=$(echo "$ENDPOINT" | python3 -c "import sys,urllib.parse; print(urllib.parse.urlparse(sys.stdin.read().strip()).port)")

echo "Tunnelling port $RC_PORT from $SSH_HOST..."
pkill -f "ssh.*:${RC_PORT}:127.0.0.1:${RC_PORT}" 2>/dev/null || true
ssh -f -N -L "${RC_PORT}:127.0.0.1:${RC_PORT}" "$SSH_HOST"

CREDS_URL="http://localhost:${APP_PORT}/?rc_host=127.0.0.1&rc_port=${RC_PORT}&rc_secret=${RC_SECRET}"
echo ""
echo "  Port:   $RC_PORT"
echo "  Secret: ${RC_SECRET:0:8}..."
echo "  URL:    $CREDS_URL"
echo ""

bun run dev &
VITE_PID=$!

echo "Waiting for dev server..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${APP_PORT}/" -o /dev/null 2>/dev/null; then break; fi
  sleep 0.5
done

echo "Opening browser..."
open "$CREDS_URL"

wait $VITE_PID
