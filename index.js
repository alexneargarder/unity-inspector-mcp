#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { UnityInspectorClient } from './lib/unity-client.js';
import { composeExtraLaunchArgs, detectActiveProfile, gameStartTime, isGameRunning, killGame, resolveLaunchCommand, spawnDetached } from './lib/game-process.js';
import {
  buildScriptCatalog,
  listCSharpScripts,
  listTestScripts,
  readScriptSource,
  runTestScript,
} from './lib/script-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WATCH_LOG_MAX_BYTES = 64 * 1024;

const R2_PROFILES_SUFFIX = 'r2modmanPlus-local/Broforce/profiles';
const UMM_LOG_IN_PROFILE = 'UMM/Core/Log.txt';
const DIRECT_INSTALL_LOGS = ['Mods/UnityModManager/Log.txt', 'Mods/Log.txt'];
const UNITY_PRODUCT_DIR = 'Free Lives/Broforce';
// Unity only settled on Player.log in 2018.3; this game is 2017.4 and writes output_log.txt on Windows
const WINDOWS_PLAYER_LOGS = ['Player.log', 'output_log.txt'];
// etimes reports whole seconds, so a log written in the game's start second can read as older than it
const STALE_TOLERANCE_MS = 3000;

function r2ProfileRoots() {
  const roots = [path.join(os.homedir(), '.config', R2_PROFILES_SUFFIX)];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, R2_PROFILES_SUFFIX));
  roots.push(path.join(os.homedir(), 'AppData/Roaming', R2_PROFILES_SUFFIX));
  return [...new Set(roots)];
}

