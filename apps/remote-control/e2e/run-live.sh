#!/usr/bin/env bash
# Run E2E tests against the live Linux host-service.
# Reads endpoint + authToken from manifest.json over SSH.
#
# Manifest schema: { pid, endpoint: "http://host:port", authToken, startedAt, organizationId }
#
# Usage:
#   ./e2e/run-live.sh [ssh-host]
#   SSH_HOST=patrick@100.115.163.113 ./e2e/run-live.sh
#
# Override host:
#   RC_SSH_HOST=patrick@100.115.163.113 ./e2e/run-live.sh

set -euo pipefail

SSH_HOST="${1:-${RC_SSH_HOST:-patrick@100.115.163.113}}"

echo "Fetching manifest from $SSH_HOST…"
MANIFEST=$(ssh "$SSH_HOST" 'cat ~/.superset/host/*/manifest.json')

# endpoint is "http://0.0.0.0:PORT" or "http://HOST:PORT"
ENDPOINT=$(echo "$MANIFEST" | python3 -c "import json,sys; print(json.load(sys.stdin)['endpoint'])")
RC_SECRET=$(echo "$MANIFEST" | python3 -c "import json,sys; print(json.load(sys.stdin)['authToken'])")

# Extract port from endpoint
RC_PORT=$(echo "$ENDPOINT" | python3 -c "import sys,urllib.parse; print(urllib.parse.urlparse(sys.stdin.read().strip()).port)")

# Use the Tailscale IP of the SSH host as RC_HOST (strip user@ prefix)
RC_HOST="${SSH_HOST#*@}"

echo "Host: $RC_HOST  Port: $RC_PORT"

export RC_HOST RC_PORT RC_SECRET
bun run test:e2e
