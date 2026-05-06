#!/usr/bin/env bash
export PATH="$HOME/.bun/bin:$HOME/.local/share/fnm:$PATH"
eval "$(fnm env 2>/dev/null)" || true
export SKIP_ENV_VALIDATION=1
export NEXT_PUBLIC_OUTLIT_KEY="${NEXT_PUBLIC_OUTLIT_KEY:-placeholder}"
cd "$HOME/superset-app/apps/desktop" || exit 1

# Use production build for better performance (run "bun run compile:app" first)
# To run dev mode: SUPERSET_DEV=1 ./superset-launch.sh
if [[ "${SUPERSET_DEV:-}" == "1" ]]; then
	exec bun run dev
else
	# Launch Electron directly against pre-built dist (instant startup)
	# Rebuild with: NODE_OPTIONS=--max-old-space-size=8192 npx electron-vite build
	exec npx electron .
fi
