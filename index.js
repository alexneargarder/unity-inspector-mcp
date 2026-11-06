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

import { COMMAND_CANCELLED, COMMAND_TIMEOUT, HANDSHAKE_TIMEOUT, UNITY_PRODUCT_DIR, UnityInspectorClient, cancelledError, defaultPort, isHandshakeRefusal, simulateInputProblem, tokenSearchIn, toolCommand, unityDataDirs } from './lib/unity-client.js';
import { captureCommandHelp, parseStatStartTicks, composeExtraLaunchArgs, detectActiveProfile, forgetCommandHelp, gameBuild, gameStartTime, instanceModeChecked, instanceProbeFailure, invalidateGameProcessScan, isGameRunning, isWsl, killGame, listInstances, ownedGameProcesses, probeInstanceMode, readValidatedPidfile, removeInstance, resolveLaunchCommand, runCommandCapture, spawnDetached, userGameOutOfReach } from './lib/game-process.js';
import { NO_INSTANCE_REASONS, instanceConfig, launcherConfig, steamConfig, withRoot } from './lib/instance.js';
import { LAUNCH_REFUSED, preflightSteamLaunch, prepareSteamLaunch } from './lib/steam-launch.js';
import { tokenizeCommand } from './lib/command-line.js';
import { CAPTURE_FILE, CAPTURE_STATES_DIR, DEFAULT_SETTLE_MS, DEFAULT_STATES_PATH, DEFAULT_SWAP_SETTLE_MS, DEFAULT_SWAP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, REPORT_FILE, STATES_COPY_NAME, claimLeaseMs, formatLogTail, isAbsoluteGamePath, outDirProblem, parseLevel, releaseClaim, runCapture, teardownGame } from './lib/animation-capture.js';
import {
  argumentTypeProblems,
  buildScriptCatalog,
  compactTestScriptReply,
  listCSharpScripts,
  listTestScripts,
  readScriptSource,
  loadedScriptName,
  runTestScript,
  unknownArgumentsProblem,
  withoutNullArguments,
} from './lib/script-library.js';
import { START_TIME_TOLERANCE_MS, fileIdOf, isPlayerLogName, linesBackward, readGuard, sameLogRun, sameRun } from './lib/log-delta.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NEW_LINES_MAX_BYTES = 64 * 1024;
const READ_LOG_MAX_BYTES = 64 * 1024;
const LAUNCH_LOG_TAIL_LINES = 20;
const LAUNCH_STDERR_LIMIT_BYTES = 4096;
const LAUNCH_LOG_TAIL_BYTES = 64 * 1024;
// The launcher prefixes its own lines with a timestamp; the game's stdout lands in the same file
const LAUNCH_LOG_LINE_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /;
const LAUNCH_POLL_TIMEOUT_MS = 60000;
// The launcher waits on the pid, the window, the audio sink and then the port before it gives up
const INSTANCE_LAUNCH_POLL_TIMEOUT_MS = 180000;
// A vanilla launch has nothing to poll, so the launch command's own exit is the only verdict
const VANILLA_EXIT_WAIT_MS = 45000;

// The launcher refuses at its instance cap with this exit status and nothing else
const INSTANCE_CAP_EXIT = 75;
const PORT_FILE_POLL_MS = 250;
// How often a first launch looks for the directory the launcher is creating, to claim the id in it
const OWNER_CLAIM_POLL_MS = 100;
// The probe's 5s and this together stay inside the 15s a replaced server's wrapper waits before it
// stops the game, which is the window a reconnecting server has to claim the id back in
const ROOT_DISCOVERY_TIMEOUT_MS = 4000;
// A launcher that could not answer once is asked again rather than written off for the process's
// life: until it answers, the user's game cannot be told from another session's instance
const LAUNCHER_RETRY_MS = 15000;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function throwIfCancelled(signal, what) {
  if (signal?.aborted) throw cancelledError(what);
}

async function within(promise, ms, signal = null, fallback = undefined) {
  let expire;
  const expired = new Promise((resolve) => { expire = () => resolve(fallback); });
  const timer = setTimeout(expire, ms);
  // A listener added to a signal already aborted never fires
  if (signal?.aborted) expire();
  signal?.addEventListener('abort', expire, { once: true });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', expire);
  }
}

const pause = (ms, signal = null) => within(new Promise(() => {}), ms, signal);

// Derived on first use, never at import: a test scrubs CLAUDE_SESSION_ID before it asks anything.
// Neither carries a path until the launcher has reported the root every instance path hangs off
let instanceMemo = null;
let userGameMemo = null;
let launcherMemo = null;

export function sessionInstance() {
  return (instanceMemo ??= instanceConfig());
}

// The configured launcher on its own: a session with no instance still asks it where instances live
export function sessionLauncher() {
  return (launcherMemo ??= launcherConfig());
}

// Instances are a Linux arrangement, and off Linux the launcher is asked nothing at all
let serverPlatform = process.platform;

export function setServerPlatform(platform = process.platform) {
  serverPlatform = platform;
  return serverPlatform;
}

function launcherIsUsable() {
  return serverPlatform === 'linux' && sessionLauncher().launchCommand !== null;
}

function refuseUserGameUnderWsl(action) {
  if (!isWsl()) return;
  throw new Error(
    `${action} cannot reach the user's game from WSL: the game runs on Windows, where this server can ` +
    `neither see nor signal its process. Start or stop it on Windows; the server connects to it as it is.`
  );
}

export function userGame() {
  return (userGameMemo ??= steamConfig());
}

// One explicit target, resolved once and changed only by launch_game
let currentTarget = null;
let targetPending = null;
let targetGeneration = 0;

export function activeTarget() {
  return (currentTarget ??= sessionInstance().isAgentInstance ? 'instance' : 'steam');
}

export function activeConfig() {
  return activeTarget() === 'instance' ? sessionInstance() : userGame();
}

export function targetDescription(target = activeTarget()) {
  return target === 'instance' ? `the game of instance ${sessionInstance().id}` : "the user's game";
}

function reportedTarget() {
  return targetPending === null ? activeTarget() : null;
}

function pendingRefusal() {
  return asSentence(
    `This server has no target yet: this session has instance ${sessionInstance().id} of its own, and ` +
    `${targetPending}. Nothing was sent to any game; the launcher is asked again ` +
    `${LAUNCHER_RETRY_MS / 1000}s after its last failure`
  );
}

const boundCalls = [];

function refuseWhileBound(nextTarget) {
  if (boundCalls.length === 0) return;
  throw new Error(
    `Cannot switch to ${targetDescription(nextTarget)} while ${boundCalls.join(', ')} ` +
    `${boundCalls.length === 1 ? 'is' : 'are'} still running on ${reportedTarget() === null ? 'no target' : targetDescription()}: ` +
    `its remaining commands would reach the other game. Wait for ${boundCalls.length === 1 ? 'it' : 'them'} to finish and try again.`
  );
}

let instanceOpTail = Promise.resolve();

function acquireInstanceOp() {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const prior = instanceOpTail;
  instanceOpTail = prior.then(() => held);
  let released = false;
  return prior.then(() => () => {
    if (released) return;
    released = true;
    release();
  });
}

const vanillaGames = new Map();
const targetOf = (config) => (config.isAgentInstance ? 'instance' : 'steam');

async function launchedWithoutMods(config) {
  const target = targetOf(config);
  const record = vanillaGames.get(target);
  if (!record) return false;
  if ((await isGameRunning(config)) === false) {
    vanillaGames.delete(target);
    return false;
  }
  if (record.startMs !== null) {
    const started = await gameStartTime(config);
    if (started !== null && Math.abs(started - record.startMs) > 1000) {
      vanillaGames.delete(target);
      return false;
    }
  }
  return true;
}

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function vanillaMessage(config) {
  return `${capitalized(targetDescription(targetOf(config)))} was launched without mods (vanilla), so no ` +
    `inspector runs in it. Relaunch it with launch_game { restart: true } to drive it.`;
}

// The waits a unit test cannot afford to sit through in real seconds
const launchTiming = {
  probeRetryMs: LAUNCHER_RETRY_MS,
  rootRetryMs: LAUNCHER_RETRY_MS,
  vanillaExitWaitMs: VANILLA_EXIT_WAIT_MS,
  startConfirmMs: 15000,
  startStableMs: 2000,
  startPollMs: 500,
  steamStartMs: 120000,
  // Wine's shutdown gives system processes 2s, then closes within 4s of that stage's start, and Valve's Wine starts that stage at once
  wineserverExitMs: 10000,
  wineserverPollMs: 250,
  capPollMs: 5000,
  capWaitMs: 120000,
  portWaitMs: 10000,
  portReservationMs: 180000,
  instanceBudgetMs: INSTANCE_LAUNCH_POLL_TIMEOUT_MS,
};

export function configureLaunchTiming(overrides = {}) {
  Object.assign(launchTiming, overrides);
  return { ...launchTiming };
}

const R2_PROFILES_SUFFIX = 'r2modmanPlus-local/Broforce/profiles';
const UMM_LOG_IN_PROFILE = 'UMM/Core/Log.txt';
// UMM writes its log beside its own assembly
const DIRECT_INSTALL_LOGS = ['Broforce_Data/Managed/UnityModManager/Log.txt'];
// Unity only settled on Player.log in 2018.3; this game is 2017.4 and writes output_log.txt on Windows
const WINDOWS_PLAYER_LOGS = ['Player.log', 'output_log.txt'];
const STALE_TOLERANCE_MS = START_TIME_TOLERANCE_MS;
const SAME_RUN_WINDOW_MS = 60000;
const ONLY_NEW_BASELINE_LINES = 20;

function r2ProfileRoots() {
  const roots = [path.join(os.homedir(), '.config', R2_PROFILES_SUFFIX)];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, R2_PROFILES_SUFFIX));
  roots.push(path.join(os.homedir(), 'AppData/Roaming', R2_PROFILES_SUFFIX));
  return [...new Set(roots)];
}

async function detectLogPlatform() {
  try {
    await unityClient.detectPlatform();
  } catch (err) {
    console.error(`Game path detection failed while looking for the log: ${err.message}`);
  }
}

async function playerLogPaths() {
  await detectLogPlatform();
  const home = os.homedir();
  const { linux, windows } = await unityDataDirs({
    home,
    protonPrefix: unityClient.protonPrefix,
    wsl: unityClient.platform === 'wsl',
  });
  const paths = linux.map(base => path.join(base, 'Player.log'));
  for (const base of windows) {
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

// UNITY_INSPECTOR_LOG names a log for the user's game; an instance has its own two paths
function logOverride() {
  if (activeConfig().isAgentInstance) return '';
  return (process.env.UNITY_INSPECTOR_LOG || '').trim();
}

async function ummLogSearch() {
  const override = logOverride();
  if (override) return { paths: [override], ummPaths: [], playerPaths: [], displays: [override], override: true };

  const config = activeConfig();
  if (config.isAgentInstance) {
    const paths = [config.playerLog, config.ummLog];
    return { paths, ummPaths: [config.ummLog], playerPaths: [config.playerLog], displays: [...paths], override: false };
  }

  const ummPaths = [];
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
      ummPaths.push(candidate);
      displays.push(candidate);
    }
  }

  await detectLogPlatform();
  if (unityClient.gamePath) {
    for (const relative of DIRECT_INSTALL_LOGS) {
      const candidate = path.join(unityClient.gamePath, relative);
      ummPaths.push(candidate);
      displays.push(candidate);
    }
  }

  const playerPaths = await playerLogPaths();
  displays.push(...playerPaths);

  return {
    paths: [...new Set([...playerPaths, ...ummPaths])],
    ummPaths: [...new Set(ummPaths)],
    playerPaths,
    displays: [...new Set(displays)],
    override: false,
  };
}

let newLinesState = null;
let newLinesQueue = Promise.resolve();

function serializeNewLines(read) {
  const run = newLinesQueue.then(read, read);
  newLinesQueue = run.catch(() => {});
  return run;
}

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

async function preferredLog(playerPaths, ummPaths, liveSince) {
  const player = await newestExisting(playerPaths, liveSince);
  const umm = await newestExisting(ummPaths, liveSince);
  if (!player || !umm) return player ?? umm;
  // Player.log gets every UMM line the moment it is logged, and Unity's own output besides
  return liveSince === null && umm.mtimeMs - player.mtimeMs > SAME_RUN_WINDOW_MS ? umm : player;
}

async function stuckLog(stickTo, paths, started, liveSince) {
  if (!stickTo?.path || !paths.includes(stickTo.path) || !sameRun(stickTo.started, started)) return null;
  const stat = await statLogFile(stickTo.path);
  if (!stat || (liveSince !== null && stat.mtimeMs < liveSince)) return null;
  return { path: stickTo.path, mtimeMs: stat.mtimeMs };
}

async function selectLogs(detectProfile, startTime, stickTo) {
  const config = activeConfig();
  const search = await ummLogSearch();

  const started = await startTime(config);
  const liveSince = Number.isFinite(started) ? started - STALE_TOLERANCE_MS : null;

  if (search.override) {
    return { config, search, started, liveSince, chosen: await newestExisting(search.paths), ummPaths: [] };
  }

  let ummPaths = search.ummPaths;
  if (!config.isAgentInstance) {
    const profile = await detectProfile(config);
    if (profile) ummPaths = profileLogPaths(profile);
  }

  const chosen = (await stuckLog(stickTo, search.paths, started, liveSince))
    ?? (await preferredLog(search.playerPaths, ummPaths, liveSince))
    ?? (await newestExisting(search.paths));
  return { config, search, started, liveSince, chosen, ummPaths };
}

export async function resolveLogFile(detectProfile = detectActiveProfile, startTime = gameStartTime, { stickTo = null } = {}) {
  const { config, search, started, liveSince, chosen } = await selectLogs(detectProfile, startTime, stickTo);
  if (!chosen) return null;

  const modifiedAt = new Date(chosen.mtimeMs).toISOString();
  if (liveSince !== null && chosen.mtimeMs < liveSince) {
    return {
      ...chosen,
      modifiedAt,
      started,
      stale: true,
      warning:
        `${chosen.path} was last written ${modifiedAt}, before the running game started ` +
        `(${new Date(started).toISOString()}) — the running game is not writing to it. ` +
        (config.isAgentInstance
          ? `Neither of instance ${config.id}'s logs has been written since it started, so its game ` +
            `has logged nothing since.`
          : search.override
            ? `UNITY_INSPECTOR_LOG selected this file; unset it to search for the live log, ` +
              `or repoint it at the log the game is writing.`
            : `No player log this server searches has been written since then either; set ` +
              `UNITY_INSPECTOR_LOG if the live log is somewhere else.`),
    };
  }

  return { ...chosen, modifiedAt, started, stale: false };
}

function tailReply(resolved, kept, available, readerCut) {
  const newest = newestLinesWithin(kept, READ_LOG_MAX_BYTES, available);
  if (readerCut && newest.returned > 0) newest.cut = true;
  return {
    ...logFileInfo(resolved),
    returnedLines: newest.returned,
    content: newest.content,
    ...(newest.dropped > 0 || newest.cut
      ? {
          truncated: true,
          droppedLines: newest.dropped,
          message: readLogTruncation(newest),
        }
      : {}),
  };
}

