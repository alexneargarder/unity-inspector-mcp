# Unity Inspector MCP Server

An MCP (Model Context Protocol) server that allows Claude to inspect and interact with Unity games running the Unity Inspector Mod.

## Prerequisites

1. Unity Inspector Mod installed and running in your Unity game (Broforce)
2. Node.js 18+ installed
3. The Unity game must be running with the TCP server started (port 9999)

## Installation

```bash
npm install
```

## Usage

### Testing the connection

First, make sure the Unity Inspector Mod's TCP server is running in your game. You can test the connection using:

```bash
# From the BroforceMods/Unity Inspector Mod directory
python test_tcp.py
```

### Adding to Claude Desktop

Add this to your Claude Desktop configuration file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux:** `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "unity-inspector": {
      "command": "node",
      "args": ["/path/to/unity-inspector-mcp/index.js"],
      "cwd": "/path/to/unity-inspector-mcp"
    }
  }
}
```

Replace `/path/to/unity-inspector-mcp` with the actual path to this directory.

For WSL users, use the Windows path format:
```json
{
  "mcpServers": {
    "unity-inspector": {
      "command": "wsl",
      "args": [
        "node",
        "/mnt/c/Users/YOUR_USERNAME/repos/unity-inspector-mcp/index.js"
      ],
      "cwd": "C:\\Users\\YOUR_USERNAME\\repos\\unity-inspector-mcp"
    }
  }
}
```

## Available Tools

- `ping` - Test connection to Unity Inspector
- `list_gameobjects` - List all GameObjects in the scene
- `inspect_gameobject` - Inspect a specific GameObject by path
- `query_gameobjects` - Search for GameObjects by name or component
- `inspect_player` - Get detailed information about the player(s)
- `list_enemies` - List all enemies in the scene
- `take_screenshot` - Take a screenshot of the game
- `execute_code` - Execute C# expressions in the Unity context
- `inspect_component` - Inspect a specific component on a GameObject
- `modify_component` - Modify properties of a component
- `teleport_player` - Teleport the player to specific coordinates
- `set_player_health` - Set the player's health
- `set_game_speed` - Set the game speed (time scale)
- `list_campaigns` - List all available campaigns
- `go_to_level` - Go directly to a specific campaign level
- `simulate_input` - Simulate keyboard/controller input

## Architecture

```
[Claude Desktop] <--MCP--> [MCP Server (Node.js)] <--TCP--> [Unity Inspector Mod] <--> [Unity Game]
```

The MCP server acts as a bridge between Claude and the Unity game, translating MCP tool calls into TCP commands that the Unity Inspector Mod can understand.

## Troubleshooting

### Connection Issues

If running in WSL and can't connect:
- The server automatically detects WSL and uses the Windows host IP
- You can manually test with: `ip route show default` to get the Windows IP

### Server not responding

1. Check the Unity game is running
2. Check Unity Inspector Mod is loaded
3. Click "Start Server" in the mod's UI if not running
4. Default port is 9999

## Development

To modify the available tools, edit:
- `index.js` - MCP server implementation
- `BroforceMods/Unity Inspector Mod/MessageHandler.cs` - Unity-side message handling