function playerLogPaths() {
  const home = os.homedir();
  const paths = [path.join(home, '.config/unity3d', UNITY_PRODUCT_DIR, 'Player.log')];

  const windowsBases = [];
  if (process.env.USERPROFILE) {
    windowsBases.push(path.join(process.env.USERPROFILE, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  }
  windowsBases.push(path.join(home, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  if (unityClient.protonPrefix) {
    windowsBases.push(path.join(unityClient.protonPrefix, 'drive_c/users/steamuser/AppData/LocalLow', UNITY_PRODUCT_DIR));
  }
  for (const base of windowsBases) {
    for (const name of WINDOWS_PLAYER_LOGS) paths.push(path.join(base, name));
  }

  paths.push(path.join(home, 'Library/Logs/Unity/Player.log'));
  paths.push(path.join(home, 'Library/Logs', UNITY_PRODUCT_DIR, 'Player.log'));

  if (unityClient.gamePath) {
    paths.push(path.join(unityClient.gamePath, 'Broforce_Data/output_log.txt'));
  }

  return [...new Set(paths)];
}

function profileLogPaths(profile) {
  return r2ProfileRoots().map(root => path.join(root, profile, UMM_LOG_IN_PROFILE));
}

function logOverride() {
  return (process.env.UNITY_INSPECTOR_LOG || '').trim();
}

async function ummLogSearch() {
  const override = logOverride();
  if (override) return { paths: [override], displays: [override], override: true };

  const paths = [];
  const displays = [];

  for (const root of r2ProfileRoots()) {
    let profiles = [];
    try {
      profiles = (await fs.readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      displays.push(path.join(root, '*', UMM_LOG_IN_PROFILE));
      continue;
    }

    if (profiles.length === 0) {
      displays.push(path.join(root, '*', UMM_LOG_IN_PROFILE));
      continue;
    }
    for (const profile of profiles) {
      const candidate = path.join(root, profile, UMM_LOG_IN_PROFILE);
      paths.push(candidate);
      displays.push(candidate);
    }
  }

  try {
    await unityClient.detectPlatform();
  } catch (err) {
    console.error(`Game path detection failed while looking for the log: ${err.message}`);
  }
  if (unityClient.gamePath) {
    for (const relative of DIRECT_INSTALL_LOGS) {
      const candidate = path.join(unityClient.gamePath, relative);
      paths.push(candidate);
      displays.push(candidate);
    }
  }

  for (const candidate of playerLogPaths()) {
    paths.push(candidate);
    displays.push(candidate);
  }

  return { paths: [...new Set(paths)], displays: [...new Set(displays)], override: false };
}

let watchLogOffset = 0;
let watchLogPath = null;
// Unity rotates Player.log at launch, so the path alone cannot tell one run's log from the next
let watchLogFileId = null;

const fileIdOf = (stat) => `${stat.dev}:${stat.ino}`;

async function statLogFile(candidate) {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function newestExisting(candidates, minMtimeMs = null) {
  let best = null;
  for (const candidate of candidates) {
    const stat = await statLogFile(candidate);
    if (!stat) continue;
    if (minMtimeMs !== null && stat.mtimeMs < minMtimeMs) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs: stat.mtimeMs };
  }
  return best;
}

export async function resolveLogFile(detectProfile = detectActiveProfile, startTime = gameStartTime) {
  const { paths, override } = await ummLogSearch();

  const started = await startTime();
  const liveSince = Number.isFinite(started) ? started - STALE_TOLERANCE_MS : null;

  let chosen = override ? await newestExisting(paths) : null;

  if (!override) {
    const profile = await detectProfile();
    if (profile) {
      chosen = liveSince === null
        ? await newestExisting([...profileLogPaths(profile), ...playerLogPaths()])
        : (await newestExisting(profileLogPaths(profile), liveSince))
          ?? (await newestExisting(playerLogPaths(), liveSince));
    }

    if (!chosen) chosen = await newestExisting(paths);
  }

  if (!chosen) return null;

  const modifiedAt = new Date(chosen.mtimeMs).toISOString();
  if (liveSince !== null && chosen.mtimeMs < liveSince) {
    return {
      ...chosen,
      modifiedAt,
      stale: true,
      warning:
        `${chosen.path} was last written ${modifiedAt}, before the running game started ` +
        `(${new Date(started).toISOString()}) — the running game is not writing to it. ` +
        (override
          ? `UNITY_INSPECTOR_LOG selected this file; unset it to search for the live log, ` +
            `or repoint it at the log the game is writing.`
          : `On a doorstop launch UMM's own log may be absent or appear late, while Unity's ` +
            `player log carries the same lines; set UNITY_INSPECTOR_LOG if the live log is ` +
            `somewhere else.`),
    };
  }

  return { ...chosen, modifiedAt, stale: false };
}

// Unity rotates Player.log at launch, so a stat or read can land on a path that just vanished
async function withResolvedLog(use) {
  let resolved = await resolveLogFile();
  if (!resolved) throw await logNotFoundError();

  try {
    return await use(resolved);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    resolved = await resolveLogFile();
    if (!resolved) throw await logNotFoundError();
    return await use(resolved);
  }
}

export function resetPlatformDetection() {
  unityClient.platform = null;
  unityClient.gamePath = null;
  unityClient.protonPrefix = null;
}

export function logFileInfo(resolved) {
  return {
    path: resolved.path,
    modifiedAt: resolved.modifiedAt,
    ...(resolved.stale ? { stale: true, warning: resolved.warning } : {}),
  };
}

export async function findLogPath(detectProfile = detectActiveProfile, startTime = gameStartTime) {
  const resolved = await resolveLogFile(detectProfile, startTime);
  return resolved ? resolved.path : null;
}

async function logNotFoundError() {
  const { displays, override } = await ummLogSearch();
  if (override) {
    return new Error(`UMM log file not found: UNITY_INSPECTOR_LOG points at ${displays[0]}, which does not exist.`);
  }
  return new Error(
    `UMM log file not found. Looked in:\n  ${displays.join('\n  ')}\n` +
    `Set UNITY_INSPECTOR_LOG to the log path if it lives elsewhere.`
  );
}

const unityClient = new UnityInspectorClient();

const server = new Server(
  {
    name: "unity-inspector-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Define available tools
export async function buildToolList() {
  let scriptCatalog = "";
  try {
    const scripts = await listCSharpScripts();
    if (scripts.count > 0) {
      scriptCatalog = "\n\nAvailable library scripts:\n" + scripts.scripts.map(s => {
        let line = `- ${s.name}: ${s.description}`;
        if (s.args.length > 0) {
          line += ` [args: ${s.args.map(a => a.split(':')[0].trim()).join(', ')}]`;
        }
        return line;
      }).join("\n");
    }
  } catch {}

  return [
      {
        name: "ping",
        description: "Test connection to Unity Inspector",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_gameobjects",
        description: "List all GameObjects in the scene",
        inputSchema: {
          type: "object",
          properties: {
            includeInactive: {
              type: "boolean",
              description: "Include inactive GameObjects",
              default: true,
            },
            maxResults: {
              type: "number",
              description: "Maximum number of GameObjects to return",
              default: 100,
            },
          },
        },
      },
      {
        name: "inspect_gameobject",
        description: "Inspect a specific GameObject by path",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the GameObject (e.g., '/Player')",
            },
            detailed: {
              type: "boolean",
              description: "Include full component details (default: false for lightweight response)",
              default: false,
            },
          },
          required: ["path"],
        },
      },
      {
        name: "inspect_component",
        description: "Inspect a specific component on a GameObject",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the GameObject (e.g., '/Player')",
            },
            componentType: {
              type: "string",
              description: "Component type name to inspect",
            },
          },
          required: ["path", "componentType"],
        },
      },
      {
        name: "query_gameobjects",
        description: "Search for GameObjects by name pattern, component type, or both. A component-only query with no name pattern works. componentType matches base types and interfaces, so a query for 'Projectile' finds instances of its subclasses. The response reports resolvedType, scanned and scanTruncated alongside count, totalFound and results.",
        inputSchema: {
          type: "object",
          properties: {
            namePattern: {
              type: "string",
              description: "Name pattern to search for. Optional — omit it to match on componentType alone",
            },
            componentType: {
              type: "string",
              description: "Component type to filter by. Matches base types and interfaces, so subclass instances are included",
            },
            includeInactive: {
              type: "boolean",
              description: "Include inactive GameObjects",
              default: true,
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results",
              default: 100,
            },
          },
        },
      },
      {
        name: "inspect_player",
        description: "Get detailed information about the player(s)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_enemies",
        description: "List all enemies in the scene",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "take_screenshot",
        description: "Take a screenshot of the game. Returns the path to the saved screenshot.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "execute_code",
        description: "Run C# in the Unity context. Accepts statements, local declarations, and a trailing 'return expr;' (a return before the final statement does not compile); input ending in an expression returns that expression's value. No lambda or Select wrapping trick is needed. Locals are call-scoped and do not persist to the next call — use static members or game objects for cross-call state. Types defined by a script loaded with execute_script are in scope here, by direct name and by reflection over the script assembly (field reads, member enumeration); MethodBase.GetMethodBody() on a script-compiled method kills the game process. Check the inner result's 'success' field (nested inside the TCP envelope's own success:true), which has three states: a value was produced (resultSet:true), the code ran but returned nothing (success:true, resultSet:false, no error), or it failed (success:false with 'error'; 'stackTrace' accompanies exceptions thrown by the submitted code and is null for plain compiler diagnostics and timeouts).",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "C# to run: statements, local declarations, a trailing 'return expr;', or a bare expression whose value is returned",
            },
          },
          required: ["code"],
        },
      },
      {
        name: "modify_component",
        description: "Modify properties of a component on a GameObject",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the GameObject",
            },
            component: {
              type: "string",
              description: "Component type name",
            },
            properties: {
              type: "object",
              description: "Properties to modify",
            },
          },
          required: ["path", "component", "properties"],
        },
      },
      {
        name: "teleport_player",
        description: "Teleport a player to a specific position",
        inputSchema: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "X coordinate",
            },
            y: {
              type: "number",
              description: "Y coordinate",
            },
            z: {
              type: "number",
              description: "Z coordinate (optional)",
            },
            playerNum: {
              type: "number",
              description: "Player index 0-3, or -1 for all active players (default: 0)",
            },
          },
          required: ["x", "y"],
        },
      },
      {
        name: "set_player_health",
        description: "Set a player's health",
        inputSchema: {
          type: "object",
          properties: {
            health: {
              type: "number",
              description: "Health value",
            },
            playerNum: {
              type: "number",
              description: "Player index 0-3, or -1 for all active players (default: 0)",
            },
          },
          required: ["health"],
        },
      },
      {
        name: "spawn_entity",
        description: "Spawn an enemy at a world position in the currently loaded level (a level must be loaded). `type` is matched case-insensitively against the enemy prefabs of the level's active theme: the theme field name (`mookBigGuy`), the name without the `mook` prefix (`bigGuy`), or the prefab's own name; `facehugger` and `baneling` alias `alienFaceHugger` and `alienBaneling`. Which types exist depends on the loaded level's theme — an unknown type fails with `availableTypes` listing everything spawnable right now, so a bogus type discovers the roster. Enemies spawn alert, on the ground, and registered with the networking layer like level-placed enemies, except the two alien aliases, which use the game's local-only spawn helpers. Success returns `type` (resolved field name), `prefab`, `name`, `instanceId`, `networked`, `x`, `y`; failure returns `error` plus `availableTypes` or `stackTrace`. If another mod suppresses enemy spawning (Utility Mod's `disableEnemySpawn`, for one), the spawn fails and the error names the Harmony patch owners responsible.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "Enemy type to spawn, matched case-insensitively against the current theme's enemy prefabs",
            },
            x: {
              type: "number",
              description: "X coordinate",
            },
            y: {
              type: "number",
              description: "Y coordinate",
            },
            xI: {
              type: "number",
              description: "Initial horizontal velocity (default: 0)",
              default: 0,
            },
            yI: {
              type: "number",
              description: "Initial vertical velocity, positive is up (default: 0)",
              default: 0,
            },
          },
          required: ["type", "x", "y"],
        },
      },
      {
        name: "set_game_speed",
        description: "Set the game speed (time scale)",
        inputSchema: {
          type: "object",
          properties: {
            speed: {
              type: "number",
              description: "Speed multiplier (1.0 = normal, 0.5 = half speed, 2.0 = double speed)",
            },
          },
          required: ["speed"],
        },
      },
      {
        name: "list_campaigns",
        description: "List all available campaigns with their indices",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "go_to_level",
        description: "Go directly to a specific campaign level",
        inputSchema: {
          type: "object",
          properties: {
            campaignIndex: {
              type: "number",
              description: "Campaign index (0-27)",
            },
            levelIndex: {
              type: "number",
              description: "Level index within the campaign (0-based)",
            },
          },
          required: ["campaignIndex", "levelIndex"],
        },
      },
      {
        name: "swap_bro",
        description:
          "Swap the current player's bro mid-level. Kills the current bro and spawns the new one at the same position. Integrates with Swap Bros Mod when available, falls back to direct game manipulation.",
        inputSchema: {
          type: "object",
          properties: {
            broName: {
              type: "string",
              description:
                "Bro name (e.g., 'Rambro', 'Brommando', 'B. A. Broracus'). Use list_bros to see available names.",
            },
            playerNum: {
              type: "number",
              description: "Player number 0-3 (default: 0)",
            },
          },
          required: ["broName"],
        },
      },
      {
        name: "set_bro",
        description:
          "Set which bro the player will spawn as next (on death/respawn/next level). Does NOT change the current bro mid-level.",
        inputSchema: {
          type: "object",
          properties: {
            broName: {
              type: "string",
              description:
                "Bro name (e.g., 'Rambro', 'Brommando'). Use list_bros to see available names.",
            },
            playerNum: {
              type: "number",
              description: "Player number 0-3 (default: 0)",
            },
          },
          required: ["broName"],
        },
      },
      {
        name: "list_bros",
        description:
          "List all available bros that can be used with swap_bro and set_bro. Reports the selected bro for the given player (currentBro) and for all active players (currentBros array).",
        inputSchema: {
          type: "object",
          properties: {
            playerNum: {
              type: "number",
              description: "Player number 0-3 for the currentBro readout (default: 0). The bro lists and currentBros array are always returned regardless.",
            },
          },
        },
      },
      {
        name: "restart_level",
        description:
          "Restart the current level from the beginning. Clears checkpoints and trigger state for a full reset.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "simulate_input",
        description: "Simulate keyboard/controller input",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "Input action (up, down, left, right, fire, jump, special, highFive, gesture, sprint, start, escape)",
            },
            duration: {
              type: "number",
              description: "Hold duration in milliseconds (optional)",
            },
            count: {
              type: "number",
              description: "Number of times to press the key (optional, cannot be used with duration)",
            },
            interval: {
              type: "number",
              description: "Milliseconds between presses when count > 1 (default: 200)",
            },
            player: {
              type: "number",
              description: "Player number (0-3, default: 0)",
            },
          },
          required: ["action"],
        },
      },
      {
        name: "list_test_scripts",
        description: "List all available test scripts in scripts/ and scripts/examples/",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "wait_for_game",
        description: "Wait for the game to start up and the Unity Inspector TCP server to become responsive. Polls the connection until a ping succeeds or timeout is reached. On timeout the result carries a 'state' saying how it failed: 'no-process' (no game process is running), 'connection-refused' (the process is there but nothing is listening on the port), 'connected-unresponsive' (the port accepts connections but ping got no reply), 'connection-dropped' (the port accepted a connection that was then closed), or 'unknown' (process detection is unavailable). The wait can overrun the timeout by up to one connect timeout (5s), since an attempt already in flight is allowed to finish.",
        inputSchema: {
          type: "object",
          properties: {
            timeout: {
              type: "number",
              description: "Maximum time to wait in seconds (default: 60)",
            },
            interval: {
              type: "number",
              description: "Seconds between connection attempts (default: 3)",
            },
          },
        },
      },
      {
        name: "game_state",
        description: "Get a high-level summary of the current game state: scene, game mode, level info, player status, and bro type. Single call to orient yourself.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "read_log",
        description: "Read the mod log file — UMM's own log, or Unity's player log, which always exists and carries the same UMM and mod lines. Returns the last N lines by default, or filter by pattern. The response names the file it read and when it was last written, and flags `stale: true` with a warning when that file predates the running game.",
        inputSchema: {
          type: "object",
          properties: {
            lines: {
              type: "number",
              minimum: 1,
              description: "Number of lines to return from the end of the log (default: 50)",
            },
            filter: {
              type: "string",
              description: "Only return lines containing this string (case-insensitive)",
            },
          },
        },
      },
      {
        name: "watch_log",
        description: "Return log entries that appeared since the last call to watch_log. First call returns the last 20 lines as a baseline (`isBaseline: true`); later calls report `isBaseline: false` alongside the new lines. Use this for iterative debug loops. Like read_log it names the file and its last-written time, and flags `stale: true` when the running game is not the thing writing to it. The watch restarts as a baseline whenever the file underneath it changes — a rotation, or the resolved `path` switching once mid-run because UMM's own log appeared after startup.",
        inputSchema: {
          type: "object",
          properties: {
            reset: {
              type: "boolean",
              description: "Reset the watch position to the end of the log (default: false)",
            },
          },
        },
      },
      {
        name: "run_test_script",
        description: "Execute a test script containing a sequence of commands. Scripts are JSON files with command sequences that can include wait delays. Steps run directly against the game, so only game-side commands work — server-side tools (read_log, watch_log, list_scripts, launch_game, stop_game, wait_for_game, ...) cannot be used as steps.",
        inputSchema: {
          type: "object",
          properties: {
            script: {
              type: "string",
              description: "Script name (from scripts/ or scripts/examples/) or absolute file path",
            },
          },
          required: ["script"],
        },
      },
      {
        name: "execute_script",
        description: "Compile and run a C# script file in the Unity runtime. Supports full class definitions, MonoBehaviours, Harmony patches, and private member access. Scripts can define Main() for execution and Unload() for cleanup. Use ScriptContext for Harmony instances, logging, and arguments." + scriptCatalog,
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Script name (from scripts/csharp/) or absolute file path to a .cs file",
            },
            args: {
              type: "object",
              description: "Optional key-value arguments passed to the script via ScriptContext.Args",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "compile_script",
        description: "Compile a C# script without running it. Returns compilation success/failure and any compiler errors. Useful for validating scripts before execution.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Script name (from scripts/csharp/) or absolute file path to a .cs file",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "list_scripts",
        description: "List available C# scripts in the script library with their metadata (name, description, tags, arguments).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "unload_script",
        description: "Unload an active C# script, cleaning up its Harmony patches, GameObjects, and calling its Unload() method if defined.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name of the script to unload",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "launch_game",
        description: "Launch Broforce and wait for it to become responsive. Uses the BROFORCE_LAUNCH_CMD environment variable when set, otherwise launches Steam app 274190. Returns a warning if the game is already running unless restart is true.",
        inputSchema: {
          type: "object",
          properties: {
            vanilla: {
              type: "boolean",
              description: "Launch without mods (default: false)",
            },
            restart: {
              type: "boolean",
              description: "If true, stop the running game first then relaunch (default: false)",
            },
            launchArgs: {
              type: "string",
              description: "Extra arguments appended to the launch command, e.g. \"-m\" to launch minimized. Tokenized with shell-style quoting. Requires BROFORCE_LAUNCH_CMD — the Steam protocol launch ignores them.",
            },
          },
        },
      },
      {
        name: "stop_game",
        description: "Stop the running Broforce process.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
  ];
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await buildToolList() }));

