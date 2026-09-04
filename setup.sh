#!/bin/sh
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WRAPPER="$DIR/wrapper.js"

for cmd in node npm; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: '$cmd' was not found on PATH." >&2
        echo "Install Node.js 18 or newer (https://nodejs.org) and run this script again." >&2
        exit 1
    fi
done

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "Error: Node.js 18 or newer is required (found $(node -v))." >&2
    exit 1
fi

echo "Installing dependencies with npm..."
(cd "$DIR" && npm install)

cat <<EOF

Dependencies installed.

--- Standard config: most MCP clients (Claude Desktop, Cursor, Windsurf, ...) ---
{
  "mcpServers": {
    "unity-inspector": {
      "command": "node",
      "args": ["$WRAPPER"]
    }
  }
}

--- Claude Code ---
claude mcp add unity-inspector -- node "$WRAPPER"

--- Codex CLI: add to ~/.codex/config.toml ---
[mcp_servers.unity-inspector]
command = "node"
args = ["$WRAPPER"]

Other clients: see README.md, section "Installation".

Then reconnect the client and make sure Broforce is running with the Unity
Inspector Mod loaded.
EOF
