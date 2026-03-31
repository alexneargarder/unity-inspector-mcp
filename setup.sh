#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPOS_DIR="$(dirname "$SCRIPT_DIR")"
MCP_CONFIG="$REPOS_DIR/.mcp.json"

echo "Installing npm dependencies..."
nix-shell -p nodejs_22 --run "cd '$SCRIPT_DIR' && npm install"

echo "Configuring MCP server..."
if [[ -f "$MCP_CONFIG" ]]; then
    if grep -q "unity-inspector" "$MCP_CONFIG"; then
        echo "Unity inspector already configured in $MCP_CONFIG"
    else
        echo "WARNING: $MCP_CONFIG exists but doesn't contain unity-inspector."
        echo "You may need to manually add the unity-inspector entry."
    fi
else
    cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "unity-inspector": {
      "command": "nix-shell",
      "args": ["-p", "nodejs_22", "--run", "node $SCRIPT_DIR/index.js"],
      "cwd": "$SCRIPT_DIR"
    }
  }
}
EOF
    echo "Created $MCP_CONFIG"
fi

echo "Done. Restart Claude Code or run /mcp to connect."