async function readLogTail(resolved, { count, filter }) {
  if (filter) {
    const wanted = filter.toLowerCase();
    const matches = [];
    let matchBytes = 0;
    let total = 0;
    const handle = await fs.open(resolved.path, 'r');
    try {
      for await (const line of handle.readLines({ crlfDelay: Infinity })) {
        if (!line.toLowerCase().includes(wanted)) continue;
        total++;
        matches.push(line);
        matchBytes += Buffer.byteLength(line) + 1;
        while (matches.length > count || (matches.length > 1 && matchBytes - Buffer.byteLength(matches[0]) - 1 >= READ_LOG_MAX_BYTES)) {
          matchBytes -= Buffer.byteLength(matches.shift()) + 1;
        }
      }
    } finally {
      await handle.close();
    }
    return tailReply(resolved, matches, Math.min(total, count), false);
  }

  const newestFirst = [];
  let keptBytes = 0;
  let full = false;
  let available = 0;
  for await (const line of linesBackward(resolved.path, { maxLineBytes: READ_LOG_MAX_BYTES })) {
    available++;
    const cost = Buffer.byteLength(line.text) + (newestFirst.length > 0 ? 1 : 0);
    if (!full && (newestFirst.length === 0 || keptBytes + cost <= READ_LOG_MAX_BYTES)) {
      newestFirst.push(line);
      keptBytes += cost;
    } else {
      full = true;
    }
    if (available >= count) break;
  }
  return tailReply(resolved, newestFirst.reverse().map(line => line.text), available, newestFirst.at(-1)?.cut === true);
}

async function readRange(filePath, from, to) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const splitLogLines = (buffer) => buffer.toString('utf-8').replace(/\r?\n$/, '').split(/\r?\n/);

async function rememberNewLines(resolved, stat, offset) {
  newLinesState = {
    path: resolved.path,
    fileId: fileIdOf(stat),
    offset,
    guard: await readGuard(resolved.path, offset),
    started: resolved.started ?? null,
  };
}

async function readNewLogLines(resolved, reset) {
  const logPath = resolved.path;
  const stat = await fs.stat(logPath);
  const fileSize = stat.size;

  if (reset) {
    await rememberNewLines(resolved, stat, fileSize);
    return {
      ...logFileInfo(resolved),
      isBaseline: true,
      message: "Position reset to the end of the log",
      fileSize,
    };
  }

  const continuing = newLinesState?.path === logPath
    && (await sameLogRun(logPath, newLinesState, stat, resolved.started ?? null));

  if (!continuing) {
    const from = Math.max(0, fileSize - NEW_LINES_MAX_BYTES);
    const window = await readRange(logPath, from, fileSize);
    let start = 0;
    if (from > 0) {
      const newline = window.indexOf(0x0a);
      start = newline === -1 ? window.length : newline + 1;
    }
    const end = Math.max(start, window.lastIndexOf(0x0a) + 1);
    const lines = end > start ? splitLogLines(window.subarray(start, end)).slice(-ONLY_NEW_BASELINE_LINES) : [];
    await rememberNewLines(resolved, stat, from + end);
    return {
      ...logFileInfo(resolved),
      isBaseline: true,
      newLines: lines.length,
      content: lines.join('\n'),
    };
  }

  let readFrom = newLinesState.offset;
  let skippedBytes = 0;
  if (fileSize - readFrom > NEW_LINES_MAX_BYTES) {
    skippedBytes = fileSize - readFrom - NEW_LINES_MAX_BYTES;
    readFrom = fileSize - NEW_LINES_MAX_BYTES;
  }
  let chunk = await readRange(logPath, readFrom, fileSize);
  let chunkStart = readFrom;
  if (skippedBytes > 0) {
    const newline = chunk.indexOf(0x0a);
    if (newline !== -1) {
      skippedBytes += newline + 1;
      chunk = chunk.subarray(newline + 1);
      chunkStart += newline + 1;
    }
  }

  const lastNewline = chunk.lastIndexOf(0x0a);
  const complete = lastNewline === -1 && chunk.length < NEW_LINES_MAX_BYTES ? Buffer.alloc(0) : chunk.subarray(0, lastNewline === -1 ? chunk.length : lastNewline + 1);
  if (complete.length === 0) {
    return {
      ...logFileInfo(resolved),
      isBaseline: false,
      newLines: 0,
      content: "",
      message: "No new log entries",
    };
  }
  await rememberNewLines(resolved, stat, chunkStart + complete.length);

  const lines = splitLogLines(complete);
  return {
    ...logFileInfo(resolved),
    isBaseline: false,
    newLines: lines.filter(l => l.length > 0).length,
    content: lines.join('\n').trimEnd(),
    ...(skippedBytes > 0
      ? {
          truncated: true,
          skippedBytes,
          message: `Output truncated: skipped ${skippedBytes} earlier bytes, showing the last ${NEW_LINES_MAX_BYTES} bytes. Use read_log without onlyNew, with a filter, to reach the earlier lines.`,
        }
      : {}),
  };
}

async function withResolvedLog(use, options = {}) {
  let resolved = await resolveLogFile(detectActiveProfile, gameStartTime, options);
  if (!resolved) throw await logNotFoundError();

  try {
    return await use(resolved);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    resolved = await resolveLogFile(detectActiveProfile, gameStartTime, options);
    if (!resolved) throw await logNotFoundError();
    return await use(resolved);
  }
}

export function resetPlatformDetection() {
  unityClient.resetDetection();
}

export function logFileInfo(resolved) {
  return {
    path: resolved.path,
    modifiedAt: resolved.modifiedAt,
    ...(resolved.stale ? { stale: true, warning: resolved.warning } : {}),
  };
}

export async function targetLogPaths({ detectProfile = detectActiveProfile, startTime = gameStartTime } = {}) {
  const config = activeConfig();
  if (config.isAgentInstance) return { umm: config.ummLog, player: config.playerLog };

  let selection;
  try {
    selection = await selectLogs(detectProfile, startTime, null);
  } catch {
    return { umm: null, player: null };
  }
  const { search, ummPaths, liveSince, chosen } = selection;
  const newestPlayer = async (paths) => (await newestExisting(paths, liveSince))?.path ?? null;

  const override = logOverride();
  if (override) {
    if (isPlayerLogName(override)) return { umm: null, player: override };
    return { umm: override, player: await newestPlayer(await playerLogPaths()) };
  }

  const pick = async (paths) => (chosen && paths.includes(chosen.path) ? chosen : null)
    ?? (liveSince !== null ? await newestExisting(paths, liveSince) : null)
    ?? (await newestExisting(paths));
  return {
    umm: (await pick(ummPaths))?.path ?? null,
    player: await newestPlayer(search.playerPaths),
  };
}

export async function findLogPath(detectProfile = detectActiveProfile, startTime = gameStartTime) {
  const resolved = await resolveLogFile(detectProfile, startTime);
  return resolved ? resolved.path : null;
}

async function logNotFoundError() {
  const config = activeConfig();
  const { displays, override } = await ummLogSearch();

  if (config.isAgentInstance) {
    return new Error(
      `No log file for instance ${config.id} yet. These two are the only ones this server reads ` +
      `for it:\n  ${displays.join('\n  ')}\n` +
      `They appear once the instance's game has started.`
    );
  }
  if (override) {
    return new Error(`Log file not found: UNITY_INSPECTOR_LOG points at ${displays[0]}, which does not exist.`);
  }
  return new Error(
    `Log file not found. Looked in:\n  ${displays.join('\n  ')}\n` +
    `Set UNITY_INSPECTOR_LOG to the log path if it lives elsewhere.`
  );
}

// Exported for the tests, which check the port and the game config the target left on it
export const unityClient = new UnityInspectorClient();

// Nothing user-facing ever prints a null port
export function noPortMessage(config = activeConfig()) {
  if (vanillaGames.has(targetOf(config))) return vanillaMessage(config);
  return config.isAgentInstance
    ? `No inspector port is known for instance ${config.id} yet — the launcher has not allocated one, ` +
      `or no game of this instance is running. Use launch_game to start it.`
    : 'No inspector port is known for the user\'s game.';
}

export async function readPortFileText(config = sessionInstance()) {
  try {
    return await fs.readFile(config.portFile, 'utf8');
  } catch {
    return null;
  }
}

export async function readInstancePort(config = sessionInstance()) {
  if (!config.isAgentInstance) return null;
  const raw = await readPortFileText(config);
  if (raw === null) return null;
  const port = Number(String(raw).trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

async function fileMtimeMs(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

// The launcher writes the port before the pidfile, so it lands shortly after the launch command
// exits. A file older than the spawn is an earlier run's allocation: the port in it may since have
// gone to another instance, and adopting it would hand this session a stranger's game
async function waitForInstancePort(config, { waitMs = launchTiming.portWaitMs, notBeforeMs = null } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const writtenAt = await fileMtimeMs(config.portFile);
    if (writtenAt !== null && (notBeforeMs === null || writtenAt >= notBeforeMs)) {
      const port = await readInstancePort(config);
      if (port !== null) return port;
    }
    if (Date.now() >= deadline) return null;
    await delay(PORT_FILE_POLL_MS);
  }
}

// A port file outlives the game that recorded it, and the launcher hands the number to whichever
// instance asks next, so the recorded port is only ours while a game of ours is running
export async function instanceOwnsGame(config) {
  try {
    if ((await ownedGameProcesses(config)).length > 0) return true;
  } catch {}
  // Asking who owns the instance never prunes: this runs on every poll attempt, and the launcher's
  // pidfile is written before the game it names has chdir'd into the instance's work directory
  return (await readValidatedPidfile(config)) !== null;
}

// The port the server would talk to right now: the user's game is always on its own, and an
// instance's is its recorded one for as long as a game of ours is running there
export async function targetPort(config = activeConfig()) {
  if (!config.isAgentInstance) return defaultPort();
  const recorded = await readInstancePort(config);
  return recorded !== null && (await instanceOwnsGame(config)) ? recorded : null;
}

function targetTokenSearch(config) {
  if (!config.isAgentInstance) return null;
  return (port) => tokenSearchIn(config.unityDataDir ? [config.unityDataDir] : [], port);
}

function pointClient(port, config) {
  unityClient.pointAt({
    port,
    gameConfig: config,
    noPortMessage: noPortMessage(config),
    tokenSearch: targetTokenSearch(config),
  });
}

export async function pointClientAtTarget() {
  const config = activeConfig();
  let port = await targetPort(config);
  if (await launchedWithoutMods(config)) port = null;
  if (config.isAgentInstance && config.ownerFile && (startupClaimPending || (await instanceOwnsGame(config)))) {
    await claimInstance(config);
  }
  pointClient(port, config);
  return port;
}

const ARGS_HELP_FLAG = '--args-help';
const ARGS_HELP_MAX_BYTES = 1024;
const ARGS_HELP_HEADER = /^\[[^\]]+\]$/;
const ARGS_HELP_LABELS = { '[instance launch]': 'instance', '[plain launch]': 'plain' };

function cutToBytes(text, max) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  // Back off to the start of the character the cut fell inside
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function argsHelpBlock(text) {
  const truncated = Buffer.byteLength(text) > ARGS_HELP_MAX_BYTES;
  return { text: truncated ? cutToBytes(text, ARGS_HELP_MAX_BYTES) : text, truncated };
}

function parseArgsHelp(text) {
  const sections = {};
  let label = 'unlabelled';
  let labelled = false;
  let held = [];
  const close = () => {
    const body = held.join('\n').trim();
    if (label !== null && body !== '' && sections[label] === undefined) sections[label] = argsHelpBlock(body);
    held = [];
  };
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (ARGS_HELP_HEADER.test(line)) {
      if (labelled) close();
      else held = [];
      labelled = true;
      label = ARGS_HELP_LABELS[line] ?? null;
      continue;
    }
    if (label !== null) held.push(raw);
  }
  close();
  return sections;
}

export function launchCommandTokens(env = process.env) {
  const custom = (env.BROFORCE_LAUNCH_CMD || '').trim();
  if (!custom) return null;
  try {
    const tokens = tokenizeCommand(custom);
    return tokens.length > 0 ? tokens : null;
  } catch {
    return null;
  }
}

const ARGS_HELP_GRACE_MS = 1500;
const UNSETTLED = Symbol('still being asked');

const argsHelpCaptures = new Map();
const argsHelpRetries = new Set();
const NOT_ASKED = { background: true, settled: false, value: UNSETTLED, promise: null };

let renderedTail = null;
let announcedTail = null;
let launcherReadiness = { settled: false, value: UNSETTLED, promise: null };
let tailFollowUp = null;

export function resetLaunchHelpCapture() {
  argsHelpCaptures.clear();
  argsHelpRetries.clear();
  renderedTail = null;
  announcedTail = null;
  launcherReadiness = { settled: false, value: UNSETTLED, promise: null };
  tailFollowUp = null;
}

function argsHelpRecord(tokens, { startRetry = true } = {}) {
  if (tokens === null || tokens.length === 0) return null;
  const key = JSON.stringify(tokens);
  const running = argsHelpCaptures.get(key);
  if (running !== undefined) return running;
  if (!startRetry && argsHelpRetries.has(key)) return NOT_ASKED;

  const command = tokens.join(' ');
  const noHelp = { command, sections: {}, unknown: false };
  const record = { background: argsHelpRetries.has(key), settled: false, value: UNSETTLED, promise: null };
  record.promise = (async () => {
    const help = await captureCommandHelp(tokens[0], tokens.slice(1));
    if (help.error !== null || help.code !== 0) return { ...noHelp, unknown: true };
    if (!help.text.includes(ARGS_HELP_FLAG)) return noHelp;

    const printed = await runCommandCapture(tokens[0], [...tokens.slice(1), ARGS_HELP_FLAG]);
    if (printed.error !== null || printed.text === '') return noHelp;

    return { command, sections: parseArgsHelp(printed.text), unknown: false };
  })().catch(() => noHelp).then((capture) => {
    record.settled = true;
    record.value = capture;
    if (capture.unknown) {
      if (argsHelpCaptures.get(key) === record) argsHelpCaptures.delete(key);
      argsHelpRetries.add(key);
      forgetCommandHelp(tokens[0], tokens.slice(1));
    }
    return capture;
  });
  argsHelpCaptures.set(key, record);
  return record;
}

function instanceLauncherTokens() {
  const { launchCommand, leadingArgs } = sessionLauncher();
  return launchCommand === null ? null : [launchCommand, ...leadingArgs];
}

export function startLaunchHelpCapture() {
  return argsHelpRecord(launchCommandTokens())?.promise ?? null;
}

export async function startInstanceHelpCapture() {
  if (!launcherIsUsable()) return null;
  if (!(await instanceTargetReady())) return null;
  return argsHelpRecord(instanceLauncherTokens())?.promise ?? null;
}

function readinessRecord({ refresh }) {
  const readiness = launcherReadiness;
  if (readiness.promise === null && readiness.value !== true && (refresh || readiness.value === UNSETTLED)) {
    readiness.promise = instanceTargetReady().then((ready) => ready, () => false).then((ready) => {
      readiness.settled = true;
      readiness.value = ready;
      readiness.promise = null;
      return ready;
    });
  }
  return readiness;
}

async function settleWithin(record, deadline) {
  const left = deadline - Date.now();
  if (left > 0) await Promise.race([record.promise, delay(left)]);
  return record.value;
}

async function captureWithin(record, deadline) {
  if (record === null) return null;
  if (record.value !== UNSETTLED) return record.value;
  if (record.background || record.promise === null) return UNSETTLED;
  return settleWithin(record, deadline);
}

function argsHelpQuote(block) {
  return "\n```\n" + block.text +
    (block.truncated ? `\n[cut off at ${ARGS_HELP_MAX_BYTES} bytes]` : '') +
    "\n```";
}

function steamArgumentHelp(withSteamFlag) {
  const lead = withSteamFlag ? 'With steam: true ' : '';
  return serverPlatform === 'darwin'
    ? `\n\n${lead}${withSteamFlag ? 'the' : 'The'} Steam protocol launch takes no arguments, so launchArgs are not accepted.`
    : `\n\n${lead}launchArgs follow the Doorstop arguments of Steam's -applaunch; the Steam protocol launch, used only when no Steam executable is found, takes none.`;
}