const POLL_DEFAULT_TIMEOUT_MS = 60000;
const POLL_DEFAULT_INTERVAL_MS = 3000;
const POLL_MIN_INTERVAL_MS = 250;
const POLL_PING_TIMEOUT_MS = 6000;

function pollBudgetMs(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// A NaN budget makes every deadline comparison false and the poll run forever
export function resolvePollBudget(timeoutMs, intervalMs) {
  return {
    budgetMs: pollBudgetMs(timeoutMs, POLL_DEFAULT_TIMEOUT_MS),
    intervalMs: Math.max(POLL_MIN_INTERVAL_MS, pollBudgetMs(intervalMs, POLL_DEFAULT_INTERVAL_MS)),
  };
}

async function pollUntilResponsive(timeoutMs, intervalMs) {
  const { budgetMs: budget, intervalMs: interval } = resolvePollBudget(timeoutMs, intervalMs);

  const startTime = Date.now();
  const deadline = startTime + budget;
  const secondsSoFar = () => Number(((Date.now() - startTime) / 1000).toFixed(1));

  let attempts = 0;
  let lastError = null;
  let lastStage = null;

  for (;;) {
    attempts++;
    try {
      unityClient.disconnect();
      lastStage = "connect";
      await unityClient.connect();
      lastStage = "ping";
      const pingTimeout = Math.max(1000, Math.min(deadline - Date.now(), POLL_PING_TIMEOUT_MS));
      await unityClient.sendCommand("ping", {}, pingTimeout);
      const elapsed = secondsSoFar();
      return {
        success: true,
        state: "ready",
        message: `Game is ready (${attempts} attempts, ${elapsed}s)`,
        lastError: null,
        attempts,
        elapsed,
      };
    } catch (err) {
      lastError = err.message;
      console.error(`Attempt ${attempts}: ${err.message}`);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)));
    if (Date.now() >= deadline) break;
  }

  const running = await isGameRunning();
  const elapsed = secondsSoFar();
  const tail = `after ${elapsed}s (${attempts} attempts)`;
  const pingTimedOut = /^Command timeout after \d+ms$/.test(lastError || "");
  let state;
  let message;

  if (lastStage === "ping" && pingTimedOut) {
    state = "connected-unresponsive";
    message = `Port ${unityClient.port} accepts connections but ping got no reply ${tail} — the mod may be starting or the main thread stalled`;
    if (running === false) {
      message += ` (no Broforce process is detected, so whatever holds that port may not be the game)`;
    }
  } else if (running === false) {
    state = "no-process";
    message = lastStage === "ping"
      ? `The connection dropped and no Broforce process is running ${tail} — the game likely died: ${lastError}`
      : `No Broforce process is running ${tail} — use launch_game to start it`;
  } else if (lastStage === "ping") {
    state = "connection-dropped";
    message = `Port ${unityClient.port} accepted a connection that was then closed ${tail}: ${lastError}`;
  } else if (running === null) {
    state = "unknown";
    message = `Could not connect to port ${unityClient.port} ${tail}, and process detection is unavailable, so it is unknown whether the game is running`;
  } else {
    state = "connection-refused";
    message = `The game process is running but nothing accepted a connection on port ${unityClient.port} ${tail} — the mod's TCP server may be stopped or on another port`;
  }

  return { success: false, state, message, lastError, attempts, elapsed };
}

