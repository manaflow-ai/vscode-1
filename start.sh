#!/bin/bash
set -e

# Start PTY server in background
cd /opt/pty-server
/opt/pty-server/.venv/bin/python pty_server.py &
PTY_PID=$!

# Wait a moment for PTY server to start
sleep 1

# Start VSCode server
exec /opt/vscode-server/bin/code-server-oss \
    --host 0.0.0.0 \
    --port "${VSCODE_SERVER_PORT:-8080}" \
    --without-connection-token \
    --disable-workspace-trust \
    "$@"