function renderArgumentHelp(instance, launch) {
  const known = (capture) => capture !== null && capture !== UNSETTLED && !capture.unknown;
  const blockFor = (capture, launchLabel) => capture.sections[launchLabel] ?? capture.sections.unlabelled ?? null;
  const labelled = (capture) => capture.sections.instance !== undefined || capture.sections.plain !== undefined;

  if (instance === null) {
    if (launch === null) {
      return steamArgumentHelp(false);
    }
    if (!known(launch)) return '';
    const block = blockFor(launch, 'plain');
    return block === null
      ? "\n\nThe configured launch command publishes no argument help, so launchArgs pass through to it as given."
      : "\n\nArguments the configured launch command accepts, in its own words:" + argsHelpQuote(block);
  }

  if (known(instance) && instance === launch && !labelled(instance)) {
    const block = blockFor(instance, 'plain');
    return block === null
      ? "\n\nThe configured launcher publishes no argument help, so launchArgs pass through to either launch as given."
      : "\n\nArgument help from the configured launcher, which both launches go through:" + argsHelpQuote(block);
  }

  const instanceBlock = known(instance) ? blockFor(instance, 'instance') : null;
  const forInstance = !known(instance) ? ''
    : instanceBlock === null
      ? "\n\nThe configured instance launcher publishes no argument help, so launchArgs pass through to the instance launch as given."
      : "\n\nArguments the instance launch accepts, in the instance launcher's own words:" + argsHelpQuote(instanceBlock);
  if (launch === null) {
    return forInstance + steamArgumentHelp(true);
  }
  if (!known(launch)) return forInstance;
  const launchBlock = blockFor(launch, 'plain');
  return forInstance + (launchBlock === null
    ? "\n\nWith steam: true the configured launch command publishes no argument help, so launchArgs pass through to it as given."
    : "\n\nArguments the launch command accepts with steam: true, in its own words:" + argsHelpQuote(launchBlock));
}

const LAUNCHER_STILL_ANSWERING =
  "\n\nThe argument help for this launch follows once the configured launcher has answered.";

async function composeTail({ deadline, refresh, startRetry }) {
  const pending = [];
  const readiness = readinessRecord({ refresh });
  const ready = readiness.value === UNSETTLED && readiness.promise !== null
    ? await settleWithin(readiness, deadline)
    : readiness.value;
  if (readiness.promise !== null) pending.push(readiness.promise);
  if (ready === UNSETTLED) return { tail: LAUNCHER_STILL_ANSWERING, pending };

  const instanceRecord = ready === true && launcherIsUsable()
    ? argsHelpRecord(instanceLauncherTokens(), { startRetry })
    : null;
  const launchRecord = argsHelpRecord(launchCommandTokens(), { startRetry });
  const instance = await captureWithin(instanceRecord, deadline);
  const launch = await captureWithin(launchRecord, deadline);
  for (const record of [instanceRecord, launchRecord]) {
    if (record !== null && record.value === UNSETTLED && record.promise !== null) pending.push(record.promise);
  }
  return { tail: renderArgumentHelp(instance, launch), pending };
}

let notifyToolListChanged = () => server.sendToolListChanged();

export function setToolListChangedNotifier(notify) {
  notifyToolListChanged = notify ?? (() => server.sendToolListChanged());
}

function announceTail(tail) {
  if (renderedTail === null || tail === renderedTail || tail === announcedTail) return;
  announcedTail = tail;
  try {
    Promise.resolve(notifyToolListChanged()).catch(() => {});
  } catch {}
}

function scheduleTailFollowUp(pending) {
  if (pending.length === 0 || tailFollowUp !== null) return;
  tailFollowUp = Promise.allSettled(pending).then(async () => {
    tailFollowUp = null;
    const { tail, pending: left } = await composeTail({ deadline: Date.now(), refresh: false, startRetry: false });
    if (left.length === 0) announceTail(tail);
    else scheduleTailFollowUp(left);
  }).catch(() => { tailFollowUp = null; });
}

export async function launchArgumentHelp() {
  const firstListing = renderedTail === null;
  const { tail, pending } = await composeTail({
    deadline: Date.now() + (firstListing ? ARGS_HELP_GRACE_MS : 0),
    refresh: true,
    startRetry: true,
  });
  renderedTail = tail;
  scheduleTailFollowUp(pending);
  return tail;
}

// The launcher is asked once, at startup, and an answer settles what this server serves
let instanceProbe = null;
let probeFailure = null;

export function startInstanceProbe() {
  if (!launcherIsUsable()) return null;

  // A `--help` that could not answer leaves no verdict behind, and is asked again after the
  // cooldown; one that answered and named no instance mode is settled for this process
  if (instanceProbe === null && probeFailure !== null) {
    if (Date.now() - probeFailure.at < launchTiming.probeRetryMs) return Promise.resolve(false);
    probeFailure = null;
  }

  const unanswered = () => {
    if (instanceModeChecked() === null) {
      probeFailure = { at: Date.now() };
      instanceProbe = null;
    }
  };
  instanceProbe ??= probeInstanceMode(sessionLauncher()).then(
    (verdict) => { unanswered(); return verdict; },
    () => { unanswered(); return false; },
  );
  return instanceProbe;
}

export async function instanceModeAvailable() {
  const probe = startInstanceProbe();
  return probe === null ? false : await probe;
}

// Where instances live is the launcher's business: its `instance list --json` header reports
// instancesRoot, and every instance path — and the rule that tells the user's game from another
// session's — is derived from it. Asked once per process, and never before the probe has said this
// launcher has an instance mode at all
let rootDiscovery = null;
// A failure is remembered only for the cooldown: a launcher that could not answer at startup is
// asked again, since until it does the user's game cannot be told from another session's instance
let rootDiscoveryFailure = null;

export async function discoverInstancesRoot() {
  const launcher = sessionLauncher();
  if (!launcherIsUsable()) {
    return {
      instancesRoot: null,
      stageRoot: null,
      reason: serverPlatform === 'linux' ? launcher.reason : NO_INSTANCE_REASONS.notLinux,
    };
  }

  if (rootDiscovery === null && rootDiscoveryFailure !== null) {
    if (Date.now() - rootDiscoveryFailure.at < launchTiming.rootRetryMs) return rootDiscoveryFailure.result;
    rootDiscoveryFailure = null;
  }

  rootDiscovery ??= (async () => {
    const listing = `\`${[launcher.launchCommand, ...launcher.listArgs].join(' ')}\``;
    // Its own budget, well short of the probe's: the two together have to settle inside the
    // takeover poll the wrapper of a replaced server is sitting in
    const summary = await listInstances(launcher, { timeoutMs: ROOT_DISCOVERY_TIMEOUT_MS }).catch(() => null);

    let reason = null;
    if (summary === null) {
      reason = `the configured launcher's ${listing} could not be read, so where it keeps its instances is unknown`;
    } else if (summary.instancesRoot === null || !path.isAbsolute(summary.instancesRoot)) {
      reason = `the configured launcher's ${listing} header reports no absolute instancesRoot, so where it keeps its instances is unknown`;
    }

    if (reason !== null) {
      console.error(sessionInstance().isAgentInstance
        ? `No target for this session's instance yet: ${reason}. It is asked again ${launchTiming.rootRetryMs / 1000}s later.`
        : `The launcher's instances cannot be placed: ${reason}. Serving the user's game, which is not stopped by signal until they can.`);
      const result = { instancesRoot: null, stageRoot: null, reason };
      // Asked again after the cooldown, so a launcher that recovers is not written off for good
      rootDiscoveryFailure = { result, at: Date.now() };
      rootDiscovery = null;
      return result;
    }

    // A stage root that is not an absolute path is no place to hang a stage off, so the session
    // has none at all rather than one resolved against whatever this process's cwd happens to be
    const stageRoot = typeof summary.stageRoot === 'string' && path.isAbsolute(summary.stageRoot)
      ? await canonicalPath(summary.stageRoot)
      : null;
    const instancesRoot = await canonicalPath(summary.instancesRoot);
    const applied = { stageRoot };
    // Assigned into the memos rather than replacing them: a config handed out before the root was
    // known — the client's `gameConfig`, a caller's local — is the same object and gains it too
    Object.assign(sessionInstance(), withRoot(sessionInstance(), instancesRoot, applied));
    // The user's game is every Broforce process outside the instances root, so it takes the same
    // answer even when this session has no instance of its own
    Object.assign(userGame(), withRoot(userGame(), instancesRoot, applied));
    return { instancesRoot, stageRoot, reason: null };
  })();
  return rootDiscovery;
}

