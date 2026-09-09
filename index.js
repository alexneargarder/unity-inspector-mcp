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

import { UnityInspectorClient, defaultPort } from './lib/unity-client.js';
import { captureCommandHelp, composeExtraLaunchArgs, detectActiveProfile, gameStartTime, instanceModeChecked, invalidateGameProcessScan, isGameRunning, killGame, listInstances, ownedGameProcesses, probeInstanceMode, readValidatedPidfile, removeInstance, resolveLaunchCommand, runCommandCapture, spawnDetached } from './lib/game-process.js';
import { NO_INSTANCE_REASONS, instanceConfig, launcherConfig, steamConfig, withRoot } from './lib/instance.js';
import { tokenizeCommand } from './lib/command-line.js';
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
const LAUNCH_LOG_TAIL_LINES = 20;
const LAUNCH_STDERR_LIMIT_BYTES = 4096;
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

export function userGame() {
  return (userGameMemo ??= steamConfig());
}

// One explicit target, resolved once and changed only by launch_game
let currentTarget = null;

export function activeTarget() {
  return (currentTarget ??= sessionInstance().isAgentInstance ? 'instance' : 'steam');
}

export function activeConfig() {
  return activeTarget() === 'instance' ? sessionInstance() : userGame();
}

export function targetDescription(target = activeTarget()) {
  return target === 'instance' ? `the game of instance ${sessionInstance().id}` : "the user's game";
}

// The waits a unit test cannot afford to sit through in real seconds
const launchTiming = {
  probeRetryMs: LAUNCHER_RETRY_MS,
  rootRetryMs: LAUNCHER_RETRY_MS,
  vanillaExitWaitMs: VANILLA_EXIT_WAIT_MS,
  capPollMs: 5000,
  capWaitMs: 120000,
  portWaitMs: 10000,
  instanceBudgetMs: INSTANCE_LAUNCH_POLL_TIMEOUT_MS,
};

export function configureLaunchTiming(overrides = {}) {
  Object.assign(launchTiming, overrides);
  return { ...launchTiming };
}

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

// UNITY_INSPECTOR_LOG names a log for the user's game; an instance has its own two paths
function logOverride() {
  if (activeConfig().isAgentInstance) return '';
  return (process.env.UNITY_INSPECTOR_LOG || '').trim();
}

