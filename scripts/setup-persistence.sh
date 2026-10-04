#!/usr/bin/env bash
#
# Setup script for WhatsApp MCP server as a macOS LaunchAgent.
# Configures both the MCP HTTP server and an optional Cloudflare tunnel.
#
# Usage:
#   1. Edit the variables below
#   2. chmod +x scripts/setup-persistence.sh
#   3. ./scripts/setup-persistence.sh
#
set -euo pipefail

# ---------------------------------------------------------------------------
# CONFIGURE THESE
# ---------------------------------------------------------------------------
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"
SESSION_NAME="default"
MCP_PORT=""      # Any free high port on your machine. Required.
TUNNEL_TOKEN=""  # Leave empty to skip tunnel setup
PUBLIC_URL=""    # Your tunnel's https:// origin. Required with TUNNEL_TOKEN (enables OAuth).
LABEL_PREFIX="com.$(whoami)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"   # absolute path launchd will run; override with NODE_BIN=...

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "ERROR: could not find an executable node (got '$NODE_BIN'). Install Node 22+ or run with NODE_BIN=/path/to/node." >&2
  exit 1
fi

if [[ -z "$MCP_PORT" ]]; then
  echo "ERROR: MCP_PORT is unset. Edit scripts/setup-persistence.sh and set it to any free high port on your machine." >&2
  exit 1
fi

if [[ -n "$TUNNEL_TOKEN" ]]; then
  if [[ -z "$PUBLIC_URL" ]]; then
    echo "ERROR: TUNNEL_TOKEN is set but PUBLIC_URL is empty. A tunnel requires OAuth; set PUBLIC_URL." >&2
    exit 1
  fi
  if [[ ! -f "$PROJECT_DIR/.mcp-credentials.json" ]]; then
    echo "Generating OAuth credentials at $PROJECT_DIR/.mcp-credentials.json (mode 0600)..."
    node "$PROJECT_DIR/dist/mcp-server/mcp-oauth.js" --generate "$PROJECT_DIR/.mcp-credentials.json"
  fi
  ALLOW_NO_AUTH=""
else
  ALLOW_NO_AUTH="1"   # no tunnel: nothing reaches the port but this machine
fi

# ---------------------------------------------------------------------------
# Derived
# ---------------------------------------------------------------------------
LAUNCH_AGENTS="$HOME_DIR/Library/LaunchAgents"
MCP_PLIST="$LAUNCH_AGENTS/${LABEL_PREFIX}.whatsapp-mcp.plist"
TUNNEL_PLIST="$LAUNCH_AGENTS/${LABEL_PREFIX}.whatsapp-tunnel.plist"

echo "=== WhatsApp MCP Server Setup ==="
echo "Project:  $PROJECT_DIR"
echo "Home:     $HOME_DIR"
echo "Session:  $SESSION_NAME"
echo ""

# Build first
echo "Building TypeScript..."
cd "$PROJECT_DIR"
npm run build
echo "Build complete."

# Create MCP LaunchAgent
echo "Creating MCP LaunchAgent at $MCP_PLIST"
sed \
  -e "s|__HOME__|$HOME_DIR|g" \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__NODE_DIR__|$(dirname "$NODE_BIN")|g" \
  -e "s|__PROJECT__|$PROJECT_DIR|g" \
  -e "s|__SESSION__|$SESSION_NAME|g" \
  -e "s|__PORT__|$MCP_PORT|g" \
  -e "s|__PUBLIC_URL__|$PUBLIC_URL|g" \
  -e "s|__ALLOW_NO_AUTH__|$ALLOW_NO_AUTH|g" \
  -e "s|com.yourname.whatsapp-mcp|${LABEL_PREFIX}.whatsapp-mcp|g" \
  config/whatsapp-mcp.plist.template > "$MCP_PLIST"

launchctl unload "$MCP_PLIST" 2>/dev/null || true
launchctl load "$MCP_PLIST"
echo "MCP server LaunchAgent loaded."

# Optionally create tunnel LaunchAgent
if [[ -n "$TUNNEL_TOKEN" ]]; then
  # Keep the token out of `ps` and out of the plist: cloudflared reads it from a 0600 file.
  TOKEN_FILE="$HOME_DIR/.cloudflared/${LABEL_PREFIX}.whatsapp-tunnel.token"
  mkdir -p "$HOME_DIR/.cloudflared" && chmod 700 "$HOME_DIR/.cloudflared"
  ( umask 077 && printf '%s' "$TUNNEL_TOKEN" > "$TOKEN_FILE" )
  chmod 600 "$TOKEN_FILE"
  echo "Tunnel token written to $TOKEN_FILE (mode 0600)"

  echo "Creating tunnel LaunchAgent at $TUNNEL_PLIST"
  sed \
    -e "s|__HOME__|$HOME_DIR|g" \
    -e "s|__TUNNEL_TOKEN_FILE__|$TOKEN_FILE|g" \
    -e "s|com.yourname.whatsapp-tunnel|${LABEL_PREFIX}.whatsapp-tunnel|g" \
    config/whatsapp-tunnel.plist.template > "$TUNNEL_PLIST"
  chmod 600 "$TUNNEL_PLIST"

  launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
  launchctl load "$TUNNEL_PLIST"
  echo "Tunnel LaunchAgent loaded."
else
  echo "Skipping tunnel setup (no TUNNEL_TOKEN set)."
fi

echo ""
echo "=== Setup Complete ==="
echo "MCP server: http://localhost:${MCP_PORT}/mcp"
echo "Health:     http://localhost:${MCP_PORT}/health"
echo ""
echo "Test with: curl http://localhost:${MCP_PORT}/health"
echo ""
echo "To register with Claude Code, add to ~/.claude.json:"
echo "  $(cat config/mcp-registration.json.template | sed "s|__PROJECT__|$PROJECT_DIR|g")"
