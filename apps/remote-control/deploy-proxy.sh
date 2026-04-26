#!/usr/bin/env bash
# Deploy the remote-control proxy to Linux over SSH.
# Run from Mac: ./apps/remote-control/deploy-proxy.sh
set -eo pipefail

SSH_HOST="${RC_SSH_HOST:-patrick@100.68.9.36}"
REMOTE_DIR="/home/patrick/superset-app/apps/remote-control"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Building remote-control app..."
cd "$LOCAL_DIR"
bun run build

echo "==> Syncing dist/ and server files to $SSH_HOST..."
rsync -az --delete \
  "$LOCAL_DIR/dist/" \
  "$SSH_HOST:$REMOTE_DIR/dist/"

rsync -az \
  "$LOCAL_DIR/server.ts" \
  "$LOCAL_DIR/rc-proxy.service" \
  "$SSH_HOST:$REMOTE_DIR/"

echo "==> Installing user systemd service..."
ssh "$SSH_HOST" bash <<'REMOTE'
set -e
mkdir -p ~/.config/systemd/user/
cp ~/superset-app/apps/remote-control/rc-proxy.service ~/.config/systemd/user/rc-proxy.service
# Fix: user service uses default.target not multi-user.target
sed -i 's/WantedBy=multi-user.target/WantedBy=default.target/' ~/.config/systemd/user/rc-proxy.service
systemctl --user daemon-reload
systemctl --user enable rc-proxy
systemctl --user restart rc-proxy
sleep 1
systemctl --user status rc-proxy --no-pager
REMOTE

echo ""
echo "Done! Proxy running at http://100.68.9.36:5198"