async function canonicalPath(target) {
  const rest = [];
  for (let existing = target; ;) {
    try {
      // /proc/<pid>/cwd always reads the resolved path, so a root reported through a symlink would own nothing
      return path.join(await fs.realpath(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

// Asked whenever a launcher is configured, whatever this session's own id says
export async function launcherRootKnown() {
  if (!launcherIsUsable()) return false;
  if (!(await instanceModeAvailable())) return false;
  return (await discoverInstancesRoot()).instancesRoot !== null;
}

function unansweredHelp() {
  const how = instanceProbeFailure();
  return `the configured launcher did not answer \`--help\`${how ? ` (${how})` : ''}`;
}

// Why this server cannot place the launcher's instances, and so cannot tell another session's game
// from the user's. Null when it can, or when there is nothing to tell apart. Asking is also what
// drives the probe's and the discovery's own retries
export async function unplaceableInstancesReason(target = activeTarget()) {
  if (target === 'instance' || !launcherIsUsable()) return null;

  if (!(await instanceModeAvailable())) {
    // Only a clean answer lifts this: a launcher that says it has no instance mode runs none, while
    // one that could not answer has said nothing about the instances it may be running
    if (instanceModeChecked() === false) return null;
    return `${unansweredHelp()}, so whether it runs instances of its own — ` +
      `and where — is unknown (it is asked again ${LAUNCHER_RETRY_MS / 1000}s later)`;
  }

  const { instancesRoot, reason } = await discoverInstancesRoot();
  return instancesRoot === null ? `the instances root is unknown (${reason})` : null;
}

export async function steamKillRefusal() {
  const why = await unplaceableInstancesReason();
  return why === null
    ? null
    : `${why}, so another session's instance game cannot be told from the user's and stopping by ` +
      `process would risk taking it down instead`;
}

// An instance target needs all three: an id of this session's own, a launcher with the mode, and
// the root it keeps its instances under
export async function instanceTargetReady() {
  const known = await launcherRootKnown();
  return known && sessionInstance().isAgentInstance;
}

async function targetPendingReason() {
  if (!launcherIsUsable() || !sessionInstance().isAgentInstance) return null;
  if (!(await instanceModeAvailable())) {
    return instanceModeChecked() === false ? null : `${unansweredHelp()}, so whether it can run that instance is unknown`;
  }
  const { instancesRoot, reason } = await discoverInstancesRoot();
  return instancesRoot === null ? reason : null;
}

let targetResolution = null;

// Resolved before the first command acts on anything, and never flipped again on its own
// A new server process is what re-asks the launcher; the tests reset it to drive both answers
export function resetTargetResolution() {
  targetResolution = null;
  instanceProbe = null;
  probeFailure = null;
  rootDiscovery = null;
  rootDiscoveryFailure = null;
  instanceMemo = null;
  userGameMemo = null;
  launcherMemo = null;
  currentTarget = null;
  targetPending = null;
  targetGeneration++;
  startupClaimPending = false;
  boundCalls.length = 0;
  vanillaGames.clear();
  launcherReadiness = { settled: false, value: UNSETTLED, promise: null };
}

export async function resolveTarget() {
  targetResolution ??= (async () => {
    const generation = targetGeneration;
    const ready = await instanceTargetReady();
    const pending = ready ? null : await targetPendingReason();
    if (generation !== targetGeneration) return reportedTarget();
    if (pending !== null) {
      targetPending = pending;
      targetResolution = null;
      return null;
    }
    targetPending = null;
    currentTarget = ready ? 'instance' : 'steam';
    if (ready) {
      const config = sessionInstance();
      if ((await claimInstance(config)) === null && !(await instanceDirExists(config))) startupClaimPending = true;
    }
    await pointClientAtTarget();
    return currentTarget;
  })();
  return targetResolution;
}

// A server that outlives its wrapper is reparented, and process.ppid read after that names init or a subreaper
const WRAPPER_PID = process.ppid;
let wrapperIdentity = null;

// The wrapper this server runs under, as owner.pid records it: its pid and field 22 of
// /proc/<pid>/stat, so a recycled pid is not mistaken for the wrapper that claimed the instance
export async function ownerIdentity() {
  if (wrapperIdentity !== null) return wrapperIdentity;
  try {
    const stat = await fs.readFile(`/proc/${WRAPPER_PID}/stat`, 'utf8');
    // comm is parenthesised and may hold spaces, so the fields after it are what gets counted
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = afterComm[19];
    if (!/^\d+$/.test(String(startTime))) return null;
    if (process.ppid !== WRAPPER_PID) return null;
    wrapperIdentity = `${WRAPPER_PID} ${startTime}`;
    return wrapperIdentity;
  } catch {
    return null;
  }
}

// Written before the launch command runs and on adopting a running instance: it records only that
// this wrapper owns the id, never that a launch succeeded, so a launch that dies still leaves it owned.
// The claim never creates the directory: the launcher creates a missing instance on its first launch,
// and a directory holding nothing but owner.pid reads to it as an instance that already exists
export async function writeOwnerFile(config = sessionInstance()) {
  if (!config.isAgentInstance || !config.ownerFile) return null;
  if (process.ppid !== WRAPPER_PID && !shutdownClaimGrace) return null;
  if (!(await instanceDirExists(config))) return null;
  const line = await ownerIdentity();
  if (line === null) return null;
  try {
    await writeFileAtomic(config.ownerFile, `${line}\n`);
  } catch {
    return null;
  }
  startupClaimPending = false;
  await recordOwnerClaim(config.ownerFile);
  return line;
}

let startupClaimPending = false;
let shutdownClaimGrace = false;

async function writeFileAtomic(file, text, options = {}) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, text, options);
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

async function claimMayBeReplaced(current, ours) {
  const recorded = /^(\d+) (\d+)$/.exec(current);
  if (!recorded) return true;
  let liveStart = null;
  try {
    liveStart = parseStatStartTicks(await fs.readFile(`/proc/${recorded[1]}/stat`, 'utf8'));
  } catch {}
  if (liveStart === null || String(liveStart) !== recorded[2]) return true;
  return Number(recorded[2]) < Number(ours.split(' ')[1]);
}

export async function claimInstance(config = sessionInstance()) {
  if (!config.isAgentInstance || !config.ownerFile) return null;
  const line = await ownerIdentity();
  if (line === null) return null;
  let current = null;
  try {
    current = (await fs.readFile(config.ownerFile, 'utf8')).trim();
  } catch {}
  if (current === line) {
    startupClaimPending = false;
    return line;
  }
  if (current !== null && !(await claimMayBeReplaced(current, line))) return null;
  return writeOwnerFile(config);
}

// The wrapper hardcodes no instances root and never asks the launcher for one, so the server tells
// it where it wrote owner.pid: one line, the absolute path, in the file the wrapper named
function claimFile() {
  return (process.env.UNITY_INSPECTOR_MCP_CLAIM_FILE || '').trim();
}

async function recordOwnerClaim(ownerFile) {
  const file = claimFile();
  if (!file) return;
  try {
    await writeFileAtomic(file, `${ownerFile}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`Could not record the instance claim in ${file}: ${err.message}`);
  }
}

export async function instanceDirExists(config = sessionInstance()) {
  try {
    return (await fs.stat(config.root)).isDirectory();
  } catch {
    return false;
  }
}

let creationWatch = null;

export async function claimInstanceWhenCreated(config, launchEnded) {
  if (!config.isAgentInstance) return null;
  creationWatch = config;
  try {
    return await watchForCreation(config, launchEnded);
  } finally {
    if (creationWatch === config) creationWatch = null;
  }
}

async function watchForCreation(config, launchEnded) {
  let running = true;
  const ended = Promise.resolve(launchEnded).then(() => { running = false; }, () => { running = false; });
  for (;;) {
    if (await instanceDirExists(config)) return await claimInstance(config);
    if (!running) return null;
    let timer;
    await Promise.race([
      new Promise(resolve => { timer = setTimeout(resolve, OWNER_CLAIM_POLL_MS); }),
      ended,
    ]);
    clearTimeout(timer);
  }
}

export async function removeOwnerFile(config = sessionInstance()) {
  if (!config.isAgentInstance || !config.ownerFile) return false;
  try {
    await fs.rm(config.ownerFile, { force: true });
  } catch {
    return false;
  }
  const file = claimFile();
  if (file) {
    try {
      await fs.rm(file, { force: true });
    } catch {}
  }
  return true;
}

// A server started while its own instance is already running serves it rather than waiting to be told,
// and claims the id as it does, so the wrapper it belongs to is the one that stops the game
export async function adoptRunningInstance() {
  if (!sessionInstance().isAgentInstance) return null;
  return await pointClientAtTarget();
}

export async function setTarget(next) {
  if (next !== 'instance' && next !== 'steam') throw new Error(`Unknown target: ${next}`);
  const changed = targetPending !== null || next !== activeTarget();
  currentTarget = next;
  targetPending = null;
  targetGeneration++;
  // An explicit target is the resolution: the startup probe must not put the old one back
  targetResolution = Promise.resolve(next);
  if (changed) unityClient.disconnect('The server switched to another game before this command was answered');
  return { changed, port: await pointClientAtTarget() };
}

function snapshotTarget() {
  return { currentTarget, targetPending, targetResolution };
}

async function restoreTarget(snapshot) {
  if (snapshot.currentTarget === currentTarget && snapshot.targetPending === targetPending) return;
  currentTarget = snapshot.currentTarget;
  targetPending = snapshot.targetPending;
  targetResolution = snapshot.targetResolution;
  targetGeneration++;
  unityClient.disconnect();
  if (targetPending === null && currentTarget !== null) await pointClientAtTarget();
}

async function runningInstanceReport() {
  if (!(await launcherRootKnown())) return null;
  const summary = await listInstances(sessionLauncher());
  return summary ? summary.running : null;
}

export async function instanceField() {
  // Driven before anything is reported, and whatever this session's own id says: the probe and the
  // discovery carry their own retries, and a session with no instance of its own still needs the
  // root to tell the user's game from another session's
  await launcherRootKnown();

  const config = sessionInstance();
  if (!config.isAgentInstance) {
    return { instance: null, instanceReason: config.reason };
  }
  if (serverPlatform !== 'linux') {
    return { instance: null, instanceReason: NO_INSTANCE_REASONS.notLinux };
  }
  const verdict = instanceModeChecked();
  if (verdict === false) {
    return { instance: null, instanceReason: 'the configured launcher offers no instance mode' };
  }
  if (verdict === null) {
    return {
      instance: null,
      instanceReason:
        `${unansweredHelp()}, so whether it has an instance mode is ` +
        `unknown (it is asked again ${LAUNCHER_RETRY_MS / 1000}s later)`,
    };
  }
  // The probe has passed, so the root has been asked for: without it there are no paths to report
  const discovered = await discoverInstancesRoot();
  if (discovered.instancesRoot === null) {
    return { instance: null, instanceReason: discovered.reason };
  }
  return {
    instance: {
      id: config.id,
      port: await targetPort(config),
      root: config.root,
      // Where this session stages its own build; null from a launcher whose list header reports
      // no stage root
      stage: config.stagePath,
    },
  };
}

// Every reply that can arrive without a game behind it still says what this server is pointed at
export async function serverStateFields({ withInstanceList = false } = {}) {
  const pending = targetPending !== null;
  const fields = {
    target: reportedTarget(),
    port: pending ? null : await targetPort(),
    ...(await instanceField()),
    logs: pending ? { umm: null, player: null } : await targetLogPaths(),
  };
  if (withInstanceList) {
    const running = await runningInstanceReport();
    if (running) fields.runningInstances = running;
  }
  return fields;
}

const GAME_VERSION_QUERY = 'return VersionNumber.version + " " + VersionNumber.versionDateString;';
const GAME_VERSION_TIMEOUT_MS = 15000;
const gameVersions = new WeakMap();

function runningGameVersion() {
  const socket = unityClient.socket;
  if (!socket || !unityClient.isConnected()) return Promise.resolve(null);
  if (!gameVersions.has(socket)) {
    gameVersions.set(socket, unityClient.sendCommand('execute_code', { code: GAME_VERSION_QUERY }, GAME_VERSION_TIMEOUT_MS)
      .then((reply) => {
        if (reply?.success === false) {
          gameVersions.delete(socket);
          return null;
        }
        const text = typeof reply?.result === 'string' ? reply.result.trim() : '';
        const match = /^(\d+)(?:\s+(.+))?$/.exec(text);
        return match ? { version: Number(match[1]), buildDate: match[2] ?? null } : null;
      }, () => {
        gameVersions.delete(socket);
        return null;
      }));
  }
  return gameVersions.get(socket);
}

async function targetBuild({ answered }) {
  const disk = await gameBuild(activeConfig()).catch(() => null);
  const version = answered ? await runningGameVersion() : null;
  if (disk === null && version === null) return null;
  return {
    store: disk?.store ?? null,
    storeBuild: disk?.storeBuild ?? null,
    gameDir: disk?.gameDir ?? null,
    version: version?.version ?? null,
    buildDate: version?.buildDate ?? null,
  };
}

export const SERVER_CAPABILITIES = {
  tools: { listChanged: true },
  resources: {},
};

const server = new Server(
  {
    name: "unity-inspector-mcp",
    version: "1.0.0",
  },
  { capabilities: SERVER_CAPABILITIES }
);

// Define available tools
export async function buildToolList() {
  return toolDefinitions({ launchHelp: await launchArgumentHelp() });
}

let toolArgumentsMemo = null;

export function toolArguments() {
  toolArgumentsMemo ??= new Map(
    toolDefinitions().map((tool) => [tool.name, tool.inputSchema.properties ?? {}])
  );
  return toolArgumentsMemo;
}

function toolDefinitions({ launchHelp = "" } = {}) {
  return [
      {
        name: "ping",
        description: "Test the connection; 'mainThreadAnswered' false means the game is hung or busy.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_gameobjects",
        description: "Root GameObjects of the loaded scenes, DontDestroyOnLoad included; 'truncatedBy' names a cut.",
        inputSchema: {
          type: "object",
          properties: {
            includeInactive: { type: "boolean", default: true },
            maxResults: { type: "integer", default: 100 },
          },
        },
      },
      {
        name: "inspect_gameobject",
        description: "A GameObject by path or instanceId: at most 100 children ('childrenTruncated'); 'detailed' members cut near 30,000 characters ('truncated').",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "e.g. '/Player'" },
            instanceId: { type: "integer" },
            detailed: { type: "boolean", default: false },
          },
        },
      },
      {
        name: "inspect_component",
        description: "A component's fields and properties, instance and static, and its declared instance methods. 'memberPath' reads one member: a dotted path, numbers indexing lists; a miss answers 'suggestions'.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "GameObject path" },
            instanceId: { type: "integer" },
            componentType: { type: "string" },
            memberPath: {
              type: "string",
              description: "One member instead of the whole component, e.g. 'weapon.damage'",
            },
          },
          required: ["componentType"],
        },
      },
      {
        name: "query_gameobjects",
        description: "Search scene GameObjects by name pattern, component type, or both. componentType matches base types and interfaces, so 'Projectile' finds its subclasses. The reply has resolvedType, scanned, scanTruncated, truncatedBy.",
        inputSchema: {
          type: "object",
          properties: {
            namePattern: { type: "string", description: "* or ? glob, else substring" },
            componentType: { type: "string" },
            includeInactive: { type: "boolean", default: true },
            maxResults: { type: "integer", default: 100 },
          },
        },
      },
      {
        name: "inspect_player",
        description: "Each player slot's bro, position and state",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_enemies",
        description: "Enemies in the loaded level by the game's own classification: enemy vehicles, tank weapons, boss pieces and corpses (isAlive false) included; aliveCount the live ones. Entries: name, type, isMook, position, health, isAlive, plus RocketLib's unitType and category. mapLoaded says a level is loaded; with one, enemySpawnSuppressed/suppressedBy report a live suppressor and enemySpawnPrefixOwners mods that could.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "take_screenshot",
        description: "Screenshot the game; returns the saved path. An optional `highlight` outlines a target for that frame only: the reply has `highlighted` or `highlightError`, and the screenshot succeeds either way.",
        inputSchema: {
          type: "object",
          properties: {
            highlight: {
              type: ["string", "object"],
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
              description:
                "A GameObject path, {instanceId}, or a rectangle in world units, x/y its bottom-left corner. An inactive, boundless or off-camera target is a highlightError.",
            },
          },
        },
      },
      {
        name: "execute_code",
        description: "Run C# in the Unity context: statements, local declarations, and 'return expr;' statements or a trailing expression, whose value comes back. Locals do not persist between calls; use static members for that. Types from a script loaded with execute_script are in scope. The result is resultSet:true with the value in 'result'; success:true, resultSet:false when it ran and returned nothing; or success:false with 'error', plus 'stackTrace', 'position' and 'statement' when the code threw. Code still running after 9s is stopped at its next loop iteration or method call.",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string" },
          },
          required: ["code"],
        },
      },
      {
        name: "modify_component",
        description: "Write a component's fields and properties (public, private, static). 'values' reads each back; 'errors' gives a 'reason': 'not-found' (with 'suggestions'), 'read-only', 'not-kept' or 'error'; 'reverted' is what the game undid by the next frame. 'success' is false when nothing was written.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "GameObject path" },
            instanceId: { type: "integer" },
            component: { type: "string", description: "Component type" },
            properties: {
              type: "object",
              minProperties: 1,
              description: "Properties to write; keys may be dotted paths into nested members, e.g. 'gun.damage'",
            },
          },
          required: ["component", "properties"],
        },
      },
      {
        name: "teleport_player",
        description: "Teleport a player to x, y, zeroing velocity; playerNum -1 lists skipped slots, and `z` is ignored.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            z: { type: "number" },
            playerNum: {
              type: "integer",
              description: "Player index 0-3, or -1 for all active players (default: 0)",
            },
          },
          required: ["x", "y"],
        },
      },
      {
        name: "set_player_health",
        description: "Set a player's health; 0 or less kills the bro and replies `killed`.",
        inputSchema: {
          type: "object",
          properties: {
            health: { type: "integer" },
            playerNum: {
              type: "integer",
              description: "Player index 0-3, or -1 for all active players (default: 0)",
            },
          },
          required: ["health"],
        },
      },
      {
        name: "spawn_entity",
        description: "Spawn a unit at a world position; a level must be loaded. `Baneling` is the theme's mosquito and `Screecher` its baneling; `Bro` is refused — use swap_bro. Success returns `unitType`, `instanceId` and `networked`; a failure returns `error`, with `availableTypes` on an unknown name.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "A RocketLib UnitType, by enum or display name; case, spaces and punctuation are ignored",
            },
            x: { type: "number" },
            y: { type: "number" },
            xI: { type: "number", description: "Initial horizontal velocity", default: 0 },
            yI: { type: "number", description: "Initial vertical velocity, up is positive", default: 0 },
            ignoreSuppression: {
              type: "boolean",
              description: "Lift Utility Mod's disableEnemySpawn for this spawn; reply adds suppressionFound",
            },
          },
          required: ["type", "x", "y"],
        },
      },
      {
        name: "trace_spawns",
        description: "Record the game's spawn calls. `start` patches `targets`, `read` returns records with `seq` > `since` and per-target `dropped`, `stop` unpatches and clears. 512 records per target. Ends when the server reconnects, which `restart_server` always does.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "read", "stop"] },
            targets: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "MapController.SpawnMook_Networked",
                  "MapController.SpawnMook_Local",
                  "ProjectileController.SpawnProjectileOverNetwork",
                  "Map.PlaceDoodad",
                ],
              },
              description: "Default: all but Map.PlaceDoodad",
            },
            since: { type: "integer" },
          },
          required: ["action"],
        },
      },
      {
        name: "set_game_speed",
        description: "Set the time scale, verified a frame later; a scene load or cutscene resets it to 1, and the game's slow motion overrides it.",
        inputSchema: {
          type: "object",
          properties: {
            speed: { type: "number", description: "1.0 is normal" },
          },
          required: ["speed"],
        },
      },
      {
        name: "list_campaigns",
        description: "List the campaigns with their indices",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "go_to_level",
        description: "Go to a campaign level; replies once in play, or once a cutscene holds it (named in `cutscene`), else fails after 60s. An out-of-range campaignIndex is rejected; a levelIndex past the campaign's end loads the Victory map. A `warning` says when enemy-spawn suppression skips its enemies, or that `simulate_input` `start` skips the cutscene.",
        inputSchema: {
          type: "object",
          properties: {
            campaignIndex: { type: "integer", description: "0-25" },
            levelIndex: { type: "integer", description: "0-based" },
          },
          required: ["campaignIndex", "levelIndex"],
        },
      },
      {
        name: "swap_bro",
        description:
          "Swap a player's bro: recalls the current bro and spawns the new one at the same position, failing if the slot does not keep it. Requires Swap Bros Mod, and is refused when it is not active. A name that matches nothing answers `availableBros` plus the full `allNormal`, `allExpendabros` and `allUnfinished` rosters.",
        inputSchema: {
          type: "object",
          properties: {
            broName: { type: "string", description: "e.g. 'Rambro'; see list_bros" },
            playerNum: { type: "integer", description: "Player number 0-3 (default: 0)" },
            ignoreUnlocks: {
              type: "boolean",
              description: "Allow locked bros for this swap, including every installed custom bro, locked or disabled; reply adds ignoredUnlocks",
            },
            nextSpawn: {
              type: "boolean",
              description: "Set the bro the player spawns as next (on death, respawn or the next level) and leave the current one; not with ignoreUnlocks",
            },
          },
          required: ["broName"],
        },
      },
      {
        name: "list_bros",
        description:
          "List the bros swap_bro can use, with currentBro (the bro in the player's slot), selectedBro (Swap Bros Mod's pick) and currentBros (both, per active player). Requires Swap Bros Mod, and is refused when it is not active.",
        inputSchema: {
          type: "object",
          properties: {
            playerNum: { type: "integer", description: "Player number 0-3 (default: 0)" },
          },
        },
      },
      {
        name: "restart_level",
        description:
          "Restart the current level, clearing checkpoints and trigger state; replies once it is in play again, or once a cutscene holds it (named in `cutscene`, with a `warning`).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "simulate_input",
        description: "Simulate input: exactly one of 'action' (press or hold), 'binding' (a key binding, '<mod id>/<binding name>') or 'sequence' (steps). Replies when the plan ends; 'framesRead' counts the frames that read each press, and an unread press fails. 'highFive' is the interact button: it high-fives a prisoner, melees and activates the first switch within 16 units across, 24 up or down. A teleport door in range, a live grenade within 20 units or a citizen within 32 units takes the press first, and a held grenade or mook or a running special blocks it. Only 'player''s controller or binding entry reads it.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "up, down, left, right, fire, jump, special, highFive, gesture, sprint, start or escape",
            },
            binding: { type: "string" },
            sequence: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", description: "Omit for a pure pause" },
                  binding: { type: "string" },
                  duration: { type: "integer", description: "Ms held (default: 50)" },
                  wait: { type: "integer", description: "Ms paused afterwards (default: 0)" },
                },
              },
            },
            duration: { type: "integer", description: "Ms held, per press with count (default: 50)" },
            count: { type: "integer", description: "Number of presses" },
            interval: { type: "integer", description: "Ms between presses (default: 200)" },
            player: { type: "integer" },
          },
          required: [],
        },
      },
      {
        name: "list_test_scripts",
        description: "List the test scripts in scripts/tests/ with the args each declares",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "wait_for_game",
        description: "Poll until the game's inspector answers a ping or the timeout is reached. On failure 'state' names how it failed and 'message' explains it.",
        inputSchema: {
          type: "object",
          properties: {
            timeout: { type: "number", description: "Seconds (default: 60)" },
            interval: { type: "number", description: "Seconds between attempts (default: 3)" },
          },
        },
      },
      {
        name: "game_state",
        description: "The loaded level, game mode, player status and bro type. 'scene' is the Unity scene: every level is the one gameplay scene, and 'isCampaignScene' tells it from the world map, victory screen and cutscenes. The level is 'campaignName' (list_campaigns' 'name'), 'campaignDisplay' (its 'displayName'), 'levelName', 'levelIndex' (0-based) and 'levelNumber' (1-based), all null off a level. Also `target` (`instance`, `steam`, or null until the launcher has answered), `port`, `instance` (else an `instanceReason`), the `logs` read_log uses, and when known `runningInstances` and `build`.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "read_log",
        description: "Read the game's log: Unity's player log, which carries every UMM and mod line and Unity's own errors, else UMM's own log. Returns the last lines, optionally filtered, or with onlyNew the lines written since the last such call. The reply names the file and flags `stale: true` when it predates the running game.",
        inputSchema: {
          type: "object",
          properties: {
            lines: { type: "integer", minimum: 1, description: "Lines from the end of the log (default: 50)" },
            filter: { type: "string", description: "Only lines containing this string, case-insensitive" },
            onlyNew: {
              type: "boolean",
              description: "Only the lines since the last such call; `isBaseline: true` marks the last 20 lines instead, on the first call or when the file changed. Not with lines or filter",
            },
            reset: { type: "boolean", description: "With onlyNew: move the position to the end of the log" },
          },
        },
      },
      {
        name: "run_test_script",
        description: "Run a JSON test script of game commands; server-side tools (read_log, launch_game, ...) cannot be steps. A met 'expect' passes even a failed command. The reply has 'passed', any 'report', 'logs' (new log errors and floods, by source), a short preview per step, and 'resultsFile' with every step's full result. Format: scripts/README.md.",
        inputSchema: {
          type: "object",
          properties: {
            script: { type: "string", description: "Name from scripts/tests/ or absolute path" },
            args: { type: "object", description: "Values for the script's {{name}} placeholders" },
          },
          required: ["script"],
        },
      },
      {
        name: "execute_script",
        description: "Compile and run a C# script file in the Unity runtime; list_scripts lists the library. Supports full class definitions, MonoBehaviours, Harmony patches, and private member access. Scripts can define Main() for execution and Unload() for cleanup. Use ScriptContext for Harmony instances, logging, and arguments.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Library script name or absolute path to a .cs file" },
            args: { type: "object", description: "Passed to the script via ScriptContext.Args" },
            compileOnly: {
              type: "boolean",
              description: "Compile without running; a failure lists compilerErrors. Not with args",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "list_scripts",
        description: "List the C# script library with each script's name, description, tags and arguments.",
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
            name: { type: "string", description: "The script's file name without .cs, or its library name" },
          },
          required: ["name"],
        },
      },
      {
        name: "capture_animations",
        description:
          "Sweep a bro's animation states with the game clock held at zero, optionally loading a level and swapping the bro first: one " +
          "PNG strip per state, `capture.json` (the sprite-sheet cell every frame addressed) and `report.md` (those against the state list), " +
          "all into `out`. The reply carries `status` and the report. Reference: `.claude/rules/animation-capture.md`.",
        inputSchema: {
          type: "object",
          properties: {
            out: { type: "string", description: "Absolute output directory" },
            gameOut: { type: "string", description: "out as the game's filesystem sees it (default: out)" },
            bro: { type: "string", description: "Bro to swap to first, as list_bros names it" },
            level: { type: "string", description: "Level to load first, CAMPAIGN:LEVEL (e.g. 1:0)" },
            states: {
              type: ["array", "string"],
              items: { type: "string" },
              description: "Layered state lists, relative to lib/animation-capture/states/ (default: base-states.json)",
            },
            settle: { type: "number", minimum: 0, description: "Seconds after the level's player spawns (default: 3)" },
            swapSettle: { type: "number", minimum: 0, description: "Seconds after the swap lands (default: 2)" },
            swapTimeout: { type: "number", minimum: 1, description: "Seconds to wait for the swap (default: 15)" },
            timeout: { type: "number", minimum: 1, description: "Seconds per wait, and per state swept (default: 60)" },
            player: { type: "integer", minimum: 0, maximum: 3, description: "(default: 0)" },
            box: { type: "number", minimum: 1, maximum: 256, description: "Crop-box half-size in world units; cells are 2*box px (default: 24)" },
            includeLethal: { type: "boolean", description: "Also sweep states that pin the bro dead (default: false)" },
            allowSideEffects: { type: "boolean", description: "Let animations fire real specials/attacks (default: false)" },
            only: { type: "array", items: { type: "string" }, description: "Only these states, in list order" },
          },
          required: ["out"],
        },
      },
      {
        name: "launch_game",
        description: "Launch Broforce, wait for it to answer and point this server at it: by default this session's game instance (its own profile, saves and port), or the user's game in a session without one. steam: true launches the user's game instead (the configured launch command, else Steam); a window on screen needs that command's placement option. A running game is reported, not launched over, unless restart is true, which stops only the target's game first." + launchHelp,
        inputSchema: {
          type: "object",
          properties: {
            steam: {
              type: "boolean",
              description: "Launch the user's own game instead of this session's instance (default: false)",
            },
            vanilla: {
              type: "boolean",
              description: "Launch without mods (default: false). No inspector loads, so the call returns once the game has started",
            },
            restart: { type: "boolean", description: "Stop the running game first, then relaunch (default: false)" },
            launchArgs: {
              type: "string",
              description: "Arguments appended to the launch this call runs, tokenized with shell-style quoting: the instance launch by default, the configured launch command or Steam's -applaunch with steam: true. The Steam protocol fallback takes no arguments.",
            },
          },
        },
      },
      {
        name: "stop_game",
        description: "Stop the game this server is pointed at, and nothing else: this session's own instance, or the user's game when the server is pointed there.",
        inputSchema: {
          type: "object",
          properties: {
            remove: {
              type: "boolean",
              description: "After stopping, delete this session's instance directory, so the next launch builds it fresh (default: false). Instance target only",
            },
          },
        },
      },
  ];
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await buildToolList() }));

const POLL_DEFAULT_TIMEOUT_MS = 60000;
const POLL_DEFAULT_INTERVAL_MS = 3000;
const POLL_MIN_INTERVAL_MS = 250;
const POLL_PING_TIMEOUT_MS = 6000;
const POLL_PING_FLOOR_MS = 2000;

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

// Refuses a launch that would leave two games on one instance; the launcher makes the same check.
// A listener on the instance's port is nobody's business here: the launcher reallocates a port
// whose listener is not this instance's own game.
export async function instanceLaunchRefusal(config = activeConfig(), { reader, fileSystem } = {}) {
  const pid = await readValidatedPidfile(config, { reader, fileSystem, prune: true });
  if (pid === null) return null;
  return `Instance ${config.id} has a game running (pid ${pid}) that is not answering the inspector. ` +
    `Its mod may have failed to load. Use restart: true to stop and relaunch it.`;
}

// The launch command runs to completion and only its exit status carries a refusal the poll cannot see
export function launcherExitWatcher(child) {
  const watcher = { reason: null };
  let onFailure;
  // A clean exit leaves this pending on purpose: resolving it would make the poll race itself
  watcher.failure = new Promise((resolve) => { onFailure = resolve; });
  watcher.exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      if (signal) watcher.reason = `was killed by ${signal}`;
      else if (code !== 0) watcher.reason = `exited with status ${code}`;
      if (watcher.reason) onFailure();
      resolve({ code, signal });
    });
  });
  return watcher;
}

// spawn() only reports an unrunnable command after the fact, which for a restart is too late
export async function commandIsRunnable(command, platform = process.platform) {
  // Windows has no execute bit and resolves through PATHEXT, so the pre-flight would only guess
  if (platform === 'win32') {
    if (!path.win32.isAbsolute(command)) return true;
    return fs.stat(command).then((stat) => stat.isFile(), () => false);
  }

  const looksLikePath = command.includes('/') || command.includes(path.sep) || command.startsWith('.');
  const candidates = looksLikePath
    ? [path.resolve(command)]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      await fs.access(candidate, fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

// A launcher that refuses before it has created anything says why on stderr and nowhere else
export function collectLauncherStderr(child, limitBytes = LAUNCH_STDERR_LIMIT_BYTES) {
  const box = { text: '' };
  child.stderr?.on('data', (chunk) => { box.text = (box.text + chunk.toString()).slice(-limitBytes); });
  child.stderr?.on('error', () => {});
  return box;
}

export function stderrTail(text) {
  const lines = String(text ?? '').split('\n').map(line => line.trimEnd()).filter(Boolean);
  return lines.length > 0 ? lines.slice(-LAUNCH_LOG_TAIL_LINES).join('\n') : null;
}

// The launch log first, since it is the launcher's own account; its stderr is the fallback. Both
// have to be this launch's: a log left by an earlier run explains nothing about this one
export async function launchFailureTail(config, stderr, notBeforeMs = null) {
  if (!config.isAgentInstance) return '';
  const log = await launchLogTail(config, notBeforeMs);
  if (log) return `\n\nLast lines of ${config.launchLog}:\n${log}`;
  const errors = stderrTail(stderr?.text);
  return errors ? `\n\nLast lines of the launcher's error output:\n${errors}` : '';
}

export async function readFileTail(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    await handle.close();
  }
}

export async function launchLogTail(config = activeConfig(), notBeforeMs = null) {
  if (!config.isAgentInstance) return null;
  if (notBeforeMs !== null) {
    const writtenAt = await fileMtimeMs(config.launchLog);
    if (writtenAt === null || writtenAt < notBeforeMs) return null;
  }
  let text;
  try {
    text = await readFileTail(config.launchLog, LAUNCH_LOG_TAIL_BYTES);
  } catch {
    return null;
  }
  const lines = text.split('\n').filter(line => LAUNCH_LOG_LINE_RE.test(line)).slice(-LAUNCH_LOG_TAIL_LINES);
  return lines.length > 0 ? lines.join('\n') : null;
}

export async function gameStdoutTail(config, sinceMs) {
  if (!config.isAgentInstance) return null;
  const writtenAt = await fileMtimeMs(config.launchLog);
  if (writtenAt === null || writtenAt < sinceMs) return null;
  const lines = [];
  let scanned = 0;
  for await (const line of linesBackward(config.launchLog, { maxLineBytes: 1000 })) {
    if (line.text.trim() && !LAUNCH_LOG_LINE_RE.test(line.text)) lines.unshift(line.text);
    if (lines.length >= LAUNCH_LOG_TAIL_LINES || ++scanned >= 2000) break;
  }
  return lines.length > 0 ? { path: config.launchLog, lines } : null;
}

let resolveLaunch = resolveLaunchCommand;

export function setLaunchResolver(resolver = resolveLaunchCommand) {
  resolveLaunch = resolver;
}

export function vanillaTookEffect(launch) {
  return launch?.vanilla === true;
}

// The launch command's own exit is the instance's verdict: the port it allocated is only readable
// once it has finished, and its exit 75 is the cap refusal
async function waitForLauncherExit(watcher, deadline, signal = null) {
  const exited = await within(watcher.exit, Math.max(0, deadline - Date.now()), signal, null);
  throwIfCancelled(signal, 'launch_game');
  return exited;
}

// The cap wait is its own phase: a freed slot buys a fresh launch, not the leftovers of this budget
async function waitForCapSlot(config, deadline, signal = null) {
  let summary = null;
  let polls = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    // The budget can be spent before this wait ever asks, which is not an answer about the list
    if (remaining <= 0) return { freed: false, summary, polls };
    await pause(Math.min(launchTiming.capPollMs, remaining), signal);
    throwIfCancelled(signal, 'launch_game');
    const next = await listInstances(config);
    throwIfCancelled(signal, 'launch_game');
    polls++;
    // One failed poll is one poll: what an earlier one read is still the best account there is
    if (next) summary = next;
    if (next && next.cap === 0) return { freed: false, summary, polls };
    // An unreadable list is no reason to stop trying: the launcher itself refuses again if it must,
    // and a list reporting no cap is a launcher with no cap to be at
    if (!next || next.cap === null || next.count < next.cap) return { freed: true, summary, polls };
    if (Date.now() >= deadline) return { freed: false, summary, polls };
  }
}

export async function pollUntilResponsive(timeoutMs, intervalMs, watcher = null, { launchedPort = null, launchedPortUntil = Infinity, signal = null } = {}) {
  const { budgetMs: budget, intervalMs: interval } = resolvePollBudget(timeoutMs, intervalMs);

  const startTime = Date.now();
  const deadline = startTime + budget;
  const secondsSoFar = () => Number(((Date.now() - startTime) / 1000).toFixed(1));

  let attempts = 0;
  let lastError = null;
  let lastStage = null;
  let lastTimedOut = false;
  let lastPort = null;

  for (;;) {
    throwIfCancelled(signal, 'The wait for the game');
    attempts++;
    try {
      // The instance's port is re-resolved every attempt: a game that comes up mid-wait is what
      // makes its recorded port ours, and one attempt's answer does not settle the next
      lastPort = await pointClientAtTarget();
      if (lastPort === null && launchedPort !== null && Date.now() < launchedPortUntil) {
        pointClient(launchedPort, activeConfig());
        lastPort = launchedPort;
      }
      if (lastPort === null) {
        lastStage = "port";
        throw new Error(noPortMessage(activeConfig()));
      }
      lastStage = "connect";
      await unityClient.connect();
      lastStage = "ping";
      const pingTimeout = Math.max(POLL_PING_FLOOR_MS, Math.min(deadline - Date.now(), POLL_PING_TIMEOUT_MS));
      const pong = await unityClient.sendCommand("ping", {}, pingTimeout);
      if (pong?.mainThreadAnswered === false) {
        lastStage = "main-thread";
        throw new Error("The game's main thread did not answer the ping's round trip");
      }
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
      throwIfCancelled(signal, 'The wait for the game');
      lastError = err.message;
      console.error(`Attempt ${attempts}: ${err.message}`);
      if (isHandshakeRefusal(err)) {
        const elapsed = secondsSoFar();
        return { success: false, state: "handshake-refused", message: err.message, lastError, attempts, elapsed };
      }
      if (err.stage === "handshake") {
        lastStage = "handshake";
        lastTimedOut = err.code === HANDSHAKE_TIMEOUT;
      } else if (lastStage === "ping") {
        lastTimedOut = err.code === COMMAND_TIMEOUT;
      }
    }

    if (watcher?.reason) break;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await within(watcher?.failure ?? new Promise(() => {}), Math.min(interval, remaining), signal);
    throwIfCancelled(signal, 'The wait for the game');
    if (watcher?.reason || Date.now() >= deadline) break;
  }

  if (watcher?.reason) {
    const elapsed = secondsSoFar();
    return {
      success: false,
      state: "launcher-failed",
      message: `The launcher ${watcher.reason} after ${elapsed}s (${attempts} attempts) without leaving a game that answers`,
      lastError,
      attempts,
      elapsed,
    };
  }

  const running = await isGameRunning(activeConfig());
  const elapsed = secondsSoFar();
  const tail = `after ${elapsed}s (${attempts} attempts)`;
  const answeredStage = lastStage === "ping" || lastStage === "handshake";
  const unanswered = lastStage === "handshake" ? "the connection handshake" : "ping";
  const portLabel = lastPort === null ? 'the inspector port' : `port ${lastPort}`;
  const PortLabel = portLabel.charAt(0).toUpperCase() + portLabel.slice(1);
  let state;
  let message;

  if (lastStage === "port") {
    return {
      success: false,
      state: "no-port",
      message: `${noPortMessage(activeConfig())} (${attempts} attempts, ${elapsed}s)`,
      lastError,
      attempts,
      elapsed,
    };
  }

  if (lastStage === "main-thread") {
    return {
      success: false,
      state: "main-thread-hung",
      message: `${PortLabel} answers, but the game's main thread is not running frames ${tail} — a script or the ` +
        `game itself is stuck, or the game is still starting: ${lastError}`,
      lastError,
      attempts,
      elapsed,
    };
  }

  if (answeredStage && lastTimedOut) {
    state = "connected-unresponsive";
    message = `${PortLabel} accepts connections but ${unanswered} got no reply ${tail} — the mod may be starting or the main thread stalled`;
    if (running === false) {
      message += ` (no Broforce process is detected, so whatever holds that port may not be the game)`;
    }
  } else if (running === false) {
    state = "no-process";
    message = answeredStage
      ? `The connection dropped and no Broforce process is running ${tail} — the game likely died: ${lastError}`
      : `No Broforce process is running ${tail} — use launch_game to start it`;
  } else if (answeredStage) {
    state = "connection-dropped";
    message = `${PortLabel} accepted a connection that was then closed ${tail}: ${lastError}`;
  } else if (running === null) {
    state = "unknown";
    message = `Could not connect to ${portLabel} ${tail}, and process detection is unavailable, so it is unknown whether the game is running.` +
      unityClient.reachHint();
  } else {
    state = "connection-refused";
    message = `The game process is running but nothing accepted a connection on ${portLabel} ${tail} — the mod's TCP server may be stopped or on another port`;
  }

  return { success: false, state, message, lastError, attempts, elapsed };
}

// Handle tool calls
const TARGET_FREE_TOOLS = new Set(['list_scripts', 'list_test_scripts']);

const asSentence = (text) => (/[.!?]$/.test(String(text).trim()) ? String(text).trim() : `${String(text).trim()}.`);

// A capture sweep holds the game for its whole length, the sentinel wait included, during which
// nothing is on the socket at all. The record is what makes it visible: it is set before the sweep
// starts and cleared in a finally, so a sweep that throws releases it on the way out.
let activeSweep = null;
const activeTestScripts = new Set();
let launchesRunning = 0;

const SWEEP_SAFE_TOOLS = new Set([
  'stop_game', 'ping', 'game_state', 'read_log', 'list_scripts', 'list_test_scripts', 'list_campaigns',
  'list_gameobjects', 'inspect_gameobject', 'inspect_component', 'query_gameobjects', 'inspect_player',
  'list_enemies', 'list_bros',
]);

function sweepRefusal(action) {
  const left = Math.max(0, Math.round((activeSweep.deadline - Date.now()) / 1000));
  return new Error(
    `Cannot ${action} while a capture_animations sweep into ${activeSweep.out} is running on the ` +
    `${activeTarget()} target — it holds the game clock at zero and the bro pinned, and anything that changes ` +
    `the game would land in its strips (about ${left}s of its budget left, more while it makes progress). ` +
    `Wait for it to finish, or use stop_game to end it early.`
  );
}

function refuseDuringSweep(name, args) {
  if (!activeSweep || SWEEP_SAFE_TOOLS.has(name)) return;
  if (name === 'take_screenshot' && (args.highlight === undefined || args.highlight === null)) return;
  throw sweepRefusal(name === 'capture_animations' ? 'start an animation capture sweep' : `run ${name}`);
}

// Dropping the socket under a command in flight would answer it from whatever answers next
function refuseWhileInFlight(action) {
  if (activeSweep) throw sweepRefusal(action);

  const inFlight = unityClient.inFlightCommands();
  if (inFlight.length === 0) return;
  throw new Error(
    `Cannot ${action} while ${inFlight.join(', ')} is still in flight on the ${activeTarget()} target — ` +
    `it may disconnect the client. Wait for it to finish and try again.`
  );
}

async function confirmGameStarted(config, { budgetMs = launchTiming.startConfirmMs, watcher = null, signal = null } = {}) {
  const deadline = Date.now() + budgetMs;
  let upSince = null;
  let answered = false;
  for (;;) {
    if (watcher?.reason) return 'failed';
    invalidateGameProcessScan();
    const running = await isGameRunning(config);
    if (running === true) {
      answered = true;
      upSince ??= Date.now();
      if (Date.now() - upSince >= launchTiming.startStableMs) return 'running';
    } else if (running === false) {
      answered = true;
      upSince = null;
    }
    if (Date.now() >= deadline) return upSince !== null ? 'running' : answered ? 'gone' : 'unknown';
    await pause(Math.min(launchTiming.startPollMs, Math.max(0, deadline - Date.now())), signal);
    throwIfCancelled(signal, 'launch_game');
  }
}

function capReachedMessage(config, capReport, capPolls, capStart) {
  if (capReport?.cap === 0) {
    return `The configured launcher allows no instances to run (its cap is 0), so instance ${config.id} was not started.`;
  }
  const holders = capReport?.running?.map(entry => entry.id).join(', ');
  const listIsFull = capReport?.cap !== null && capReport?.cap !== undefined && capReport.count >= capReport.cap;
  // Four endings, and only the first of them knows who holds the slots
  let who;
  if (capReport && listIsFull) {
    who = ` Instances holding the slots: ${holders}.`;
  } else if (capReport) {
    who = ` The launcher's list last showed ` +
      (capReport.count === 0
        ? 'no instances running'
        : `${capReport.count}${capReport.cap !== null ? ` of ${capReport.cap}` : ''} running (${holders})`) +
      `, yet the launcher refused this launch.`;
  } else if (capPolls > 0) {
    who = ` The launcher's instance list could not be read on any attempt, so which instances hold the slots is unknown.`;
  } else {
    who = ` The wait ran out before the launcher's instance list could be checked, so which instances hold the slots is unknown.`;
  }
  const unparsed = capReport?.unparsed > 0
    ? ` ${capReport.unparsed} line${capReport.unparsed === 1 ? '' : 's'} of that list could not be parsed, so the ` +
      `instance${capReport.unparsed === 1 ? ' it describes is' : 's they describe are'} missing from it.`
    : '';
  return `The configured launcher refused this launch at its instance cap${capReport?.cap ? ` of ${capReport.cap}` : ''} ` +
    `and no slot came free in the ${((Date.now() - capStart) / 1000).toFixed(1)}s it was waited for, so instance ` +
    `${config.id} was not started.` + who + unparsed;
}

async function launchGame(args, signal = null) {
  // The probe and the root settle what this session has before the target moves anywhere
  await resolveTarget();
  const hasInstance = await instanceTargetReady();
  const nextTarget = args.steam || !hasInstance ? 'steam' : 'instance';
  const previousTarget = reportedTarget();
  const config = nextTarget === 'instance' ? sessionInstance() : userGame();
  // A launch that meant to start this session's instance and could not has to say why, in the
  // same words game_state gives for it
  const instanceReason = !args.steam && !hasInstance ? (await instanceField()).instanceReason : null;
  if (nextTarget === 'steam') refuseUserGameUnderWsl('launch_game');

  refuseWhileInFlight('launch');
  if (nextTarget !== previousTarget) refuseWhileBound(nextTarget);

  let switchNote = null;
  const withTargetNotes = (payload) => ({
    ...payload,
    target: reportedTarget(),
    ...(switchNote ? { targetNote: switchNote } : {}),
    ...(instanceReason ? { instanceReason } : {}),
  });

  // The user's game is every Broforce process this server cannot place in an instance, so with
  // the launcher's instances unaccounted for it cannot say whether that game is running at
  // all — a stranger's would read as the user's, broken. Asking also drives the retries
  const unplaceable = await unplaceableInstancesReason(nextTarget);
  if (unplaceable !== null) {
    return withTargetNotes({
      success: false,
      state: "root-unknown",
      message: asSentence(
        `Nothing was launched: ${unplaceable}, so this server cannot tell whether ` +
        `${targetDescription(nextTarget)} is running`
      ),
    });
  }

  let requested;
  try {
    requested = composeExtraLaunchArgs(args);
  } catch (err) {
    throw new Error(`Invalid launchArgs: ${err.message}`);
  }

  // Resolving first, so a restart that cannot relaunch has not already stopped the game
  let launch;
  try {
    launch = await resolveLaunch(requested, process.env, process.platform, config);
  } catch (err) {
    if (err.code === LAUNCH_REFUSED) throw err;
    throw new Error(
      `${asSentence(err.message)} BROFORCE_LAUNCH_CMD should hold the command that starts Broforce on this machine.`
    );
  }
  const vanilla = vanillaTookEffect(launch);

  if (args.restart && !(await commandIsRunnable(launch.command))) {
    throw new Error(
      `Cannot run \`${launch.command}\`, so nothing was stopped: ` +
      `point ${config.isAgentInstance ? 'the configured launcher' : 'BROFORCE_LAUNCH_CMD'} at an executable ` +
      `that launches ${targetDescription(nextTarget)}.`
    );
  }

  if (previousTarget !== null && nextTarget !== previousTarget) {
    const previousConfig = previousTarget === 'instance' ? sessionInstance() : userGame();
    if ((await isGameRunning(previousConfig)) === true) {
      switchNote = `${targetDescription(previousTarget)} is still running — switching targets left it alone. ` +
        `Switch back and use stop_game to stop it.`;
    }
  }

  refuseWhileInFlight('launch');
  if (nextTarget !== reportedTarget()) refuseWhileBound(nextTarget);
  const beforeSwitch = snapshotTarget();
  boundCalls.push('launch_game');
  let release = () => {};
  const releaseInstance = () => release();
  try {
    await setTarget(nextTarget);
    if (config.isAgentInstance) release = await acquireInstanceOp();
    return await launchOnTarget({ args, signal, config, nextTarget, launch, vanilla, withTargetNotes, beforeSwitch, releaseInstance });
  } finally {
    releaseInstance();
    boundCalls.splice(boundCalls.indexOf('launch_game'), 1);
  }
}

function likelyCauses(launch, state) {
  const { confirmation, launchOptions } = launch.startCauses ?? {};
  const named = (state === 'no-process' ? [confirmation, launchOptions] : state === 'connection-refused' ? [launchOptions] : []).filter(Boolean);
  return named.length > 0 ? ` Likely causes: ${named.join('; ')}.` : '';
}

async function launchOnTarget({ args, signal, config, nextTarget, launch, vanilla, withTargetNotes, beforeSwitch, releaseInstance }) {
  // On an instance the cwd rule decides whether a game of ours is running: a ping answered by
  // somebody else's game on a port we no longer own must never refuse this launch
  const ownsGame = config.isAgentInstance ? (await isGameRunning(config)) === true : true;
  const withoutMods = await launchedWithoutMods(config);

  let gameRunning = false;
  let refusal = null;
  if (ownsGame && !withoutMods) {
    try {
      await unityClient.sendCommand("ping", {});
      gameRunning = true;
    } catch (err) {
      gameRunning = isHandshakeRefusal(err);
      if (gameRunning) refusal = err.message;
    }
  }

  if (gameRunning && !args.restart) {
    if (config.isAgentInstance) await claimInstance(config);
    return withTargetNotes({
      success: refusal === null,
      alreadyRunning: true,
      ...(refusal === null
        ? { message: `${targetDescription(nextTarget)} is already running. Use restart: true to stop and relaunch.` }
        : {
            state: "handshake-refused",
            message: `${targetDescription(nextTarget)} is already running, but its inspector refused this server's connection: ${refusal}`,
          }),
      // The game this launch would have started is the one already running, so it names it
      // exactly as a launch of its own would
      ...(config.isAgentInstance
        ? {
            instance: { id: config.id, port: unityClient.port },
            logs: { umm: config.ummLog, player: config.playerLog },
          }
        : {}),
    });
  }

  if (withoutMods && !args.restart) {
    if (config.isAgentInstance) await claimInstance(config);
    return withTargetNotes({ success: false, alreadyRunning: true, vanilla: true, message: vanillaMessage(config) });
  }

  if (!gameRunning && !args.restart && config.isAgentInstance) {
    const refusal = await instanceLaunchRefusal(config);
    if (refusal) return withTargetNotes({ success: false, alreadyRunning: true, message: refusal });
  }

  if (!gameRunning && !args.restart && (await isGameRunning(config)) === true) {
    return withTargetNotes({
      success: false,
      alreadyRunning: true,
      message:
        "A Broforce process is running but the Unity Inspector Mod is not responding on TCP. " +
        "The mod may have failed to load. Use restart: true to stop and relaunch.",
    });
  }

  if (!gameRunning && (await isGameRunning(config)) === null) {
    return withTargetNotes({
      success: false,
      state: "unknown",
      message:
        `Nothing was launched or stopped: ${userGameOutOfReach(config) ?? 'process detection is unavailable here'}, so whether ` +
        `${targetDescription(nextTarget)} is running cannot be checked, and its inspector did not answer — ` +
        `a launch could start a second copy beside a game that is already up. Start or stop it yourself, ` +
        `then use wait_for_game.`,
    });
  }

  try {
    await preflightSteamLaunch(launch.prepare);
  } catch (err) {
    await restoreTarget(beforeSwitch);
    throw new Error(`Could not prepare the Steam launch: ${err.message}. Nothing was launched and nothing was stopped.`);
  }

  throwIfCancelled(signal, 'launch_game');
  let stoppedFirst = false;
  if (args.restart && (gameRunning || (await isGameRunning(config)) === true)) {
    stoppedFirst = true;
    unityClient.disconnect('launch_game restarted the game before this command was answered');
    // As in stop_game: the refusal check can settle the root, and the kill takes the config
    // that leaves behind
    const signalRefusal = await steamKillRefusal();
    const killResult = await killGame({ config: activeConfig(), signalRefusal });
    console.error(`launch_game: ${killResult.detail}`);

    const survivors = killResult.survivors ?? [];
    if (killResult.unknown || survivors.length > 0) {
      return withTargetNotes({
        success: false,
        state: "stop-failed",
        message: asSentence(
          `${targetDescription(nextTarget)} could not be stopped, so nothing was launched: ${killResult.detail}`
        ) + (survivors.length > 0 ? ` Stop pid ${survivors.join(', ')} by hand and try again.` : ''),
        ...(survivors.length > 0 ? { survivors } : {}),
      });
    }
    throwIfCancelled(signal, 'launch_game');
  }
  vanillaGames.delete(nextTarget);

  // The instance id is claimed before its launcher runs, so a launch that never finishes still
  // leaves the wrapper that asked for it responsible for stopping the game. A first launch has
  // no directory to claim in — the launcher is the one that creates it — and the claim follows
  // it there rather than creating it, which would leave the launcher nothing to create
  let claimed = false;
  if (config.isAgentInstance) claimed = (await claimInstance(config)) !== null;

  let launcherStderr = null;
  let spawnedAt = null;
  let exitedAt = null;
  let spawned = 0;
  const spawnLauncher = async () => {
    try {
      spawnedAt = Date.now();
      // The Steam client and the game would inherit a pipe and fill it with their own chatter
      const child = await spawnDetached(launch.command, launch.args, {
        captureStderr: config.isAgentInstance,
      });
      if (config.isAgentInstance) launcherStderr = collectLauncherStderr(child);
      spawned++;
      return child;
    } catch (err) {
      if (spawned === 0) await restoreTarget(beforeSwitch);
      throw new Error(
        `Failed to launch Broforce with \`${launch.display}\`: ${err.message}. ` +
        (config.isAgentInstance
          ? `The configured launcher's instance mode is what starts instance ${config.id}.`
          : `Set the BROFORCE_LAUNCH_CMD environment variable to the command that starts the game on this machine.`)
      );
    }
  };

  const noteParts = launch.ignoredArgs?.length
    ? [`Ignored launch arguments ${launch.ignoredArgs.join(' ')} — ${launch.ignoredReason}`]
    : [];
  try {
    noteParts.push(...await prepareSteamLaunch(launch.prepare, {
      waitMs: launchTiming.wineserverExitMs,
      pollMs: launchTiming.wineserverPollMs,
      sleep: (ms) => pause(ms, signal),
      signal,
    }));
  } catch (err) {
    if (err.code === COMMAND_CANCELLED) throw err;
    await restoreTarget(beforeSwitch);
    throw new Error(
      `Could not write the Proton override: ${err.message}. ` +
      (stoppedFirst ? `The running game had already been stopped, and nothing was launched.` : `Nothing was launched.`)
    );
  }
  const ignoredArgsNote = noteParts.length > 0 ? noteParts.join(' ') : null;

  let watcher = launcherExitWatcher(await spawnLauncher());
  // The port this launch's launcher allocated, which the wait may use before its game is up
  let launchedPort = null;
  let launchedPortUntil = -Infinity;

  // Waiting the launcher out is what carries an instance launch's verdict, and it is also the
  // window a first launch has to claim the id in: the watch ends with the launch command
  const waitOutLauncher = async () => {
    const wait = waitForLauncherExit(watcher, Date.now() + launchTiming.instanceBudgetMs, signal);
    const claim = claimed ? null : claimInstanceWhenCreated(config, wait);
    const exited = await wait;
    if (exited) exitedAt = Date.now();
    if (claim) claimed = (await claim) !== null;
    return exited;
  };

  // An instance launch is waited out: its port is only readable once the launcher has finished,
  // and only its exit status carries the cap refusal. A vanilla launch is waited out the same
  // way, under the same budget and cap rules; only the port and the inspector are skipped
  let launcherExited = null;
  if (config.isAgentInstance) {
    let exited = await waitOutLauncher();
    let capExpired = false;
    let capStart = null;
    let capDeadline = null;
    // The last list anyone could read, and whether the list was ever asked at all: the wait
    // that happens to end the loop says nothing about the polls that came before it
    let capReport = null;
    let capPolls = 0;

    while (exited && exited.code === INSTANCE_CAP_EXIT) {
      // The wait starts when the launcher first says the cap is full, not before it ran
      if (capDeadline === null) {
        capStart = Date.now();
        capDeadline = capStart + launchTiming.capWaitMs;
      }
      const slot = await waitForCapSlot(config, capDeadline, signal);
      capPolls += slot.polls;
      if (slot.summary) capReport = slot.summary;
      if (!slot.freed) {
        capExpired = true;
        break;
      }
      throwIfCancelled(signal, 'launch_game');
      watcher = launcherExitWatcher(await spawnLauncher());
      exited = await waitOutLauncher();
    }
    releaseInstance();

    if (capExpired || (exited && exited.code === INSTANCE_CAP_EXIT)) {
      return withTargetNotes({
        success: false,
        launchCommand: launch.display,
        state: "cap-reached",
        message: capReachedMessage(config, capReport, capPolls, capStart ?? Date.now()),
        ...(capReport?.running ? { runningInstances: capReport.running } : {}),
        ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
      });
    }

    launcherExited = exited;

    if (!watcher.reason && !vanilla) {
      // Only a port file this launch wrote is this launch's allocation
      launchedPort = await waitForInstancePort(config, { notBeforeMs: spawnedAt });
      throwIfCancelled(signal, 'launch_game');
      if (launchedPort === null) {
        const writtenAt = await fileMtimeMs(config.portFile);
        let about;
        if (writtenAt === null) {
          about = `no inspector port has been written to ${config.portFile}`;
        } else if (writtenAt >= spawnedAt) {
          const contents = String(await readPortFileText(config) ?? '').trim();
          about = `the port file at ${config.portFile} written by this launch does not hold a ` +
            `usable port: '${contents.slice(0, 40)}'`;
        } else {
          // A port file this launch did not write is an earlier run's allocation, which the
          // launcher may since have handed to another instance
          about = `the port file at ${config.portFile} is an earlier run's allocation, written ` +
            `${((spawnedAt - writtenAt) / 1000).toFixed(1)}s before this launch started ` +
            `(${new Date(writtenAt).toISOString()})`;
        }
        // A launcher still running has not failed to write the port; it has not got there yet
        const what = exited === null
          ? `\`${launch.display}\` was still running after ${launchTiming.instanceBudgetMs / 1000}s and was ` +
            `left to finish, and ${about}`
          : `\`${launch.display}\` finished after ${((exitedAt - spawnedAt) / 1000).toFixed(1)}s and ${about}`;
        return withTargetNotes({
          success: false,
          launchCommand: launch.display,
          state: "no-port",
          message: `${what}, so there is nothing to connect to.`
            + (await launchFailureTail(config, launcherStderr, spawnedAt)),
          ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
        });
      }
      launchedPortUntil = Math.floor((await fileMtimeMs(config.portFile)) ?? Date.now()) + launchTiming.portReservationMs;
      pointClient(launchedPort, config);
      // The next command re-checks ownership, and a scan from before the launch would deny it
      invalidateGameProcessScan();
    }
  }

  if (vanilla) return vanillaOutcome({ signal, config, nextTarget, launch, watcher, launcherExited, launcherStderr, spawnedAt, ignoredArgsNote, withTargetNotes });

  const poll = await pollUntilResponsive(
    config.isAgentInstance
      ? launchTiming.instanceBudgetMs
      : launch.waitsOnExit ? LAUNCH_POLL_TIMEOUT_MS : launchTiming.steamStartMs,
    3000,
    // A launch command that hands off and exits cleanly says nothing; a failing one ends the wait
    watcher,
    { launchedPort, launchedPortUntil, signal },
  );
  if (poll.success) {
    const running = config.isAgentInstance ? await runningInstanceReport() : null;
    return withTargetNotes({
      success: true,
      launchCommand: launch.display,
      message: `Game ${stoppedFirst ? 'restarted' : 'launched'} and ready (${poll.attempts} attempts, ${poll.elapsed}s)`,
      ...(config.isAgentInstance
        ? {
            instance: { id: config.id, port: unityClient.port },
            logs: { umm: config.ummLog, player: config.playerLog },
            ...(running ? { runningInstances: running } : {}),
          }
        : {}),
      ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
    });
  }

  const tail = await launchFailureTail(config, launcherStderr, spawnedAt);
  return withTargetNotes({
    success: false,
    launchCommand: launch.display,
    state: poll.state,
    message: (poll.state === "launcher-failed"
      ? `\`${launch.display}\` failed: ${poll.message}.`
      : poll.state === "no-process"
        ? `Ran \`${launch.display}\` but no Broforce process is running after ${poll.elapsed}s (${poll.attempts} attempts)` +
          (launch.waitsOnExit ? ` — the launch command exited without leaving a game running.` : `.`)
        : poll.state === "handshake-refused"
          ? `Game launched with \`${launch.display}\`, but its inspector refused this server's connection: ${poll.message}`
          : `${asSentence(`Game launched with \`${launch.display}\` but never answered — ${poll.message}`)} ` +
            `It may still be starting: call wait_for_game to keep waiting for it.`) + likelyCauses(launch, poll.state) + tail,
    lastError: poll.lastError,
    attempts: poll.attempts,
    ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
  });
}

async function vanillaOutcome({ signal, config, nextTarget, launch, watcher, launcherExited, launcherStderr, spawnedAt, ignoredArgsNote, withTargetNotes }) {
  const label = config.isAgentInstance ? `instance ${config.id}` : 'Broforce';
  const noInspector = `Started ${label} without mods, so the Unity Inspector Mod is not loaded and nothing will ` +
    `answer on the inspector port. Relaunch without vanilla to drive it.`;
  const note = ignoredArgsNote ? { note: ignoredArgsNote } : {};

  // An instance has already been waited out under its own budget; waiting again would only
  // add a second budget to a launcher that was left running
  const vanillaBudgetMs = config.isAgentInstance
    ? launchTiming.instanceBudgetMs
    : launchTiming.vanillaExitWaitMs;
  let finished = launcherExited !== null;
  if (!config.isAgentInstance && launch.waitsOnExit) {
    finished = await within(watcher.exit.then(() => true), vanillaBudgetMs, signal, false);
    throwIfCancelled(signal, 'launch_game');
  }

  const launcherFailed = async () => withTargetNotes({
    success: false,
    launchCommand: launch.display,
    vanilla: true,
    state: "launcher-failed",
    message: `\`${launch.display}\` failed: the launch command ${watcher.reason}.` +
      (await launchFailureTail(config, launcherStderr, spawnedAt)),
    ...note,
  });
  if (watcher.reason) return launcherFailed();

  const how = !launch.waitsOnExit
    ? `Ran \`${launch.display}\``
    : finished
      ? `\`${launch.display}\` exited cleanly`
      : `\`${launch.display}\` was still running after ${vanillaBudgetMs / 1000}s and was left to finish`;
  const confirmMs = launch.waitsOnExit ? launchTiming.startConfirmMs : launchTiming.steamStartMs;
  const started = await confirmGameStarted(config, { budgetMs: confirmMs, watcher, signal });
  if (watcher.reason) return launcherFailed();
  if (started === 'gone') {
    return withTargetNotes({
      success: false,
      launchCommand: launch.display,
      vanilla: true,
      state: "no-process",
      message: `${how}, but no Broforce process of ${targetDescription(nextTarget)} was running ` +
        `${confirmMs / 1000}s later — the game did not start, or exited as it started.` +
        likelyCauses(launch, 'no-process') +
        (await launchFailureTail(config, launcherStderr, spawnedAt)),
      ...note,
    });
  }

  if (started === 'running') {
    invalidateGameProcessScan();
    vanillaGames.set(nextTarget, { startMs: await gameStartTime(config) });
  }
  return withTargetNotes({
    success: true,
    launchCommand: launch.display,
    vanilla: true,
    message: noInspector +
      (finished || !launch.waitsOnExit ? '' : ` The launch command was still running after ${vanillaBudgetMs / 1000}s and was left to finish.`) +
      (started === 'unknown' ? ' Process detection is unavailable, so whether the game is running could not be checked.' : ''),
    ...note,
  });
}

async function stopGame(args) {
  // Asking whether the kill may run is also what asks the launcher again, and a retry that
  // succeeds rewrites the target's config: everything below acts on the config after that
  const signalRefusal = await steamKillRefusal();
  const config = activeConfig();
  const wantsRemove = Boolean(args.remove);
  if (!config.isAgentInstance) refuseUserGameUnderWsl('stop_game');

  if (wantsRemove && !config.isAgentInstance) {
    throw new Error(
      "remove: true deletes an agent instance's directory, and this server is pointed at the user's game. " +
      "Launch this session's own instance first, or drop remove."
    );
  }

  const releaseInstance = config.isAgentInstance ? await acquireInstanceOp() : () => {};
  try {
    let killResult;
    // The launcher's stop clears the instance's pidfile, which is worth doing even with no game
    // left; the user's game has nothing to tidy
    if (!config.isAgentInstance && (await isGameRunning(config)) === false) {
      killResult = {
        killed: false,
        detail: `No Broforce process is running for ${targetDescription()}, so nothing was signalled.`,
      };
    } else {
      unityClient.disconnect('stop_game stopped the game before this command was answered');
      killResult = await killGame({ config, signalRefusal });
    }

    const survivorsLeft = (killResult.survivors ?? []).length > 0 || Boolean(killResult.unknown);
    if (!survivorsLeft) vanillaGames.delete(targetOf(config));
    // The wrapper stops what it still owns at session end, and a confirmed stop leaves it nothing
    if (config.isAgentInstance && !survivorsLeft) await removeOwnerFile(config);

    // Deleting the directory of a game that is still running would orphan it, and a stop that
    // left any of its targets behind is not a stop, whatever else it managed
    let removal = null;
    if (wantsRemove) {
      const survivors = killResult.survivors ?? [];
      removal = killResult.unknown || survivors.length > 0
        ? {
            removed: false,
            detail: `Instance ${config.id} was not removed, since the stop did not succeed` +
              (survivors.length > 0 ? ` (pid ${survivors.join(', ')} is still running).` : '.'),
          }
        : await removeInstance(config);
    }

    return {
      // An instance with no game left is asked for a tidy-up, and a tidy-up that ran and
      // exited 0 did what this call asked of it
      success: killResult.killed || killResult.tidied === true,
      message: [killResult.detail, removal?.detail].filter(Boolean).map(asSentence).join(' '),
      target: activeTarget(),
      ...(killResult.unknown ? { unknown: true } : {}),
      ...(removal ? { removed: removal.removed } : {}),
    };
  } finally {
    releaseInstance();
  }
}

export const SHUTDOWN_TEARDOWN_COMMAND_MS = 800;
export const SHUTDOWN_TEARDOWN_BUDGET_MS = 2000;

// A sweep holds the clock at zero with the capture script's patches installed, so a server that just
// exits under one leaves the game frozen.
export async function shutdownServer(signal, { exit = (code) => process.exit(code) } = {}) {
  console.error(`Shutting down Unity Inspector MCP server (${signal})...`);

  const sweep = activeSweep;
  const watched = creationWatch;
  let timer = null;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(true), SHUTDOWN_TEARDOWN_BUDGET_MS); });
  shutdownClaimGrace = true;
  const claim = watched
    ? claimInstanceWhenCreated(watched, expired).catch(() => null)
    : Promise.resolve(null);
  if (sweep && (sweep.claim || sweep.scriptName)) {
    const teardown = (async () => {
      if (sweep.claim) await releaseClaim(sweep.client, sweep.claim, SHUTDOWN_TEARDOWN_COMMAND_MS);
      if (sweep.scriptName) {
        await teardownGame(sweep.client, {
          timeoutMs: SHUTDOWN_TEARDOWN_COMMAND_MS,
          name: sweep.scriptName,
          speed: sweep.restoreSpeed,
        });
      }
    })().then(() => false, () => false);

    const overran = await Promise.race([teardown, expired]);
    if (overran && sweep.scriptName) {
      console.error(
        `The capture teardown did not finish in time — the game may still be frozen. Unload the ` +
        `${sweep.scriptName} script with unload_script, and set_game_speed ${sweep.restoreSpeed ?? 1} if it stays frozen.`
      );
    }
  }
  await claim;
  shutdownClaimGrace = false;
  clearTimeout(timer);

  unityClient.disconnect('The MCP server shut down before this command was answered');
  exit(0);
}

