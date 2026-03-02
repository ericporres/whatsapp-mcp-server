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
TUNNEL_TOKEN=""  # Leave empty to skip tunnel setup
LABEL_PREFIX="com.$(whoami)"

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
  -e "s|__PROJECT__|$PROJECT_DIR|g" \
  -e "s|__SESSION__|$SESSION_NAME|g" \
  -e "s|com.yourname.whatsapp-mcp|${LABEL_PREFIX}.whatsapp-mcp|g" \
  config/whatsapp-mcp.plist.template > "$MCP_PLIST"

launchctl unload "$MCP_PLIST" 2>/dev/null || true
launchctl load "$MCP_PLIST"
echo "MCP server LaunchAgent loaded."

# Optionally create tunnel LaunchAgent
if [[ -n "$TUNNEL_TOKEN" ]]; then
  echo "Creating tunnel LaunchAgent at $TUNNEL_PLIST"
  sed \
    -e "s|__HOME__|$HOME_DIR|g" \
    -e "s|__TUNNEL_TOKEN__|$TUNNEL_TOKEN|g" \
    -e "s|com.yourname.whatsapp-tunnel|${LABEL_PREFIX}.whatsapp-tunnel|g" \
    config/whatsapp-tunnel.plist.template > "$TUNNEL_PLIST"

  launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
  launchctl load "$TUNNEL_PLIST"
  echo "Tunnel LaunchAgent loaded."
else
  echo "Skipping tunnel setup (no TUNNEL_TOKEN set)."
fi

echo ""
echo "=== Setup Complete ==="
echo "MCP server: http://localhost:3847/mcp"
echo "Health:     http://localhost:3847/health"
echo ""
echo "Test with: curl http://localhost:3847/health"
echo ""
echo "To register with Claude Code, add to ~/.claude.json:"
echo "  $(cat config/mcp-registration.json.template | sed "s|__PROJECT__|$PROJECT_DIR|g")"