// Handle tool calls
export async function handleToolCall(request) {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  try {
    let result;

    switch (name) {
      case "ping":
        result = await unityClient.sendCommand("ping");
        break;

      case "list_gameobjects":
        const listParams = {
          includeInactive: args.includeInactive ?? true,
          maxResults: args.maxResults ?? 100,
        };
        console.error(`list_gameobjects params:`, listParams);
        result = await unityClient.sendCommand("list_gameobjects", listParams);
        break;

      case "inspect_gameobject":
        if (!args.path) {
          throw new Error("GameObject path is required");
        }
        result = await unityClient.sendCommand("inspect_gameobject", {
          path: args.path,
          detailed: args.detailed ?? false,
        });
        break;

      case "inspect_component":
        if (!args.path) {
          throw new Error("GameObject path is required");
        }
        if (!args.componentType) {
          throw new Error("Component type is required");
        }
        result = await unityClient.sendCommand("inspect_component", {
          path: args.path,
          componentType: args.componentType,
        });
        break;

      case "query_gameobjects":
        result = await unityClient.sendCommand("query_gameobjects", {
          namePattern: args.namePattern,
          componentType: args.componentType,
          includeInactive: args.includeInactive ?? true,
          maxResults: args.maxResults ?? 100,
        });
        break;

      case "inspect_player":
        result = await unityClient.sendCommand("inspect_player");
        break;

      case "list_enemies":
        result = await unityClient.sendCommand("list_enemies");
        break;

      case "take_screenshot":
        result = await unityClient.sendCommand("take_screenshot");
        if (result && result.path) {
          result.path = unityClient.translateScreenshotPath(result.path);
        }
        break;

      case "execute_code":
        if (!args.code) {
          throw new Error("Code is required");
        }
        result = await unityClient.sendCommand("execute_code", {
          code: args.code,
        });
        break;

      case "modify_component":
        if (!args.path || !args.component || !args.properties) {
          throw new Error("Path, component, and properties are required");
        }
        result = await unityClient.sendCommand("modify_component", {
          path: args.path,
          component: args.component,
          properties: args.properties,
        });
        break;

      case "teleport_player":
        if (args.x === undefined || args.y === undefined) {
          throw new Error("X and Y coordinates are required");
        }
        result = await unityClient.sendCommand("teleport_player", {
          x: args.x,
          y: args.y,
          z: args.z,
          playerNum: args.playerNum ?? 0,
        });
        break;

      case "set_player_health":
        if (args.health === undefined) {
          throw new Error("Health value is required");
        }
        result = await unityClient.sendCommand("set_player_health", {
          health: args.health,
          playerNum: args.playerNum ?? 0,
        });
        break;

      case "spawn_entity":
        if (!args.type || args.x === undefined || args.y === undefined) {
          throw new Error("Entity type and coordinates are required");
        }
        result = await unityClient.sendCommand("spawn_entity", {
          type: args.type,
          x: args.x,
          y: args.y,
          xI: args.xI,
          yI: args.yI,
        });
        break;

      case "set_game_speed":
        if (args.speed === undefined) {
          throw new Error("Speed value is required");
        }
        result = await unityClient.sendCommand("set_game_speed", {
          speed: args.speed,
        });
        break;

      case "list_campaigns":
        result = await unityClient.sendCommand("list_campaigns", {});
        break;

      case "go_to_level":
        if (args.campaignIndex === undefined || args.levelIndex === undefined) {
          throw new Error("Campaign index and level index are required");
        }
        result = await unityClient.sendCommand("go_to_level", {
          campaignIndex: args.campaignIndex,
          levelIndex: args.levelIndex,
        });

        setTimeout(async () => {
          const isHealthy = await unityClient.checkHealth();
          if (!isHealthy) {
            console.error("WARNING: Game may have crashed after go_to_level");
          }
        }, 3000);
        break;

      case "swap_bro":
        if (!args.broName) {
          throw new Error("Bro name is required");
        }
        result = await unityClient.sendCommand("swap_bro", {
          broName: args.broName,
          playerNum: args.playerNum ?? 0,
        });
        break;

      case "set_bro":
        if (!args.broName) {
          throw new Error("Bro name is required");
        }
        result = await unityClient.sendCommand("set_bro", {
          broName: args.broName,
          playerNum: args.playerNum ?? 0,
        });
        break;

      case "list_bros":
        result = await unityClient.sendCommand("list_bros", {
          playerNum: args.playerNum ?? 0,
        });
        break;

      case "restart_level":
        result = await unityClient.sendCommand("restart_level", {});
        break;

      case "simulate_input":
        if (!args.action) {
          throw new Error("Input action is required");
        }
        result = await unityClient.sendCommand("simulate_input", {
          action: args.action,
          duration: args.duration,
          count: args.count,
          interval: args.interval,
          player: args.player,
        });
        break;

      case "list_test_scripts":
        result = await listTestScripts();
        break;

      case "wait_for_game": {
        const poll = await pollUntilResponsive((args.timeout ?? 60) * 1000, (args.interval ?? 3) * 1000);
        result = poll.success
          ? { success: true, message: poll.message }
          : { success: false, state: poll.state, message: poll.message, lastError: poll.lastError, attempts: poll.attempts };
        break;
      }

      case "game_state":
        result = await unityClient.sendCommand("game_state", {});
        break;

      case "read_log": {
        result = await withResolvedLog(async (resolved) => {
          const logContent = await fs.readFile(resolved.path, 'utf-8');
          const allLines = logContent.split('\n');
          let lines = allLines;

          if (args.filter) {
            const filterLower = args.filter.toLowerCase();
            lines = lines.filter(l => l.toLowerCase().includes(filterLower));
          }

          const requested = Number(args.lines ?? 50);
          const count = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 50;
          lines = lines.slice(-count);

          return {
            ...logFileInfo(resolved),
            totalLines: allLines.length,
            returnedLines: lines.length,
            content: lines.join('\n'),
          };
        });
        break;
      }

      case "watch_log": {
        result = await withResolvedLog(async (resolved) => {
          const logPath = resolved.path;
          const stat = await fs.stat(logPath);
          const fileSize = stat.size;
          const fileId = fileIdOf(stat);

          if (args.reset) {
            watchLogOffset = fileSize;
            watchLogPath = logPath;
            watchLogFileId = fileId;
            return {
              ...logFileInfo(resolved),
              isBaseline: true,
              message: "Watch position reset to end of log",
              fileSize,
            };
          }

          if (watchLogPath !== logPath || watchLogFileId !== fileId || watchLogOffset > fileSize) {
            const logContent = await fs.readFile(logPath, 'utf-8');
            const lines = logContent.split('\n').slice(-20);
            watchLogOffset = fileSize;
            watchLogPath = logPath;
            watchLogFileId = fileId;
            return {
              ...logFileInfo(resolved),
              isBaseline: true,
              newLines: lines.length,
              content: lines.join('\n'),
            };
          }

          if (watchLogOffset === fileSize) {
            return {
              ...logFileInfo(resolved),
              isBaseline: false,
              newLines: 0,
              content: "",
              message: "No new log entries",
            };
          }

          let readFrom = watchLogOffset;
          let skippedBytes = 0;
          if (fileSize - readFrom > WATCH_LOG_MAX_BYTES) {
            skippedBytes = fileSize - readFrom - WATCH_LOG_MAX_BYTES;
            readFrom = fileSize - WATCH_LOG_MAX_BYTES;
          }
          const bytesToRead = fileSize - readFrom;

          let newContent;
          const fh = await fs.open(logPath, 'r');
          try {
            const buffer = Buffer.alloc(bytesToRead);
            const { bytesRead } = await fh.read(buffer, 0, bytesToRead, readFrom);
            newContent = buffer.subarray(0, bytesRead).toString('utf-8');
          } finally {
            await fh.close();
          }
          watchLogOffset = fileSize;
          watchLogPath = logPath;
          watchLogFileId = fileId;

          const newLines = newContent.split('\n').filter(l => l.length > 0);
          return {
            ...logFileInfo(resolved),
            isBaseline: false,
            newLines: newLines.length,
            content: newContent.trimEnd(),
            ...(skippedBytes > 0
              ? {
                  truncated: true,
                  skippedBytes,
                  message: `Output truncated: skipped ${skippedBytes} earlier bytes, showing the last ${WATCH_LOG_MAX_BYTES} bytes. Use read_log for the full log.`,
                }
              : {}),
          };
        });
        break;
      }

      case "run_test_script":
        if (!args.script) {
          throw new Error("Script name or path is required");
        }
        result = await runTestScript(args.script, unityClient);
        break;

      case "execute_script": {
        if (!args.path) {
          throw new Error("Script path is required");
        }
        const scriptData = await readScriptSource(args.path);
        result = await unityClient.sendCommand("execute_script", {
          source: scriptData.source,
          name: scriptData.name,
          args: args.args || {},
        });
        break;
      }

      case "compile_script": {
        if (!args.path) {
          throw new Error("Script path is required");
        }
        const compileData = await readScriptSource(args.path);
        result = await unityClient.sendCommand("compile_script", {
          source: compileData.source,
          name: compileData.name,
        });
        break;
      }

      case "list_scripts":
        result = await listCSharpScripts();
        break;

      case "unload_script":
        if (!args.name) {
          throw new Error("Script name is required");
        }
        result = await unityClient.sendCommand("unload_script", {
          name: args.name,
        });
        break;

      case "launch_game": {
        let gameRunning = false;
        try {
          unityClient.disconnect();
          await unityClient.connect();
          await unityClient.sendCommand("ping", {});
          gameRunning = true;
        } catch {
          gameRunning = false;
        }

        if (gameRunning && !args.restart) {
          result = {
            success: true,
            alreadyRunning: true,
            message: "Game is already running. Use restart: true to stop and relaunch.",
          };
          break;
        }

        if (!gameRunning && !args.restart && (await isGameRunning()) === true) {
          result = {
            success: false,
            alreadyRunning: true,
            message:
              "A Broforce process is running but the Unity Inspector Mod is not responding on TCP. " +
              "The mod may have failed to load. Use restart: true to stop and relaunch.",
          };
          break;
        }

        if (args.restart && (gameRunning || (await isGameRunning()) === true)) {
          unityClient.disconnect();
          const killResult = await killGame();
          console.error(`launch_game: ${killResult.detail}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        let extraArgs;
        try {
          extraArgs = composeExtraLaunchArgs(args);
        } catch (err) {
          throw new Error(`Invalid launchArgs: ${err.message}`);
        }

        let launch;
        try {
          launch = resolveLaunchCommand(extraArgs);
        } catch (err) {
          throw new Error(
            `${err.message}. BROFORCE_LAUNCH_CMD should hold the command that starts Broforce on this machine.`
          );
        }

        try {
          await spawnDetached(launch.command, launch.args);
        } catch (err) {
          throw new Error(
            `Failed to launch Broforce with \`${launch.display}\`: ${err.message}. ` +
            `Set the BROFORCE_LAUNCH_CMD environment variable to the command that starts the game on this machine.`
          );
        }

        const ignoredArgsNote = launch.ignoredArgs?.length
          ? `Ignored launch arguments ${launch.ignoredArgs.join(' ')} — the Steam protocol launch does not accept them. Set BROFORCE_LAUNCH_CMD to use a launcher that does.`
          : null;

        const poll = await pollUntilResponsive(60000, 3000);
        result = poll.success
          ? {
              success: true,
              launchCommand: launch.display,
              message: `Game ${args.restart ? 'restarted' : 'launched'} and ready (${poll.attempts} attempts, ${poll.elapsed}s)`,
              ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
            }
          : {
              success: false,
              launchCommand: launch.display,
              state: poll.state,
              message: poll.state === "no-process"
                ? `Ran \`${launch.display}\` but no Broforce process is running after ${poll.elapsed}s (${poll.attempts} attempts) — the launch command exited without leaving a game running. Check that BROFORCE_LAUNCH_CMD starts the game on this machine.`
                : `Game launched with \`${launch.display}\` but never answered — ${poll.message}`,
              lastError: poll.lastError,
              attempts: poll.attempts,
              ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
            };
        break;
      }

      case "stop_game": {
        unityClient.disconnect();
        const killResult = await killGame();
        result = {
          success: killResult.killed,
          message: killResult.detail,
          ...(killResult.unknown ? { unknown: true } : {}),
        };
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error(`Tool error: ${error.message}`);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
}

server.setRequestHandler(CallToolRequestSchema, handleToolCall);

// MCP Resource: C# Script Library Catalog
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "scripts://csharp/catalog",
        name: "C# Script Library",
        description: "Available C# scripts for Unity runtime execution",
        mimeType: "text/plain",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "scripts://csharp/catalog") {
    const catalog = await buildScriptCatalog();
    return {
      contents: [
        {
          uri: "scripts://csharp/catalog",
          text: catalog,
          mimeType: "text/plain",
        },
      ],
    };
  }
  throw new Error(`Unknown resource: ${request.params.uri}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Cleanup on exit
process.on('SIGINT', () => {
  console.error('Shutting down Unity Inspector MCP server...');
  unityClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  unityClient.disconnect();
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Unity Inspector MCP server running on stdio");
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;

if (invokedDirectly) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}