// Every wait the tool takes is in seconds, as wait_for_game takes them; the library works in ms
function captureMs(name, raw, fallbackMs, { min = 0 } = {}) {
  if (raw === undefined || raw === null) return fallbackMs;
  return captureNumber(name, raw, { min }) * 1000;
}

function captureNumber(name, raw, { min = 0, integer = false } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(
      `${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}, got ${JSON.stringify(raw)}`
    );
  }
  return value;
}

// Relative names resolve under the state-list directory the way script names resolve under
// scripts/csharp/; an absolute path is used as given, for a list kept outside the repository
function captureStatesPath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Every states entry must be a path to a state list');
  }
  const name = raw.trim();
  if (path.isAbsolute(name)) return name;

  const resolved = path.resolve(CAPTURE_STATES_DIR, name.endsWith('.json') ? name : `${name}.json`);
  const relative = path.relative(CAPTURE_STATES_DIR, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `A relative states path must stay inside ${CAPTURE_STATES_DIR}: "${raw}". ` +
      'Pass an absolute path for a state list kept somewhere else.'
    );
  }
  return resolved;
}

async function captureOutDir(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('out is required: the absolute path of the directory the capture is written to');
  }
  const out = raw.trim();
  if (!path.isAbsolute(out)) {
    throw new Error(`out must be an absolute path, since a caller cannot know this server's working directory: "${raw}"`);
  }

  let stat = null;
  try {
    stat = await fs.stat(out);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`out ${out} cannot be read (${err.code || err.message}): it must be a directory this server can write`);
  }
  if (stat && !stat.isDirectory()) throw new Error(`out is not a directory: ${out}`);

  const problem = stat ? await outDirProblem(out).catch((err) => `out ${out} cannot be listed (${err.code || err.message})`) : null;
  if (problem) throw new Error(problem);
  return out;
}

