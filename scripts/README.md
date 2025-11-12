# Test Scripts

This directory contains test scripts for automating Unity Inspector commands. Test scripts allow you to create repeatable test sequences for debugging and testing game behavior.

## Directory Structure

```
scripts/
├── README.md           # This file
├── examples/           # Example scripts (not listed in list_test_scripts)
│   ├── example-movement-test.json
│   ├── example-combat-test.json
│   └── example-level-sequence.json
└── your-scripts.json   # Your custom test scripts go here
```

## Script Format

Test scripts are JSON files with the following structure:

```json
{
  "name": "Human-Readable Test Name",
  "description": "Detailed description of what this script tests",
  "steps": [
    {
      "command": "tool_name",
      "params": {
        "param1": "value1",
        "param2": "value2"
      },
      "wait": 1000
    }
  ]
}
```

### Fields

- **name** (required): Display name for the script
- **description** (optional): What the script tests or demonstrates
- **steps** (required): Array of commands to execute

### Step Fields

- **command** (required): Name of any Unity Inspector MCP tool
- **params** (optional): Object containing parameters for the command
- **wait** (optional): Milliseconds to wait after this step completes

## Available Commands

You can use any Unity Inspector MCP tool in your scripts:

### Level Control
- `go_to_level` - Load a specific level
- `list_campaigns` - List available campaigns

### Input Simulation
- `simulate_input` - Simulate controller input
  - Actions: up, down, left, right, fire, jump, special, highFive, gesture, sprint, start, escape
  - Supports duration (hold time) and count (repeated presses)

### Inspection
- `inspect_player` - Get player information
- `list_enemies` - List enemies in scene
- `list_gameobjects` - List GameObjects
- `inspect_gameobject` - Inspect specific GameObject
- `inspect_component` - Inspect specific component
- `query_gameobjects` - Search for GameObjects

### State Modification
- `teleport_player` - Move player to coordinates
- `set_player_health` - Set player health
- `set_game_speed` - Change time scale
- `modify_component` - Modify component properties

### Utilities
- `take_screenshot` - Capture game screenshot
- `execute_code` - Execute C# code
- `ping` - Test connection

## Example Scripts

### Basic Movement Test

```json
{
  "name": "Movement Test",
  "description": "Test basic player movement and jumping",
  "steps": [
    {
      "command": "go_to_level",
      "params": { "campaignIndex": 0, "levelIndex": 0 },
      "wait": 3000
    },
    {
      "command": "simulate_input",
      "params": { "action": "right", "duration": 1000 }
    },
    {
      "command": "simulate_input",
      "params": { "action": "jump" },
      "wait": 1000
    },
    {
      "command": "take_screenshot"
    }
  ]
}
```

### Combat Test

```json
{
  "name": "Combat Test",
  "description": "Test firing and special abilities",
  "steps": [
    {
      "command": "go_to_level",
      "params": { "campaignIndex": 1, "levelIndex": 0 },
      "wait": 3000
    },
    {
      "command": "simulate_input",
      "params": { "action": "fire", "count": 5, "interval": 200 },
      "wait": 1000
    },
    {
      "command": "simulate_input",
      "params": { "action": "special" },
      "wait": 1000
    },
    {
      "command": "list_enemies"
    }
  ]
}
```

### State Modification Test

```json
{
  "name": "Teleport Test",
  "description": "Test teleportation and health modification",
  "steps": [
    {
      "command": "go_to_level",
      "params": { "campaignIndex": 0, "levelIndex": 0 },
      "wait": 3000
    },
    {
      "command": "teleport_player",
      "params": { "x": 100, "y": 50 },
      "wait": 500
    },
    {
      "command": "set_player_health",
      "params": { "health": 10 },
      "wait": 500
    },
    {
      "command": "inspect_player"
    }
  ]
}
```

## Tips

### Wait Times
- Add wait times after level loads (typically 2-3 seconds)
- Add short waits after input to let animations complete
- No wait needed if the next command doesn't depend on the previous one

### Script Organization
- Keep scripts focused on testing one feature or scenario
- Use descriptive names and descriptions
- Consider breaking complex tests into multiple smaller scripts

### Debugging Failed Scripts
- Script execution stops at the first failed step
- Check the returned results for error messages
- Add `inspect_player` or `list_gameobjects` steps to verify state

### Common Patterns

**Load and inspect:**
```json
{
  "command": "go_to_level",
  "params": { "campaignIndex": 0, "levelIndex": 0 },
  "wait": 3000
},
{
  "command": "inspect_player"
}
```

**Repeated input:**
```json
{
  "command": "simulate_input",
  "params": { "action": "fire", "count": 10, "interval": 150 }
}
```

**Held input:**
```json
{
  "command": "simulate_input",
  "params": { "action": "right", "duration": 2000 }
}
```

## Running Scripts

### From Claude Code

Use the `run_test_script` tool with the script name:
```
run_test_script with script: "your-script.json"
```

Or with just the base name:
```
run_test_script with script: "your-script"
```

Or with an absolute path:
```
run_test_script with script: "/full/path/to/script.json"
```

### Listing Scripts

Use the `list_test_scripts` tool to see all available scripts in this directory.

## See Also

- Check `examples/` for complete working examples
- See main README.md for Unity Inspector setup
- Unity Inspector Mod documentation for available game commands