async function ummLogSearch() {
  const override = logOverride();
  if (override) return { paths: [override], displays: [override], override: true };

  const config = activeConfig();
  if (config.isAgentInstance) {
    const paths = [config.ummLog, config.playerLog];
    return { paths, displays: [...paths], override: false };
  }

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
  const config = activeConfig();
  const { paths, override } = await ummLogSearch();

  const started = await startTime(config);
  const liveSince = Number.isFinite(started) ? started - STALE_TOLERANCE_MS : null;

  let chosen = override ? await newestExisting(paths) : null;

  if (!override && config.isAgentInstance) {
    chosen = liveSince === null
      ? await newestExisting(paths)
      : (await newestExisting([config.ummLog], liveSince))
        ?? (await newestExisting([config.playerLog], liveSince))
        ?? (await newestExisting(paths));
  } else if (!override) {
    const profile = await detectProfile(config);
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
        (config.isAgentInstance
          ? chosen.path === config.playerLog
            ? `That is instance ${config.id}'s own player log, and no log of its is fresher, so the ` +
              `game has written nothing since it started.`
            : `Instance ${config.id}'s profile log may be absent or appear late, while its player log ` +
              `at ${config.playerLog} carries the same lines.`
          : override
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

// The two logs the target writes, named whether or not a game is answering
export async function targetLogPaths(config = activeConfig()) {
  if (config.isAgentInstance) return { umm: config.ummLog, player: config.playerLog };

  const override = (process.env.UNITY_INSPECTOR_LOG || '').trim();
  if (override) return { umm: override, player: null };

  let profile = null;
  try {
    profile = await detectActiveProfile(config);
  } catch {}

  return {
    umm: profile ? (await newestExisting(profileLogPaths(profile)))?.path ?? null : null,
    player: (await newestExisting(playerLogPaths()))?.path ?? null,
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
    return new Error(`UMM log file not found: UNITY_INSPECTOR_LOG points at ${displays[0]}, which does not exist.`);
  }
  return new Error(
    `UMM log file not found. Looked in:\n  ${displays.join('\n  ')}\n` +
    `Set UNITY_INSPECTOR_LOG to the log path if it lives elsewhere.`
  );
}

// Exported for the tests, which check the port and the game config the target left on it
export const unityClient = new UnityInspectorClient();

// Nothing user-facing ever prints a null port
export function noPortMessage(config = activeConfig()) {
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

// The client's port and the crash detector's idea of "the game" both follow the target
export async function pointClientAtTarget() {
  const config = activeConfig();
  const port = await targetPort(config);
  unityClient.pointAt({ port, gameConfig: config, noPortMessage: noPortMessage(config) });
  return port;
}

// This server knows none of the launch command's flags, so the command speaks for itself: its
// --help is captured at startup, and only a --help that lists --args-help is followed up, since an
// unknown launcher handed an unknown flag by name might launch the game instead of explaining itself
const ARGS_HELP_FLAG = '--args-help';
const ARGS_HELP_MAX_BYTES = 1024;

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

let launchHelpCapture = null;

export function resetLaunchHelpCapture() {
  launchHelpCapture = null;
}

// Started at startup so no tool listing pays for it, and awaited by the listing that quotes it
export function startLaunchHelpCapture() {
  const tokens = launchCommandTokens();
  if (tokens === null) return null;
  const command = tokens.join(' ');
  const noHelp = { command, argsHelp: null, truncated: false };
  launchHelpCapture ??= (async () => {
    const help = await captureCommandHelp(tokens[0], tokens.slice(1));
    if (help.error !== null || !help.text.includes(ARGS_HELP_FLAG)) return noHelp;

    const printed = await runCommandCapture(tokens[0], [...tokens.slice(1), ARGS_HELP_FLAG]);
    if (printed.error !== null || printed.text === '') return noHelp;

    const truncated = printed.text.length > ARGS_HELP_MAX_BYTES;
    return {
      command,
      argsHelp: truncated ? printed.text.slice(0, ARGS_HELP_MAX_BYTES) : printed.text,
      truncated,
    };
  })().catch(() => noHelp);
  return launchHelpCapture;
}

// What launch_game tells a caller about the arguments it may pass, in the launch command's own words
export async function launchArgumentHelp() {
  const capture = await startLaunchHelpCapture();
  if (capture === null) {
    return "\n\nThe Steam protocol launch takes no arguments, so launchArgs are not accepted.";
  }
  if (capture.argsHelp === null) {
    return "\n\nThe configured launch command publishes no argument help, so launchArgs pass through to it as given.";
  }
  return "\n\nArguments the configured launch command accepts, in its own words:\n```\n" +
    capture.argsHelp +
    (capture.truncated ? `\n[cut off at ${ARGS_HELP_MAX_BYTES} bytes]` : '') +
    "\n```";
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
      console.error(`No instance for this session: ${reason}. Serving the user's game instead.`);
      const result = { instancesRoot: null, stageRoot: null, reason };
      // Asked again after the cooldown, so a launcher that recovers is not written off for good
      rootDiscoveryFailure = { result, at: Date.now() };
      rootDiscovery = null;
      return result;
    }

    const applied = { stageRoot: summary.stageRoot };
    // Assigned into the memos rather than replacing them: a config handed out before the root was
    // known — the client's `gameConfig`, a caller's local — is the same object and gains it too
    Object.assign(sessionInstance(), withRoot(sessionInstance(), summary.instancesRoot, applied));
    // The user's game is every Broforce process outside the instances root, so it takes the same
    // answer even when this session has no instance of its own
    Object.assign(userGame(), withRoot(userGame(), summary.instancesRoot, applied));
    return { instancesRoot: summary.instancesRoot, stageRoot: summary.stageRoot, reason: null };
  })();
  return rootDiscovery;
}

// Asked whenever a launcher is configured, whatever this session's own id says
export async function launcherRootKnown() {
  if (!launcherIsUsable()) return false;
  if (!(await instanceModeAvailable())) return false;
  return (await discoverInstancesRoot()).instancesRoot !== null;
}

// The pid-scoped kill on the user's game is every Broforce process this server does not know to be
// an instance's — which, with the instances root unknown, is another session's game as well as the
// user's. A launcher with an instance mode and no readable root is the one case that can happen in
// Why this server cannot place the launcher's instances, and so cannot tell another session's game
// from the user's. Null when it can, or when there is nothing to tell apart. Asking is also what
// drives the probe's and the discovery's own retries
export async function unplaceableInstancesReason() {
  if (activeTarget() === 'instance' || !launcherIsUsable()) return null;

  if (!(await instanceModeAvailable())) {
    // Only a clean answer lifts this: a launcher that says it has no instance mode runs none, while
    // one that could not answer has said nothing about the instances it may be running
    if (instanceModeChecked() === false) return null;
    return `the configured launcher did not answer \`--help\`, so whether it runs instances of its own — ` +
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
}

export async function resolveTarget() {
  targetResolution ??= (async () => {
    currentTarget = (await instanceTargetReady()) ? 'instance' : 'steam';
    if (currentTarget === 'instance') {
      // The root is known now, and nothing else stands between it and the claim: a server
      // reconnecting on /mcp has to win the id back before the old wrapper's wait runs out
      const config = sessionInstance();
      const claimed = (await instanceOwnsGame(config)) ? (await writeOwnerFile(config)) !== null : false;
      await adoptRunningInstance({ claimed });
    } else {
      await pointClientAtTarget();
    }
    return currentTarget;
  })();
  return targetResolution;
}

// The wrapper this server runs under, as owner.pid records it: its pid and field 22 of
// /proc/<pid>/stat, so a recycled pid is not mistaken for the wrapper that claimed the instance
export async function ownerIdentity(pid = process.ppid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    // comm is parenthesised and may hold spaces, so the fields after it are what gets counted
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = afterComm[19];
    return /^\d+$/.test(String(startTime)) ? `${pid} ${startTime}` : null;
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
  if (!(await instanceDirExists(config))) return null;
  const line = await ownerIdentity();
  if (line === null) return null;
  try {
    await fs.writeFile(config.ownerFile, `${line}\n`);
  } catch {
    return null;
  }
  await recordOwnerClaim(config.ownerFile);
  return line;
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
    await fs.writeFile(file, `${ownerFile}\n`);
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

// A first launch has no directory to claim yet: the launcher creates it, and the id is claimed as
// soon as it appears. The launch command's own end stops the watch, so a launcher that creates
// nothing leaves nothing polling behind it
export async function claimInstanceWhenCreated(config, launchEnded) {
  if (!config.isAgentInstance) return null;
  let running = true;
  const ended = Promise.resolve(launchEnded).then(() => { running = false; }, () => { running = false; });
  for (;;) {
    if (await instanceDirExists(config)) return await writeOwnerFile(config);
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
export async function adoptRunningInstance({ claimed = false } = {}) {
  const config = sessionInstance();
  if (!config.isAgentInstance) return null;
  if (!claimed && (await instanceOwnsGame(config))) await writeOwnerFile(config);
  return await pointClientAtTarget();
}

export async function setTarget(next) {
  if (next !== 'instance' && next !== 'steam') throw new Error(`Unknown target: ${next}`);
  const changed = next !== activeTarget();
  currentTarget = next;
  // An explicit target is the resolution: the startup probe must not put the old one back
  targetResolution = Promise.resolve(next);
  if (changed) unityClient.disconnect();
  return { changed, port: await pointClientAtTarget() };
}

async function runningInstanceReport() {
  const config = sessionInstance();
  if (!config.isAgentInstance || instanceModeChecked() !== true) return null;
  const summary = await listInstances(config);
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
        `the configured launcher did not answer \`--help\`, so whether it has an instance mode is ` +
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
      port: await readInstancePort(config),
      root: config.root,
    },
  };
}

// Every reply that can arrive without a game behind it still says what this server is pointed at
export async function serverStateFields({ withInstanceList = false } = {}) {
  const fields = {
    target: activeTarget(),
    port: await targetPort(),
    ...(await instanceField()),
    logs: await targetLogPaths(),
  };
  if (withInstanceList && activeTarget() === 'instance') {
    const running = await runningInstanceReport();
    if (running) fields.runningInstances = running;
  }
  return fields;
}

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
        description: "Run C# in the Unity context. Accepts statements, local declarations, and a trailing 'return expr;' (a return before the final statement does not compile); input ending in an expression returns that expression's value. No lambda or Select wrapping trick is needed. Locals are call-scoped and do not persist to the next call — use static members or game objects for cross-call state. Types defined by a script loaded with execute_script are in scope here, by direct name and by reflection over the script assembly (field reads, member enumeration); MethodBase.GetMethodBody() on a script-compiled method kills the game process. The result's top-level 'success' field has three states: a value was produced (resultSet:true, with the value in 'result'), the code ran but returned nothing (success:true, resultSet:false, no error), or it failed (success:false with 'error'). When the submitted code throws, the failure also carries 'stackTrace', 'position' ({line, column} of the top-level statement that was executing) and 'statement' (that statement's text); all three are null for plain compiler diagnostics and for timeouts.",
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
        description: "Simulate keyboard/controller input for a player. Exactly one of 'action' (one press or hold) or 'sequence' (an ordered list of steps the game runs back to back) must be given. Actions: 'up', 'down', 'left' and 'right' move and aim the bro; 'fire' shoots the primary weapon; 'jump' jumps (held with 'down' it drops through a platform); 'special' uses the bro's special; 'sprint' runs; 'gesture' plays the taunt; 'start' opens the pause menu; 'escape' backs out of menus. 'highFive' is the interact button: it high-fives a rescued prisoner, melees, and activates the first registered switch within 16 units horizontally and 24 vertically — which covers switch-driven pickups and item boxes (Broforce MobileSwitch objects) — so teleporting next to an item and pressing highFive is how a pickup is driven; a live grenade within 20 units is thrown back instead, a teleport door in range is used instead, a citizen within 32 units takes the high-five, and a held grenade or mook or a running special blocks the press. Input reaches every player: 'player' is accepted and echoed but does not narrow it. With 'count' the action is pressed that many times, each press held for 'duration' ms and separated by 'interval' ms. A plan over 60 seconds is refused before anything is pressed — a hold's 'duration', 'count' presses with their 'duration' and 'interval', or a 'sequence' with its holds and waits totalled.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "Input action (up, down, left, right, fire, jump, special, highFive, gesture, sprint, start, escape)",
            },
            sequence: {
              type: "array",
              description: "Steps run in order on the game side, for timed combos; mutually exclusive with 'action'",
              items: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    description: "Input action to hold for this step; omit it to make the step a pure pause",
                  },
                  duration: {
                    type: "number",
                    description: "Milliseconds to hold this step's action (default: 50)",
                  },
                  wait: {
                    type: "number",
                    description: "Milliseconds to pause after this step before the next one (default: 0)",
                  },
                },
              },
            },
            duration: {
              type: "number",
              description: "Hold duration in milliseconds; also the per-press hold when count is used (default: 50)",
            },
            count: {
              type: "number",
              description: "Number of times to press the action, each press held for duration",
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
          required: [],
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
        description: "Wait for the game to start up and the Unity Inspector TCP server to become responsive. Polls the connection until a ping succeeds or timeout is reached. On timeout the result carries a 'state' saying how it failed: 'no-process' (no game process is running), 'connection-refused' (the process is there but nothing is listening on the port), 'connected-unresponsive' (the port accepts connections but ping got no reply), 'connection-dropped' (the port accepted a connection that was then closed), 'unknown' (process detection is unavailable), or 'no-port' (this session's instance has no allocated port and no running game of its own, so there is nothing to connect to). The wait can overrun the timeout by up to one connect timeout (5s), since an attempt already in flight is allowed to finish.",
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
        description: "Get a high-level summary of the current game state: scene, game mode, level info, player status, and bro type. Single call to orient yourself. Every reply also carries what this server is pointed at, whether or not a game answers: `target` (`instance` or `steam`), `port` (the port that target is on), `instance` with its id, port and directory (null with an `instanceReason` when this session has none), the `logs` read_log and watch_log are using, and `runningInstances` when the launcher can list them.",
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
        description: "Execute a test script containing a sequence of commands. Scripts are JSON files with command sequences that can include wait delays. Steps run directly against the game, so only game-side commands work — server-side tools (read_log, watch_log, list_scripts, launch_game, stop_game, wait_for_game, ...) cannot be used as steps. A step may also carry an 'expect' object with 'success', 'contains' and 'notContains' checks against its result; a step with 'expect' passes when its expectations are met even if the command itself failed, so a step written to fail does not stop the script. Each such result record reports 'expect' and 'expectations' (the met and unmet checks).",
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
        description: "Launch Broforce and wait for it to become responsive. By default it launches this session's own game instance through the configured instance launcher — a separate copy of the game with its own profile, saves, logs and port — and points this server at it. With steam: true it launches the user's own game instead (BROFORCE_LAUNCH_CMD when that is set, otherwise Steam app 274190) and points the server there; a configured launch command is run exactly as configured, with launchArgs appended. Sessions without an instance (no session id, no configured instance launcher, or a launcher without instance mode) always launch the user's game. Switching targets leaves the other game running and says so. Acts only on the target it launches: an instance counts as already running only when a game of its own is running, never because something answered on its port, and a second one is refused when the instance's pidfile names a live game, waits for a free slot when the launcher caps instances and is at that cap and then reports which instances hold them, and shows the tail of the instance's launch.log when a launch fails. Returns a warning if the game is already running unless restart is true, which stops only the target's game first." + (await launchArgumentHelp()),
        inputSchema: {
          type: "object",
          properties: {
            steam: {
              type: "boolean",
              description: "Launch the user's own game instead of this session's instance, and point this server at it (default: false).",
            },
            vanilla: {
              type: "boolean",
              description: "Launch without mods (default: false). No inspector loads, so nothing will answer on the TCP port and the call does not wait for one: it returns once the launch command has been started, or on an instance once that command has finished, reporting a failure if it exited non-zero.",
            },
            restart: {
              type: "boolean",
              description: "If true, stop the running game first then relaunch (default: false)",
            },
            launchArgs: {
              type: "string",
              description: "Extra arguments appended to the configured launch command, tokenized with shell-style quoting. The Steam protocol launch takes no arguments and says so.",
            },
          },
        },
      },
      {
        name: "stop_game",
        description: "Stop the game this server is pointed at, and nothing else: this session's own instance, or the user's game when the server is pointed there. An instance is stopped through the configured instance launcher, falling back to signalling the instance's own process when that command fails or leaves it running. The user's game is stopped with BROFORCE_STOP_CMD when that is set, and by signal otherwise, or when that command fails or leaves the game running. With no game running nothing is signalled and no command is run for the user's game, while an instance still goes through the launcher's stop, and the reply says it tidied the instance up. Never stops a game belonging to another session.",
        inputSchema: {
          type: "object",
          properties: {
            remove: {
              type: "boolean",
              description: "After stopping, delete this session's instance directory through the configured launcher, so the next launch builds it fresh (default: false). Only valid while the server is pointed at an instance, and skipped with a reason when the stop could not confirm the game is gone.",
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
  if (platform === 'win32') return true;

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

export async function launchLogTail(config = activeConfig(), notBeforeMs = null) {
  if (!config.isAgentInstance) return null;
  if (notBeforeMs !== null) {
    const writtenAt = await fileMtimeMs(config.launchLog);
    if (writtenAt === null || writtenAt < notBeforeMs) return null;
  }
  let text;
  try {
    text = await fs.readFile(config.launchLog, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter(line => LAUNCH_LOG_LINE_RE.test(line)).slice(-LAUNCH_LOG_TAIL_LINES);
  return lines.length > 0 ? lines.join('\n') : null;
}

// The Steam protocol launch takes no arguments, so asking for vanilla does not make it so
export function vanillaTookEffect(launch, args) {
  return Boolean(args?.vanilla) && !(launch?.ignoredArgs ?? []).includes('--vanilla');
}

// The launch command's own exit is the instance's verdict: the port it allocated is only readable
// once it has finished, and its exit 75 is the cap refusal
async function waitForLauncherExit(watcher, deadline) {
  let timer;
  const exited = await Promise.race([
    watcher.exit,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
  ]);
  clearTimeout(timer);
  return exited;
}

// The cap wait is its own phase: a freed slot buys a fresh launch, not the leftovers of this budget
async function waitForCapSlot(config, deadline) {
  let summary = null;
  let polls = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    // The budget can be spent before this wait ever asks, which is not an answer about the list
    if (remaining <= 0) return { freed: false, summary, polls };
    await delay(Math.min(launchTiming.capPollMs, remaining));
    const next = await listInstances(config);
    polls++;
    // One failed poll is one poll: what an earlier one read is still the best account there is
    if (next) summary = next;
    // An unreadable list is no reason to stop trying: the launcher itself refuses again if it must,
    // and a list reporting no cap is a launcher with no cap to be at
    if (!next || next.cap === null || next.count < next.cap) return { freed: true, summary, polls };
    if (Date.now() >= deadline) return { freed: false, summary, polls };
  }
}

// launchedPort is the port this launch's launcher allocated: it is ours for the length of the wait,
// before the game it started is running and can be recognised by its working directory
export async function pollUntilResponsive(timeoutMs, intervalMs, watcher = null, { launchedPort = null } = {}) {
  const { budgetMs: budget, intervalMs: interval } = resolvePollBudget(timeoutMs, intervalMs);

  const startTime = Date.now();
  const deadline = startTime + budget;
  const secondsSoFar = () => Number(((Date.now() - startTime) / 1000).toFixed(1));

  let attempts = 0;
  let lastError = null;
  let lastStage = null;
  let lastPort = null;

  for (;;) {
    attempts++;
    try {
      unityClient.disconnect();
      // The instance's port is re-resolved every attempt: a game that comes up mid-wait is what
      // makes its recorded port ours, and one attempt's answer does not settle the next
      lastPort = await pointClientAtTarget();
      if (lastPort === null && launchedPort !== null) {
        unityClient.pointAt({
          port: launchedPort,
          gameConfig: activeConfig(),
          noPortMessage: noPortMessage(activeConfig()),
        });
        lastPort = launchedPort;
      }
      if (lastPort === null) {
        lastStage = "port";
        throw new Error(noPortMessage(activeConfig()));
      }
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

    if (watcher?.reason) break;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(interval, remaining));
      watcher?.failure.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
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
  const pingTimedOut = /^Command timeout after \d+ms$/.test(lastError || "");
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

  if (lastStage === "ping" && pingTimedOut) {
    state = "connected-unresponsive";
    message = `${PortLabel} accepts connections but ping got no reply ${tail} — the mod may be starting or the main thread stalled`;
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
    message = `${PortLabel} accepted a connection that was then closed ${tail}: ${lastError}`;
  } else if (running === null) {
    state = "unknown";
    message = `Could not connect to ${portLabel} ${tail}, and process detection is unavailable, so it is unknown whether the game is running`;
  } else {
    state = "connection-refused";
    message = `The game process is running but nothing accepted a connection on ${portLabel} ${tail} — the mod's TCP server may be stopped or on another port`;
  }

  return { success: false, state, message, lastError, attempts, elapsed };
}

// Handle tool calls
const TARGET_FREE_TOOLS = new Set(['list_scripts', 'list_test_scripts']);

const asSentence = (text) => (/[.!?]$/.test(String(text).trim()) ? String(text).trim() : `${String(text).trim()}.`);

// Dropping the socket under a command in flight would answer it from whatever answers next
function refuseWhileInFlight(action) {
  const inFlight = unityClient.inFlightCommands();
  if (inFlight.length === 0) return;
  throw new Error(
    `Cannot ${action} while ${inFlight.join(', ')} is still in flight on the ${activeTarget()} target — ` +
    `it disconnects the client. Wait for it to finish and try again.`
  );
}

export async function handleToolCall(request) {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  try {
    // launch_game settles the target itself; everything else acts on the one already resolved
    if (!TARGET_FREE_TOOLS.has(name) && name !== 'launch_game') {
      await resolveTarget();
      await pointClientAtTarget();
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

      case "simulate_input": {
        const hasAction = Boolean(args.action);
        const hasSequence = Array.isArray(args.sequence) && args.sequence.length > 0;
        if (hasAction === hasSequence) {
          throw new Error("Exactly one of action or sequence is required");
        }
        result = await unityClient.sendCommand("simulate_input", {
          action: args.action,
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
        const poll = await pollUntilResponsive((args.timeout ?? 60) * 1000, (args.interval ?? 3) * 1000);
        result = poll.success
          ? { success: true, message: poll.message }
          : { success: false, state: poll.state, message: poll.message, lastError: poll.lastError, attempts: poll.attempts };
        break;
      }

      case "game_state": {
        const fields = await serverStateFields({ withInstanceList: true });
        try {
          const state = await unityClient.sendCommand("game_state", {});
          result = { ...state, ...fields };
        } catch (err) {
          result = { success: false, message: err.message, ...fields };
        }
        break;
      }

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
        // The probe and the root settle what this session has before the target moves anywhere
        await resolveTarget();
        const hasInstance = await instanceTargetReady();
        const nextTarget = args.steam || !hasInstance ? 'steam' : 'instance';
        const previousTarget = activeTarget();
        // A launch that meant to start this session's instance and could not has to say why, in the
        // same words game_state gives for it
        const instanceReason = !args.steam && !hasInstance ? (await instanceField()).instanceReason : null;

        // Launching disconnects the client, whatever the target, so nothing may be in flight on it
        refuseWhileInFlight('launch');

        let switchNote = null;
        if (nextTarget !== previousTarget) {
          const previousConfig = previousTarget === 'instance' ? sessionInstance() : userGame();
          if ((await isGameRunning(previousConfig)) === true) {
            switchNote = `${targetDescription(previousTarget)} is still running — switching targets left it alone. ` +
              `Switch back and use stop_game to stop it.`;
          }
        }

        await setTarget(nextTarget);

        const withTargetNotes = (payload) => ({
          ...payload,
          target: nextTarget,
          ...(switchNote ? { targetNote: switchNote } : {}),
          ...(instanceReason ? { instanceReason } : {}),
        });

        // The user's game is every Broforce process this server cannot place in an instance, so with
        // the launcher's instances unaccounted for it cannot say whether that game is running at
        // all — a stranger's would read as the user's, broken. Asking also drives the retries
        const unplaceable = await unplaceableInstancesReason();
        if (unplaceable !== null) {
          result = withTargetNotes({
            success: false,
            state: "root-unknown",
            message: asSentence(
              `Nothing was launched: ${unplaceable}, so this server cannot tell whether ` +
              `${targetDescription(nextTarget)} is running`
            ),
          });
          break;
        }

        const config = activeConfig();

        // On an instance the cwd rule decides whether a game of ours is running: a ping answered by
        // somebody else's game on a port we no longer own must never refuse this launch
        const ownsGame = config.isAgentInstance ? (await isGameRunning(config)) === true : true;

        let gameRunning = false;
        if (ownsGame) {
          try {
            unityClient.disconnect();
            await unityClient.connect();
            await unityClient.sendCommand("ping", {});
            gameRunning = true;
          } catch {
            gameRunning = false;
          }
        }

        if (gameRunning && !args.restart) {
          result = withTargetNotes({
            success: true,
            alreadyRunning: true,
            message: `${targetDescription(nextTarget)} is already running. Use restart: true to stop and relaunch.`,
          });
          break;
        }

        if (!gameRunning && !args.restart && config.isAgentInstance) {
          const refusal = await instanceLaunchRefusal(config);
          if (refusal) {
            result = withTargetNotes({ success: false, alreadyRunning: true, message: refusal });
            break;
          }
        }

        if (!gameRunning && !args.restart && (await isGameRunning(config)) === true) {
          result = withTargetNotes({
            success: false,
            alreadyRunning: true,
            message:
              "A Broforce process is running but the Unity Inspector Mod is not responding on TCP. " +
              "The mod may have failed to load. Use restart: true to stop and relaunch.",
          });
          break;
        }

        let extraArgs;
        try {
          extraArgs = composeExtraLaunchArgs(args);
        } catch (err) {
          throw new Error(`Invalid launchArgs: ${err.message}`);
        }

        // Resolving first, so a restart that cannot relaunch has not already stopped the game
        let launch;
        try {
          launch = resolveLaunchCommand(extraArgs, process.env, process.platform, config);
        } catch (err) {
          throw new Error(
            `${err.message}. BROFORCE_LAUNCH_CMD should hold the command that starts Broforce on this machine.`
          );
        }

        if (args.restart && !(await commandIsRunnable(launch.command))) {
          throw new Error(
            `Cannot run \`${launch.command}\`, so nothing was stopped: ` +
            `point ${config.isAgentInstance ? 'the configured launcher' : 'BROFORCE_LAUNCH_CMD'} at an executable ` +
            `that launches ${targetDescription(nextTarget)}.`
          );
        }

        if (args.restart && (gameRunning || (await isGameRunning(config)) === true)) {
          unityClient.disconnect();
          // As in stop_game: the refusal check can settle the root, and the kill takes the config
          // that leaves behind
          const signalRefusal = await steamKillRefusal();
          const killResult = await killGame({ config: activeConfig(), signalRefusal });
          console.error(`launch_game: ${killResult.detail}`);

          // Launching now would put a second game into an instance that still holds the first
          const survivors = killResult.survivors ?? [];
          if (killResult.unknown || survivors.length > 0) {
            result = withTargetNotes({
              success: false,
              state: "stop-failed",
              message: asSentence(
                `${targetDescription(nextTarget)} could not be stopped, so nothing was launched: ${killResult.detail}`
              ) + (survivors.length > 0 ? ` Stop pid ${survivors.join(', ')} by hand and try again.` : ''),
              ...(survivors.length > 0 ? { survivors } : {}),
            });
            break;
          }
          await delay(1000);
        }

        // The instance id is claimed before its launcher runs, so a launch that never finishes still
        // leaves the wrapper that asked for it responsible for stopping the game. A first launch has
        // no directory to claim in — the launcher is the one that creates it — and the claim follows
        // it there rather than creating it, which would leave the launcher nothing to create
        let claimed = false;
        if (config.isAgentInstance) claimed = (await writeOwnerFile(config)) !== null;

        let launcherStderr = null;
        let spawnedAt = null;
        let exitedAt = null;
        const spawnLauncher = async () => {
          try {
            spawnedAt = Date.now();
            // The Steam client and the game would inherit a pipe and fill it with their own chatter
            const child = await spawnDetached(launch.command, launch.args, {
              captureStderr: config.isAgentInstance,
            });
            if (config.isAgentInstance) launcherStderr = collectLauncherStderr(child);
            return child;
          } catch (err) {
            throw new Error(
              `Failed to launch Broforce with \`${launch.display}\`: ${err.message}. ` +
              (config.isAgentInstance
                ? `The configured launcher's instance mode is what starts instance ${config.id}.`
                : `Set the BROFORCE_LAUNCH_CMD environment variable to the command that starts the game on this machine.`)
            );
          }
        };

        const noteParts = launch.ignoredArgs?.length
          ? [`Ignored launch arguments ${launch.ignoredArgs.join(' ')} — the Steam protocol launch does not accept them. Set BROFORCE_LAUNCH_CMD to use a launcher that does.`]
          : [];
        const ignoredArgsNote = noteParts.length > 0 ? noteParts.join(' ') : null;

        let watcher = launcherExitWatcher(await spawnLauncher());
        // The port this launch's launcher allocated, which the wait may use before its game is up
        let launchedPort = null;

        // Waiting the launcher out is what carries an instance launch's verdict, and it is also the
        // window a first launch has to claim the id in: the watch ends with the launch command
        const waitOutLauncher = async () => {
          const wait = waitForLauncherExit(watcher, Date.now() + launchTiming.instanceBudgetMs);
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
            const slot = await waitForCapSlot(config, capDeadline);
            capPolls += slot.polls;
            if (slot.summary) capReport = slot.summary;
            if (!slot.freed) {
              capExpired = true;
              break;
            }
            watcher = launcherExitWatcher(await spawnLauncher());
            exited = await waitOutLauncher();
          }

          if (capExpired || (exited && exited.code === INSTANCE_CAP_EXIT)) {
            const holders = capReport?.running?.map(entry => entry.id).join(', ');
            const listIsFull = capReport?.cap !== null && capReport?.count >= capReport?.cap;
            // Four endings, and only the first of them knows who holds the slots
            let who;
            if (capReport && listIsFull) {
              who = ` Instances holding the slots: ${holders}.`;
            } else if (capReport) {
              who = ` The launcher's list last showed ` +
                (capReport.count === 0
                  ? 'no instances running'
                  : `${capReport.count}${capReport.cap ? ` of ${capReport.cap}` : ''} running (${holders})`) +
                `, yet the launcher refused this launch.`;
            } else if (capPolls > 0) {
              who = ` The launcher's instance list could not be read on any attempt, so which instances hold the slots is unknown.`;
            } else {
              who = ` The wait ran out before the launcher's instance list could be checked, so which instances hold the slots is unknown.`;
            }
            result = withTargetNotes({
              success: false,
              launchCommand: launch.display,
              state: "cap-reached",
              message:
                `The configured launcher refused this launch at its instance cap${capReport?.cap ? ` of ${capReport.cap}` : ''} ` +
                `and no slot came free in the ${((Date.now() - capStart) / 1000).toFixed(1)}s it was waited for, so instance ` +
                `${config.id} was not started.` + who,
              ...(capReport?.running ? { runningInstances: capReport.running } : {}),
              ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
            });
            break;
          }

          launcherExited = exited;

          if (!watcher.reason && !vanillaTookEffect(launch, args)) {
            // Only a port file this launch wrote is this launch's allocation
            launchedPort = await waitForInstancePort(config, { notBeforeMs: spawnedAt });
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
              result = withTargetNotes({
                success: false,
                launchCommand: launch.display,
                state: "no-port",
                message: `${what}, so there is nothing to connect to.`
                  + (await launchFailureTail(config, launcherStderr, spawnedAt)),
                ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
              });
              break;
            }
            unityClient.pointAt({ port: launchedPort, gameConfig: config, noPortMessage: noPortMessage(config) });
            // The next command re-checks ownership, and a scan from before the launch would deny it
            invalidateGameProcessScan();
          }
        }

        if (vanillaTookEffect(launch, args)) {
          const label = config.isAgentInstance ? `instance ${config.id}` : 'Broforce';
          const noInspector = `Started ${label} without mods, so the Unity Inspector Mod is not loaded and nothing will ` +
            `answer on the inspector port. Relaunch without vanilla to drive it.`;

          // An instance has already been waited out under its own budget; waiting again would only
          // add a second budget to a launcher that was left running
          const vanillaBudgetMs = config.isAgentInstance
            ? launchTiming.instanceBudgetMs
            : launchTiming.vanillaExitWaitMs;
          let finished = launcherExited !== null;
          if (!config.isAgentInstance) {
            let waitTimer;
            finished = await Promise.race([
              watcher.exit.then(() => true),
              new Promise(resolve => { waitTimer = setTimeout(() => resolve(false), vanillaBudgetMs); }),
            ]);
            clearTimeout(waitTimer);
          }
          const vanillaTail = watcher.reason ? await launchFailureTail(config, launcherStderr, spawnedAt) : '';

          result = withTargetNotes(watcher.reason
            ? {
                success: false,
                launchCommand: launch.display,
                vanilla: true,
                state: "launcher-failed",
                message: `\`${launch.display}\` failed: the launch command ${watcher.reason}.` + vanillaTail,
                ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
              }
            : {
                success: true,
                launchCommand: launch.display,
                vanilla: true,
                message: finished
                  ? noInspector
                  : `${noInspector} The launch command was still running after ${vanillaBudgetMs / 1000}s and was left to finish.`,
                ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
              });
          break;
        }

        const poll = await pollUntilResponsive(
          config.isAgentInstance ? launchTiming.instanceBudgetMs : LAUNCH_POLL_TIMEOUT_MS,
          3000,
          // A launch command that hands off and exits cleanly says nothing; a failing one ends the wait
          watcher,
          { launchedPort },
        );
        if (poll.success) {
          const running = config.isAgentInstance ? await runningInstanceReport() : null;
          result = withTargetNotes({
            success: true,
            launchCommand: launch.display,
            message: `Game ${args.restart ? 'restarted' : 'launched'} and ready (${poll.attempts} attempts, ${poll.elapsed}s)`,
            ...(config.isAgentInstance
              ? {
                  instance: { id: config.id, port: unityClient.port },
                  logs: { umm: config.ummLog, player: config.playerLog },
                  ...(running ? { runningInstances: running } : {}),
                }
              : {}),
            ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
          });
          break;
        }

        const tail = await launchFailureTail(config, launcherStderr, spawnedAt);
        result = withTargetNotes({
          success: false,
          launchCommand: launch.display,
          state: poll.state,
          message: (poll.state === "launcher-failed"
            ? `\`${launch.display}\` failed: ${poll.message}.`
            : poll.state === "no-process"
              ? `Ran \`${launch.display}\` but no Broforce process is running after ${poll.elapsed}s (${poll.attempts} attempts) — the launch command exited without leaving a game running.`
              : `Game launched with \`${launch.display}\` but never answered — ${poll.message}`) + tail,
          lastError: poll.lastError,
          attempts: poll.attempts,
          ...(ignoredArgsNote ? { note: ignoredArgsNote } : {}),
        });
        break;
      }

      case "stop_game": {
        // Asking whether the kill may run is also what asks the launcher again, and a retry that
        // succeeds rewrites the target's config: everything below acts on the config after that
        const signalRefusal = await steamKillRefusal();
        const config = activeConfig();
        const wantsRemove = Boolean(args.remove);

        if (wantsRemove && !config.isAgentInstance) {
          throw new Error(
            "remove: true deletes an agent instance's directory, and this server is pointed at the user's game. " +
            "Launch this session's own instance first, or drop remove."
          );
        }

        let killResult;
        // The launcher's stop clears the instance's pidfile, which is worth doing even with no game
        // left; the user's game has nothing to tidy
        if (!config.isAgentInstance && (await isGameRunning(config)) === false) {
          killResult = {
            killed: false,
            detail: `No Broforce process is running for ${targetDescription()}, so nothing was signalled.`,
          };
        } else {
          unityClient.disconnect();
          killResult = await killGame({ config, signalRefusal });
        }

        const survivorsLeft = (killResult.survivors ?? []).length > 0 || Boolean(killResult.unknown);
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

        result = {
          // An instance with no game left is asked for a tidy-up, and a tidy-up that ran and
          // exited 0 did what this call asked of it
          success: killResult.killed || killResult.tidied === true,
          message: [killResult.detail, removal?.detail].filter(Boolean).map(asSentence).join(' '),
          target: activeTarget(),
          ...(killResult.unknown ? { unknown: true } : {}),
          ...(removal ? { removed: removal.removed } : {}),
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
  // Asking a command what it accepts takes a moment, and the handshake must not wait on it
  startLaunchHelpCapture()?.catch((err) => console.error(`Could not read the launch command's help: ${err.message}`));

  // Asking the launcher takes a moment, and the handshake must not wait on it
  resolveTarget().then(
    async (target) => console.error(
      `Target: ${target}${target === 'instance' ? ` (instance ${sessionInstance().id}, port ${unityClient.port ?? 'not allocated yet'})` : ''}`
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