function captureOnly(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((name) => typeof name === 'string' && name.trim() !== '')) {
    throw new Error('only must be a non-empty list of state names');
  }
  const twice = raw.filter((name, index) => raw.indexOf(name) !== index);
  if (twice.length > 0) throw new Error(`only names ${[...new Set(twice)].map((name) => `"${name}"`).join(', ')} more than once`);
  return raw;
}

async function captureOptions(args) {
  const out = await captureOutDir(args.out);
  const level = args.level === undefined || args.level === null ? null : parseLevel(args.level);
  const bro = args.bro === undefined || args.bro === null || String(args.bro).trim() === '' ? null : String(args.bro);
  const gameOut = args.gameOut === undefined || args.gameOut === null || String(args.gameOut).trim() === ''
    ? out
    : String(args.gameOut).trim();
  if (!isAbsoluteGamePath(gameOut)) {
    throw new Error(`gameOut must be an absolute path as the game sees it (/..., C:\\... or \\\\server\\...), got "${args.gameOut}"`);
  }

  const layers = args.states === undefined || args.states === null
    ? []
    : (Array.isArray(args.states) ? args.states : [args.states]);
  const statesPaths = layers.map(captureStatesPath);
  if (statesPaths.length === 0) statesPaths.push(DEFAULT_STATES_PATH);

  const player = args.player === undefined || args.player === null
    ? 0
    : captureNumber('player', args.player, { min: 0, integer: true });
  if (player > 3) throw new Error(`player must be an integer >= 0 and <= 3, got ${JSON.stringify(args.player)}`);

  // Both are checked whether or not the wait they follow was asked for: an argument silently thrown
  // away is worse than one reported back
  const settleMs = captureMs('settle', args.settle, DEFAULT_SETTLE_MS);
  const swapSettleMs = captureMs('swapSettle', args.swapSettle, DEFAULT_SWAP_SETTLE_MS);

  const box = args.box === undefined || args.box === null ? null : captureNumber('box', args.box, { min: 1 });
  if (box !== null && box > CAPTURE_MAX_BOX) throw new Error(`box must be a number >= 1 and <= ${CAPTURE_MAX_BOX}, got ${JSON.stringify(args.box)}`);

  return {
    out,
    gameOut,
    level,
    bro,
    statesPaths,
    // Only meaningful after the wait each one follows, so an unasked-for one costs nothing
    settleMs: level ? settleMs : 0,
    swapSettleMs: bro ? swapSettleMs : 0,
    swapTimeoutMs: captureMs('swapTimeout', args.swapTimeout, DEFAULT_SWAP_TIMEOUT_MS, { min: 1 }),
    timeoutMs: captureMs('timeout', args.timeout, DEFAULT_TIMEOUT_MS, { min: 1 }),
    player,
    box,
    includeLethal: args.includeLethal === true,
    allowSideEffects: args.allowSideEffects === true,
    only: captureOnly(args.only),
  };
}

export const CAPTURE_REPLY_STATE_ERRORS = 20;
const CAPTURE_MAX_BOX = 256;

function captureReply(run, options) {
  const { outcome } = run;
  return {
    // A cell mismatch is a finding, not a failed run: only a sentinel short of done, or a state that
    // errored inside the sweep, makes it one
    success: outcome.status === 'done' && run.stateErrors.length === 0,
    status: outcome.status,
    message: outcome.status === 'done' ? null : outcome.message,
    report: run.report,
    paths: {
      out: options.out,
      report: path.join(options.out, REPORT_FILE),
      capture: run.capture === null ? null : path.join(options.out, CAPTURE_FILE),
      states: path.join(options.out, STATES_COPY_NAME),
    },
    summary: run.summary,
    stateErrors: run.stateErrors.slice(0, CAPTURE_REPLY_STATE_ERRORS),
    ...(run.stateErrors.length > CAPTURE_REPLY_STATE_ERRORS
      ? { stateErrorsOmitted: run.stateErrors.length - CAPTURE_REPLY_STATE_ERRORS }
      : {}),
    swap: run.swap,
    logTail: outcome.logTail ? formatLogTail(outcome.logTail) : null,
  };
}

function readLogTruncation({ dropped, cut }) {
  const parts = [];
  if (cut) parts.push(`the newest line is cut to its last ${READ_LOG_MAX_BYTES} bytes`);
  if (dropped > 0) parts.push(`${dropped} earlier line${dropped === 1 ? '' : 's'} dropped`);
  return `Output truncated to ${READ_LOG_MAX_BYTES} bytes: ${parts.join(', and ')}. Narrow it with lines or filter.`;
}

function newestLinesWithin(lines, max, available = lines.length) {
  let kept = 0;
  let bytes = 0;
  while (kept < lines.length) {
    const cost = Buffer.byteLength(lines[lines.length - 1 - kept]) + (kept > 0 ? 1 : 0);
    if (bytes + cost > max) break;
    bytes += cost;
    kept++;
  }
  if (kept > 0 || lines.length === 0) {
    return { content: lines.slice(lines.length - kept).join('\n'), returned: kept, dropped: available - kept, cut: false };
  }

  const last = Buffer.from(lines[lines.length - 1], 'utf8');
  let start = last.length - max;
  while (start < last.length && (last[start] & 0xc0) === 0x80) start++;
  return { content: last.subarray(start).toString('utf8'), returned: 1, dropped: available - 1, cut: true };
}

export function handleToolCall(request, { signal = null } = {}) {
  return unityClient.runCall(signal, () => callTool(request, signal));
}

async function callTool(request, signal) {
  const name = request.params.name;
  const args = withoutNullArguments(request.params.arguments ?? {});
  const bound = !TARGET_FREE_TOOLS.has(name) && name !== 'launch_game' && name !== 'stop_game';
  if (bound) boundCalls.push(name);
  if (name === 'launch_game') launchesRunning++;

  try {
    const stray = unknownArgumentsProblem(name, args, toolArguments());
    if (stray) throw new Error(stray);
    const mistyped = argumentTypeProblems(name, args, toolArguments());
    if (mistyped.length > 0) throw new Error(mistyped.join('; '));
    refuseDuringSweep(name, args);

    // launch_game settles the target itself; everything else acts on the one already resolved
    if (!TARGET_FREE_TOOLS.has(name) && name !== 'launch_game') {
      await resolveTarget();
      if (targetPending === null) await pointClientAtTarget();
      else if (name !== 'game_state') throw new Error(pendingRefusal());
      refuseDuringSweep(name, args);
    }
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
        if (!args.path && args.instanceId === undefined) {
          throw new Error("GameObject path or instanceId is required");
        }
        result = await unityClient.sendCommand("inspect_gameobject", {
          path: args.path,
          instanceId: args.instanceId,
          detailed: args.detailed ?? false,
        });
        break;

      case "inspect_component":
        if (!args.path && args.instanceId === undefined) {
          throw new Error("GameObject path or instanceId is required");
        }
        if (!args.componentType) {
          throw new Error("Component type is required");
        }
        result = await unityClient.sendCommand("inspect_component", {
          path: args.path,
          instanceId: args.instanceId,
          componentType: args.componentType,
          memberPath: args.memberPath,
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
        result = await unityClient.sendCommand(
          "take_screenshot",
          args.highlight === undefined ? {} : { highlight: args.highlight },
        );
        if (result && result.path) {
          result.path = await unityClient.translateScreenshotPath(result.path);
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
        if ((!args.path && args.instanceId === undefined) || !args.component || !args.properties) {
          throw new Error("Path or instanceId, component, and properties are required");
        }
        if (Object.keys(args.properties).length === 0) {
          throw new Error("No properties were given - pass at least one member name and value to write");
        }
        result = await unityClient.sendCommand("modify_component", {
          path: args.path,
          instanceId: args.instanceId,
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
          ignoreSuppression: args.ignoreSuppression,
        });
        break;

      case "trace_spawns":
        result = await unityClient.sendCommand("trace_spawns", {
          action: args.action,
          targets: args.targets,
          since: args.since,
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
        break;

      case "swap_bro": {
        if (!args.broName) {
          throw new Error("Bro name is required");
        }
        const swap = toolCommand("swap_bro", {
          broName: args.broName,
          playerNum: args.playerNum ?? 0,
          ignoreUnlocks: args.ignoreUnlocks,
          nextSpawn: args.nextSpawn,
        });
        result = await unityClient.sendCommand(swap.method, swap.params);
        break;
      }

      case "list_bros":
        result = await unityClient.sendCommand("list_bros", {
          playerNum: args.playerNum ?? 0,
        });
        break;

      case "restart_level":
        result = await unityClient.sendCommand("restart_level", {});
        break;

      case "simulate_input": {
        const problem = simulateInputProblem(args);
        if (problem) throw new Error(problem);
        result = await unityClient.sendCommand("simulate_input", {
          action: args.action,
          binding: args.binding,
          sequence: args.sequence,
          duration: args.duration,
          count: args.count,
          interval: args.interval,
          player: args.player,
        });
        break;
      }

      case "list_test_scripts":
        result = await listTestScripts();
        break;

      case "wait_for_game": {
        refuseWhileInFlight('wait for the game');
        const poll = await pollUntilResponsive((args.timeout ?? 60) * 1000, (args.interval ?? 3) * 1000, null, { signal });
        result = poll.success
          ? { success: true, message: poll.message }
          : { success: false, state: poll.state, message: poll.message, lastError: poll.lastError, attempts: poll.attempts };
        break;
      }

      case "game_state": {
        const fields = await serverStateFields({ withInstanceList: true });
        if (targetPending !== null) {
          result = { success: false, message: pendingRefusal(), ...fields };
          break;
        }
        try {
          const state = await unityClient.sendCommand("game_state", {});
          result = { ...state, build: await targetBuild({ answered: state?.mainThreadAnswered !== false }), ...fields };
        } catch (err) {
          result = { success: false, message: err.message, build: await targetBuild({ answered: false }), ...fields };
        }
        break;
      }

      case "read_log": {
        const filter = args.filter;
        if (args.onlyNew && (args.lines != null || filter)) {
          throw new Error("read_log's onlyNew returns every line written since the last such call, so it takes neither lines nor filter");
        }
        if (args.reset && !args.onlyNew) {
          throw new Error("read_log's reset moves the position onlyNew reads from, so it needs onlyNew: true");
        }
        if (args.onlyNew) {
          result = await serializeNewLines(() =>
            withResolvedLog((resolved) => readNewLogLines(resolved, args.reset), { stickTo: newLinesState }));
          break;
        }
        const count = args.lines ?? 50;
        if (!Number.isInteger(count) || count < 1) {
          throw new Error(`read_log's lines must be a whole number of at least 1, got ${JSON.stringify(args.lines)}`);
        }
        result = await withResolvedLog((resolved) => readLogTail(resolved, { count, filter }));
        break;
      }

      case "run_test_script": {
        const script = args.script;
        if (!script) {
          throw new Error("Script name or path is required");
        }
        const running = { script };
        activeTestScripts.add(running);
        try {
          result = await compactTestScriptReply(
            await runTestScript(script, unityClient, {
              args: args.args ?? {},
              logPaths: () => targetLogPaths(),
              gameStart: () => gameStartTime(activeConfig()),
              crashLog: (sinceMs) => gameStdoutTail(activeConfig(), sinceMs),
              toolArguments: toolArguments(),
              signal,
            }),
            { script },
          );
        } finally {
          activeTestScripts.delete(running);
        }
        break;
      }

      case "execute_script": {
        const scriptPath = args.path;
        if (!scriptPath) {
          throw new Error("Script path is required");
        }
        const scriptData = await readScriptSource(scriptPath);
        refuseDuringSweep(name, args);
        const script = toolCommand("execute_script", {
          source: scriptData.source,
          name: scriptData.name,
          args: args.args ?? {},
          origin: scriptData.origin,
          compileOnly: args.compileOnly,
        });
        result = await unityClient.sendCommand(script.method, script.params);
        break;
      }

      case "list_scripts":
        result = await listCSharpScripts();
        break;

      case "unload_script": {
        if (!args.name) {
          throw new Error("Script name is required");
        }
        const scriptName = await loadedScriptName(args.name);
        refuseDuringSweep(name, args);
        result = await unityClient.sendCommand("unload_script", { name: scriptName });
        break;
      }

      case "capture_animations": {
        const captureOpts = await captureOptions(args);

        if (launchesRunning > 0) {
          throw new Error(
            'Cannot start an animation capture sweep while launch_game is running — it may restart or re-point ' +
            'the game under the sweep. Wait for it to finish.'
          );
        }
        refuseWhileInFlight('start an animation capture sweep');
        if (activeTestScripts.size > 0) {
          const names = [...activeTestScripts].map(({ script }) => script).join(', ');
          throw new Error(
            `Cannot start an animation capture sweep while test script ${names} is running — its steps would ` +
            `drive the game under the sweep, between commands as well as during them. Wait for it to finish.`
          );
        }

        const budgetMs = claimLeaseMs(captureOpts) + captureOpts.timeoutMs;
        const sweep = {
          out: captureOpts.out, client: unityClient, deadline: Date.now() + budgetMs,
          claim: null, scriptName: null, restoreSpeed: null,
        };
        activeSweep = sweep;

        try {
          const run = await runCapture(captureOpts, unityClient, { resolveLog: resolveLogFile, signal, sweep });
          result = captureReply(run, captureOpts);
        } finally {
          if (activeSweep === sweep) activeSweep = null;
        }
        break;
      }

      case "launch_game":
        result = await launchGame(args, signal);
        break;

      case "stop_game":
        result = await stopGame(args);
        break;

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
      ...(result?.success === false ? { isError: true } : {}),
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
  } finally {
    if (bound) boundCalls.splice(boundCalls.indexOf(name), 1);
    if (name === 'launch_game') launchesRunning--;
  }
}

server.setRequestHandler(CallToolRequestSchema, (request, extra) => handleToolCall(request, extra));

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

let shutdownTriggered = false;

function shutdownOnce(reason) {
  if (shutdownTriggered) return;
  shutdownTriggered = true;
  shutdownServer(reason).catch((err) => {
    console.error(`Shutdown failed: ${err.message}`);
    process.exit(0);
  });
}

function installShutdownTriggers() {
  // Cleanup on exit
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdownOnce(signal));
  process.stdin.on('end', () => shutdownOnce('stdin end'));
  // Node ignores SIGPIPE, so a write nobody will read fails as an error event, uncaught without this
  process.stdout.on('error', (err) => shutdownOnce(`stdout ${err.code ?? 'error'}`));
}

// Start the server
async function main() {
  installShutdownTriggers();
  ownerIdentity().catch(() => {});

  // Asking a command what it accepts takes a moment, and the handshake must not wait on it
  startLaunchHelpCapture()?.catch((err) => console.error(`Could not read the launch command's help: ${err.message}`));
  startInstanceHelpCapture().catch((err) => console.error(`Could not read the instance launcher's help: ${err.message}`));

  // Asking the launcher takes a moment, and the handshake must not wait on it
  resolveTarget().then(
    async (target) => console.error(
      target === null
        ? `Target: none yet (${targetPending})`
        : `Target: ${target}${target === 'instance' ? ` (instance ${sessionInstance().id}, port ${unityClient.port ?? 'not allocated yet'})` : ''}`
    ),
    (err) => console.error(`Could not resolve the target: ${err.message}`),
  );

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