import { AsyncLocalStorage } from 'async_hooks';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { backdropColour, backdropScreenshotCode } from './backdrop.js';
import { GAME_HOST_ENV, configuredGameHost, gameDataLocations, invalidateGameProcessScan, isGameRunning, isLoopbackHost, isWsl, remoteEndpoint } from './game-process.js';
import { pullScreenshot } from './remote-files.js';

const execAsync = promisify(exec);

export const DEFAULT_COMMAND_TIMEOUT_MS = 6000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

const TRANSPORT_MARGIN_MS = 2000;
const startedActionMs = (budgetMs) => 2 * budgetMs;

export const MAIN_THREAD_COMMAND_TIMEOUT_MS = startedActionMs(5000) + TRANSPORT_MARGIN_MS;

const MAIN_THREAD_COMMANDS = new Set([
  'game_state',
  'inspect_component',
  'inspect_gameobject',
  'inspect_player',
  'list_enemies',
  'list_gameobjects',
  'query_gameobjects',
  'teleport_player',
  'set_player_health',
  'spawn_entity',
  'trace_spawns',
  'set_bro',
  'list_bros',
]);

export const MODIFY_COMPONENT_TIMEOUT_MS = startedActionMs(5000) + startedActionMs(1000) + 1000 + TRANSPORT_MARGIN_MS;

export const TAKE_SCREENSHOT_TIMEOUT_MS = 2000 + startedActionMs(3000) + startedActionMs(3000) + 3000 + TRANSPORT_MARGIN_MS;

const stoppableActionMs = (startMs, ceilingMs) => startMs + ceilingMs;

export const EXECUTE_CODE_TIMEOUT_MS = stoppableActionMs(9000, 18000) + TRANSPORT_MARGIN_MS;

const SCRIPT_COMMANDS = new Set(['execute_script', 'compile_script', 'unload_script']);
export const SCRIPT_COMMAND_TIMEOUT_MS = stoppableActionMs(10000, 45000) + TRANSPORT_MARGIN_MS;

const LEVEL_ARRIVAL_MS = 60000 + 250 + startedActionMs(1000);
export const GO_TO_LEVEL_TIMEOUT_MS = startedActionMs(3000) + LEVEL_ARRIVAL_MS + TRANSPORT_MARGIN_MS;
export const RESTART_LEVEL_TIMEOUT_MS = startedActionMs(5000) + LEVEL_ARRIVAL_MS + TRANSPORT_MARGIN_MS;

export const SWAP_BRO_TIMEOUT_MS = startedActionMs(5000) + 500 + startedActionMs(2000) + TRANSPORT_MARGIN_MS;

export const SET_GAME_SPEED_TIMEOUT_MS = startedActionMs(5000) + 1000 + 20 + startedActionMs(2000) + TRANSPORT_MARGIN_MS;

export const INPUT_PRESS_ALLOWANCE_MS = 250;
const INPUT_FRAME_ALLOWANCE_CAP_MS = 60000;
export const INPUT_PLAN_POLL_MIN_MS = 20;
export const INPUT_PLAN_POLL_MAX_MS = 500;
export const INPUT_PLAN_CANCEL_BUDGET_MS = 1000;
const INPUT_PLAN_COMMANDS = new Set(['simulate_input', 'input_plan', 'cancel_input_plan']);
const MAX_TIMER_MS = 2 ** 31 - 1;

function inputPlanTimeout(params) {
  const number = (value, fallback) => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) ? n : fallback;
  };
  const held = (duration) => (number(duration, 0) > 0 ? number(duration, 0) : 50);
  const allowance = (presses) => Math.min(presses * INPUT_PRESS_ALLOWANCE_MS, INPUT_FRAME_ALLOWANCE_CAP_MS);
  const sequenceMs = (steps) => {
    let plannedMs = 0;
    let presses = 0;
    for (const step of steps) {
      if (step?.action || step?.binding) {
        presses++;
        plannedMs += held(step.duration);
      }
      plannedMs += Math.max(0, number(step?.wait, 0));
    }
    return plannedMs + allowance(presses);
  };

  let planMs;
  if (Array.isArray(params.tracks) && params.tracks.length > 0) {
    planMs = Math.max(...params.tracks.map((track) => (Array.isArray(track) ? sequenceMs(track) : 0)));
  } else if (Array.isArray(params.sequence) && params.sequence.length > 0) {
    planMs = sequenceMs(params.sequence);
  } else {
    const presses = Math.max(1, Math.floor(number(params.count, 1)));
    planMs = presses * held(params.duration) + (presses - 1) * Math.max(0, number(params.interval, 200)) + allowance(presses);
  }

  const budget = planMs + TRANSPORT_MARGIN_MS;
  return Math.min(Math.max(budget, DEFAULT_COMMAND_TIMEOUT_MS), MAX_TIMER_MS);
}

const STEP_KEYS = ['action', 'binding', 'duration', 'wait'];
const MIN_TRACKS = 2;
const MAX_TRACKS = 8;

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

const given = (value) => value !== undefined && value !== null;

function sent(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

function integerProblem(value, label) {
  if (typeof value !== 'number') return `${label} must be a number, got ${sent(value)}`;
  if (!Number.isInteger(value)) return `${label} must be an integer, got ${sent(value)}`;
  if (value < INT_MIN || value > INT_MAX) return `${label} must be an integer from ${INT_MIN} to ${INT_MAX}, got ${sent(value)}`;
  return null;
}

function stepProblem(step, i, path) {
  const ofStep = (message) => ({ message, ofStep: true });
  if (step === null || typeof step !== 'object' || Array.isArray(step)) return ofStep(`Step ${i} is not an object`);
  const stray = Object.keys(step).find((key) => !STEP_KEYS.includes(key));
  if (stray !== undefined) return ofStep(`Step ${i} has no key "${stray}"; a step takes action, binding, duration and wait`);
  for (const key of ['action', 'binding']) {
    if (given(step[key]) && typeof step[key] !== 'string') return ofStep(`Step ${i}: ${key} must be a string`);
  }
  if (step.action && step.binding) return ofStep(`Step ${i} has both an action and a binding; a step presses one`);
  for (const key of ['duration', 'wait']) {
    const problem = given(step[key]) && integerProblem(step[key], `${path}[${i}].${key}`);
    if (problem) return { message: problem, ofStep: false };
  }
  if (step.duration < 0 || step.wait < 0) return ofStep(`Step ${i} has a negative duration or wait`);
  if (!step.action && !step.binding && given(step.duration)) return ofStep(`Step ${i} has a duration but no action or binding; a pause is a step with only a wait`);
  return null;
}

function stepKeys(step) {
  if (step?.action) return [{ id: `action ${step.action.toLowerCase()}`, name: step.action.toLowerCase() }];
  if (step?.binding) return [{ id: `binding ${step.binding}`, name: step.binding }];
  return [];
}

function tracksProblem(tracks) {
  if (tracks.length < MIN_TRACKS || tracks.length > MAX_TRACKS) {
    return `tracks takes ${MIN_TRACKS} to ${MAX_TRACKS} tracks, got ${tracks.length}`;
  }
  const owners = new Map();
  for (const [t, track] of tracks.entries()) {
    const n = t + 1;
    if (!Array.isArray(track)) return `track ${n} is not an array of steps`;
    if (track.length === 0) return `track ${n} has no steps`;
    for (const [i, step] of track.entries()) {
      const problem = stepProblem(step, i, `tracks[${t}]`);
      if (problem) return problem.ofStep ? `track ${n}: ${problem.message}` : problem.message;
    }
    const keys = new Map(track.flatMap(stepKeys).map((key) => [key.id, key]));
    for (const key of keys.values()) {
      const owner = owners.get(key.id);
      if (owner !== undefined) return `tracks ${owner} and ${n} both press ${key.name}; two tracks may not press the same key`;
      owners.set(key.id, n);
    }
  }
  return null;
}

export function simulateInputProblem(args) {
  if (given(args.tracks) && !Array.isArray(args.tracks)) return 'tracks must be an array of tracks, each an array of steps';
  const hasAction = Boolean(args.action);
  const hasBinding = Boolean(args.binding);
  const hasSequence = Array.isArray(args.sequence) && args.sequence.length > 0;
  const hasTracks = given(args.tracks);
  const forms = hasAction + hasBinding + hasSequence + hasTracks;
  if (forms > 1) return 'Provide only one of action, binding, sequence and tracks';
  if (forms === 0) return 'Exactly one of action, binding, sequence or tracks is required';
  for (const key of ['duration', 'count', 'interval', 'player']) {
    const problem = given(args[key]) && integerProblem(args[key], key);
    if (problem) return problem;
  }
  if (args.player != null && (args.player < 0 || args.player > 3)) return `player must be 0 to 3, got ${args.player}`;

  if (!hasSequence && !hasTracks) {
    if ([args.duration, args.count, args.interval].some((value) => value < 0)) {
      return 'duration, count and interval must not be negative';
    }
    if (args.count != null && args.count < 1) return 'count must be at least 1';
    return null;
  }

  if ([args.duration, args.count, args.interval].some(given)) {
    return `duration, count and interval apply to an action, not to ${hasTracks ? 'tracks' : 'a sequence'}; give each step its own duration and wait`;
  }
  if (hasTracks) return tracksProblem(args.tracks);
  for (const [i, step] of args.sequence.entries()) {
    const problem = stepProblem(step, i, 'sequence');
    if (problem) return problem.message;
  }
  return null;
}

export function commandTimeout(method, params = {}) {
  if (SCRIPT_COMMANDS.has(method)) return SCRIPT_COMMAND_TIMEOUT_MS;
  if (method === 'go_to_level') return GO_TO_LEVEL_TIMEOUT_MS;
  if (method === 'restart_level') return RESTART_LEVEL_TIMEOUT_MS;
  if (method === 'swap_bro') return SWAP_BRO_TIMEOUT_MS;
  if (method === 'set_game_speed') return SET_GAME_SPEED_TIMEOUT_MS;
  if (method === 'execute_code') return EXECUTE_CODE_TIMEOUT_MS;
  if (method === 'modify_component') return MODIFY_COMPONENT_TIMEOUT_MS;
  if (method === 'take_screenshot') return TAKE_SCREENSHOT_TIMEOUT_MS;

  if (method === 'simulate_input') return inputPlanTimeout(params ?? {});

  if (MAIN_THREAD_COMMANDS.has(method)) return MAIN_THREAD_COMMAND_TIMEOUT_MS;
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

export function toolCommand(tool, params = {}) {
  if (tool === 'swap_bro') {
    const { nextSpawn, ...swap } = params;
    if (!nextSpawn) return { method: 'swap_bro', params: swap };
    const { ignoreUnlocks, ...set } = swap;
    if (ignoreUnlocks) {
      throw new Error("swap_bro's nextSpawn cannot take ignoreUnlocks: the selection the swap's restore puts back is what the next spawn reads");
    }
    return { method: 'set_bro', params: set };
  }

  if (tool === 'take_screenshot') {
    const { backdrop, ...shot } = params;
    const colour = backdropColour(backdrop);
    if (colour === null) return { method: 'take_screenshot', params: shot };
    if (shot.highlight !== undefined && shot.highlight !== null) {
      throw new Error("take_screenshot's backdrop cannot take highlight: the outline is the mod's own, drawn outside the backdrop render");
    }
    return { method: 'execute_code', params: { code: backdropScreenshotCode(colour) }, backdrop: colour };
  }

  if (tool === 'execute_script') {
    const { compileOnly, ...run } = params;
    if (!compileOnly) return { method: 'execute_script', params: run };
    const { args, origin, ...compile } = run;
    if (Object.keys(args ?? {}).length > 0) {
      throw new Error("execute_script's compileOnly cannot take args: nothing runs to receive them");
    }
    return { method: 'compile_script', params: compile };
  }

  if (tool === 'unload_script') {
    const { path, ...rest } = params;
    return { method: 'unload_script', params: { ...rest, name: path } };
  }

  return { method: tool, params };
}

export const DEFAULT_PORT = 9999;

const CONNECTION_LOST_MESSAGE = 'Connection closed — game likely crashed';

export const HANDSHAKE_PROTOCOL = 1;
export const HANDSHAKE_REFUSED = 'HANDSHAKE_REFUSED';
export const HANDSHAKE_TIMEOUT = 'HANDSHAKE_TIMEOUT';
export const HANDSHAKE_UNREADABLE = 'HANDSHAKE_UNREADABLE';
export const TOKEN_FILE_ENV = 'UNITY_INSPECTOR_TOKEN_FILE';
export const UNITY_PRODUCT_DIR = 'Free Lives/Broforce';
export const STEAM_APP_ID = '274190';
const FLATPAK_STEAM_HOME = '.var/app/com.valvesoftware.Steam';

export function wslMountRoot(conf = '/etc/wsl.conf') {
  let text = '';
  try {
    text = readFileSync(conf, 'utf8');
  } catch {
    return '/mnt/';
  }
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const setting = line.match(/^root\s*=\s*(.+)$/i);
    if (section === 'automount' && setting) {
      const root = setting[1].trim().replace(/^["']|["']$/g, '');
      if (root.startsWith('/')) return root.endsWith('/') ? root : `${root}/`;
    }
  }
  return '/mnt/';
}

let wslUsersRootSetting = null;

export function setWslUsersRoot(root = null) {
  wslUsersRootSetting = root;
  return wslUsersRootSetting;
}

function currentWslUsersRoot() {
  return wslUsersRootSetting ?? `${wslMountRoot()}c/Users`;
}

export const FLATPAK_STEAM_ROOT = path.join(FLATPAK_STEAM_HOME, '.local/share/Steam');

export function steamRoots(home = os.homedir()) {
  return [
    path.join(home, '.local/share/Steam'),
    path.join(home, '.steam/steam'),
    path.join(home, FLATPAK_STEAM_ROOT),
  ];
}

export function steamLibraryPaths(vdfText) {
  const paths = [];
  // libraryfolders.vdf lists every library, the root's own included
  for (const match of String(vdfText).matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    paths.push(match[1].replace(/\\(.)/g, '$1'));
  }
  return paths;
}

async function isDirectory(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function findSteamGame({ home = os.homedir() } = {}) {
  const libraries = [];
  for (const root of steamRoots(home)) {
    libraries.push(root);
    try {
      libraries.push(...steamLibraryPaths(await fs.readFile(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8')));
    } catch {}
  }

  for (const library of [...new Set(libraries)]) {
    const gamePath = path.join(library, 'steamapps/common/Broforce');
    if (!(await isDirectory(gamePath))) continue;
    const steamapps = path.join(library, 'steamapps');
    const prefix = path.join(steamapps, 'compatdata', STEAM_APP_ID, 'pfx');
    return { gamePath, protonPrefix: (await isDirectory(prefix)) ? prefix : null, steamapps };
  }
  return { gamePath: null, protonPrefix: null, steamapps: null };
}

export function tokenFileName(port) {
  return `unity-inspector-${port}.token`;
}

export function isHandshakeRefusal(error) {
  return error?.code === HANDSHAKE_REFUSED;
}

const unityConfigDir = (configHome) => path.join(configHome, 'unity3d', UNITY_PRODUCT_DIR);
const prefixDataDir = (prefix) => path.join(prefix, 'drive_c/users/steamuser/AppData/LocalLow', UNITY_PRODUCT_DIR);

export async function unityDataDirs({
  env = process.env,
  home = os.homedir(),
  protonPrefix = null,
  gameData = null,
  wsl = false,
  wslUsersRoot = null,
} = {}) {
  const linux = (gameData?.configHomes ?? []).map(unityConfigDir);
  const xdg = String(env.XDG_CONFIG_HOME ?? '').trim();
  if (xdg && path.isAbsolute(xdg)) linux.push(unityConfigDir(xdg));
  linux.push(unityConfigDir(path.join(home, '.config')));
  // Under Flatpak Steam a game's ~/.config lands in Steam's app folder, and its XDG_CONFIG_HOME is that folder's config/
  linux.push(unityConfigDir(path.join(home, FLATPAK_STEAM_HOME, 'config')));
  linux.push(unityConfigDir(path.join(home, FLATPAK_STEAM_HOME, '.config')));

  const windows = (gameData?.winePrefixes ?? []).map(prefixDataDir);
  if (env.USERPROFILE) windows.push(path.join(env.USERPROFILE, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  windows.push(path.join(home, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  if (protonPrefix) windows.push(prefixDataDir(protonPrefix));
  if (wsl) {
    const usersRoot = wslUsersRoot ?? currentWslUsersRoot();
    let users = [];
    try {
      users = (await fs.readdir(usersRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
    } catch {}
    for (const user of users) windows.push(path.join(usersRoot, user, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  }

  return { linux: [...new Set(linux)], windows: [...new Set(windows)] };
}

export async function steamTokenSearch(port, { env = process.env, home = os.homedir(), ...dirs } = {}) {
  const override = String(env[TOKEN_FILE_ENV] ?? '').trim();
  if (override) return { files: [override], searched: [override], override: true };

  const { linux, windows } = await unityDataDirs({ env, home, ...dirs });
  const searched = [...new Set([...linux, ...windows, path.join(home, 'Library/Application Support', UNITY_PRODUCT_DIR)])];
  return { files: searched.map(dir => path.join(dir, tokenFileName(port))), searched, override: false };
}

export function tokenSearchIn(dirs, port) {
  return { files: dirs.map(dir => path.join(dir, tokenFileName(port))), searched: [...dirs], override: false };
}

export function remoteTokenSearch(tokenFile) {
  const files = tokenFile ? [tokenFile] : [];
  return { files, searched: [...files], override: true, remote: true };
}

// The mod's GenerateToken() writes 32 random bytes as lowercase hex
const TOKEN_RE = /^[0-9a-f]{64}$/;

export async function readTokenFile({ files, ...search }) {
  const found = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) found.push({ file, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file } of found) {
    let text;
    try {
      text = (await fs.readFile(file, 'utf8')).trim();
    } catch {
      continue;
    }
    return TOKEN_RE.test(text)
      ? { ...search, path: file, token: text }
      : { ...search, path: file, token: null, malformed: true };
  }
  return { ...search, path: null, token: null };
}

const REMOTE_COPY_HINT = "Copy the game's current unity-inspector-<port>.token from its machine, <port> being the port its " +
  'Unity Inspector Mod listens on there; the next command reads the file again.';

function handshakeRefusal(message, refusal) {
  const error = new Error(message);
  error.code = HANDSHAKE_REFUSED;
  error.refusal = refusal;
  return error;
}

function protocolMismatch(theirs) {
  const named = typeof theirs === 'number' ? theirs : 'none';
  const update = typeof theirs === 'number' && theirs > HANDSHAKE_PROTOCOL
    ? 'Update the Unity Inspector MCP server. An MCP session whose server files are already updated loads them ' +
      'with the restart_server tool.'
    : 'Update the Unity Inspector Mod.';
  return handshakeRefusal(
    `The Unity Inspector Mod speaks handshake protocol ${named} and this server speaks ${HANDSHAKE_PROTOCOL}. ${update}`,
    'protocol',
  );
}

export function handshakeOutcome(response, located, port) {
  if (response?.success === true) {
    const theirs = response.result?.protocol;
    return theirs === HANDSHAKE_PROTOCOL ? null : protocolMismatch(theirs);
  }

  const error = String(response?.error ?? '').trim();
  if (/^Unknown method: hello\b/.test(error)) {
    return handshakeRefusal(
      'The Unity Inspector Mod in the game has no connection handshake, so it is older than this server. ' +
      'Update the Unity Inspector Mod.',
      'old-mod',
    );
  }
  if (response && Object.hasOwn(response, 'protocol') && response.protocol !== HANDSHAKE_PROTOCOL) {
    return protocolMismatch(response.protocol);
  }
  const copy = located.remote ? ` ${REMOTE_COPY_HINT}` : '';
  if (located.path && located.malformed) {
    return handshakeRefusal(
      `${located.path} holds no inspector token: the Unity Inspector Mod writes one as 64 lowercase hex characters, ` +
      `so the connection was refused.${copy || ` It writes ${tokenFileName(port)} again when its server starts.`}`,
      'token',
    );
  }
  if (located.path) {
    return handshakeRefusal(
      `The Unity Inspector Mod refused the token in ${located.path}.${error ? ` ${error}` : ''}${copy}`,
      'token',
    );
  }
  if (located.remote) {
    return handshakeRefusal(
      located.searched.length > 0
        ? `No token file at ${located.searched[0]}.${copy}`
        : `The game runs on another machine, so its token is read from ${TOKEN_FILE_ENV} alone, which is not set.${copy}`,
      'token',
    );
  }
  const where = located.override ? `${located.searched[0]} (${TOKEN_FILE_ENV})` : located.searched.join(', ');
  return handshakeRefusal(
    `Found no ${tokenFileName(port)} in ${where}. The Unity Inspector Mod writes it when its server starts.`,
    'token',
  );
}

export const REMOTE_GONE_MESSAGE = /so the ssh tunnel to the remote game is not running|Could not connect to the remote game at|so nothing is behind the tunnel|closed the connection during the handshake|closed under the command, which may have run/;

const TUNNEL_FORM = (port) => `ssh -N -L ${port}:127.0.0.1:<mod port> <host>`;

function remoteConnectError(err, remote, port) {
  const where = remoteEndpoint({ host: remote.host, port });
  const code = err.code ?? err.message;
  const error = new Error(isLoopbackHost(remote.host)
    ? `Nothing is listening on ${where}${err.code === 'ECONNREFUSED' ? '' : ` (${code})`}, so the ssh tunnel to the ` +
      `remote game is not running. Start it with ${TUNNEL_FORM(port)}, <mod port> being the port the game's Unity ` +
      `Inspector Mod listens on and <host> its machine.`
    : `Could not connect to the remote game at ${where} (${code}): its Unity Inspector Mod answers another machine ` +
      `only with its "Allow remote connections" setting on and its port open in that machine's firewall.`);
  error.code = err.code;
  return error;
}

function remoteHandshakeClose(remote, port) {
  const where = remoteEndpoint({ host: remote.host, port });
  return new Error(isLoopbackHost(remote.host)
    ? `The tunnel at ${where} took the connection and closed it during the handshake, so nothing is behind the ` +
      `tunnel: the game is not running on its machine, its Unity Inspector Mod's server is stopped, or the tunnel ` +
      `forwards to another port.`
    : `The remote game at ${where} closed the connection during the handshake: its Unity Inspector Mod's server is ` +
      `stopped or restarting, or another program holds that port.`);
}

let warnedPortValue = null;

// UNITY_INSPECTOR_PORT is the user's game only; an instance's port is the one its launcher allocated
export function defaultPort(env = process.env) {
  const raw = (env.UNITY_INSPECTOR_PORT || '').trim();
  if (!raw) return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    if (raw !== warnedPortValue) {
      warnedPortValue = raw;
      console.error(`Ignoring invalid UNITY_INSPECTOR_PORT="${raw}"; using ${DEFAULT_PORT}`);
    }
    return DEFAULT_PORT;
  }
  return port;
}

const LOOPBACK = '127.0.0.1';
const NEXT_HOST_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN']);
// A crashed game's socket can close a moment before its process leaves the table
const LOST_CONNECTION_SETTLE_MS = 1000;
const LOST_CONNECTION_POLL_MS = 250;

export const COMMAND_TIMEOUT = 'COMMAND_TIMEOUT';
export const COMMAND_CANCELLED = 'COMMAND_CANCELLED';
export const COMMAND_FAILED = 'COMMAND_FAILED';

export function parseDefaultGateway(routes) {
  const match = /^default\b.*?\bvia\s+(\S+)/m.exec(String(routes ?? ''));
  return match ? match[1] : null;
}

function commandTimeoutError(timeout) {
  const error = new Error(`Command timeout after ${timeout}ms — the game may still carry the command out`);
  error.code = COMMAND_TIMEOUT;
  return error;
}

export function cancelledError(what) {
  const error = new Error(`${what} was cancelled`);
  error.code = COMMAND_CANCELLED;
  return error;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class UnityInspectorClient {
  #calls = new AsyncLocalStorage();
  #queue = [];
  #active = null;
  #lostSockets = new WeakSet();

  constructor({ host = null, port = defaultPort(), connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    this.fixedHost = host;
    this.lastHosts = host ? [host] : [];
    this.port = port;
    this.pointedHost = null;
    // Which game the crash detector watches; null means whatever isGameRunning defaults to
    this.gameConfig = null;
    // The target's own account of why it has no port, which it knows better than the client does
    this.noPortMessage = null;
    this.tokenSearch = null;
    this.connectTimeoutMs = connectTimeoutMs;
    this.connected = false;
    this.platform = null;
    this.gamePath = null;
    this.protonPrefix = null;
    this.flatpakHome = null;
    this.detection = null;
    this.wslGatewayLookup = null;

    this.socket = null;
    this.recvBuffer = '';
    this.pending = new Map();
    this.inputPlans = new Set();
    this.connectPromise = null;
    this.requestCounter = 0;
    this.abandonAttempt = null;
    this.connectGeneration = 0;
  }

  inFlightCommands() {
    const commands = [this.#active, ...this.#queue]
      .filter(entry => entry && !entry.settled && !INPUT_PLAN_COMMANDS.has(entry.method))
      .map(entry => entry.method);
    return [...commands, ...[...this.inputPlans].map(() => 'simulate_input')];
  }

  // A target switch re-points the client: the old game's socket is dropped, never reused
  pointAt({ port, gameConfig = null, noPortMessage = null, tokenSearch = null }) {
    const host = gameConfig?.remote?.host ?? null;
    this.gameConfig = gameConfig;
    this.noPortMessage = noPortMessage;
    this.tokenSearch = tokenSearch;
    if (port === this.port && host === this.pointedHost) return false;
    this.disconnect(host === this.pointedHost
      ? "The game target's port changed before this command was answered"
      : "The game target's host changed before this command was answered");
    this.port = port;
    this.pointedHost = host;
    return true;
  }

  detectPlatform() {
    this.detection ??= this.#detectPlatform();
    return this.detection;
  }

  resetDetection() {
    this.platform = null;
    this.gamePath = null;
    this.protonPrefix = null;
    this.flatpakHome = null;
    this.detection = null;
    this.wslGatewayLookup = null;
  }

  async #detectPlatform() {
    if (this.platform) return;

    if (isWsl()) {
      this.platform = 'wsl';
      console.error('Platform: WSL');
    } else if (os.platform() === 'linux') {
      this.platform = 'linux';
      await this.detectGamePaths();
      console.error(`Platform: Linux (game path: ${this.gamePath || 'not found'})`);
    } else {
      this.platform = 'native';
      console.error('Platform: native Windows/macOS');
    }
  }

  async detectGamePaths({ home = os.homedir() } = {}) {
    const { gamePath, protonPrefix } = await findSteamGame({ home });
    this.gamePath = gamePath;
    this.protonPrefix = protonPrefix;
    const flatpakHome = path.join(home, FLATPAK_STEAM_HOME);
    this.flatpakHome = gamePath?.startsWith(flatpakHome + path.sep) ? { sandbox: home, host: flatpakHome } : null;
    if (!gamePath) {
      console.error('Could not auto-detect game path');
    } else if (protonPrefix) {
      console.error(`Proton prefix found: ${protonPrefix}`);
    } else {
      console.error('No Proton prefix found - assuming native Linux/Distrobox');
    }
  }

  async translateScreenshotPath(gameSidePath) {
    if (!gameSidePath) return gameSidePath;
    if (this.gameConfig?.remote) return pullScreenshot(this, gameSidePath);
    await this.detectPlatform();

    if (gameSidePath.startsWith('/')) {
      return this.platform === 'linux' ? this.#hostPath(gameSidePath) : gameSidePath;
    }

    const match = gameSidePath.match(/^([A-Za-z]):\/(.*)/);
    if (!match) return gameSidePath;
    const driveLetter = match[1].toLowerCase();

    if (this.platform === 'wsl') {
      return `${wslMountRoot()}${driveLetter}/${match[2]}`;
    }

    if (this.platform === 'linux') {
      // Wine maps Z: to / in every prefix
      if (driveLetter === 'z') return this.#hostPath('/' + match[2]);
      const prefix = (await gameDataLocations(this.gameConfig ?? undefined)).winePrefixes[0] ?? this.protonPrefix;
      if (prefix) return path.join(prefix, `dosdevices/${driveLetter}:`, match[2]);
    }

    return gameSidePath;
  }

  #hostPath(sandboxPath) {
    if (!this.flatpakHome || this.gameConfig?.isAgentInstance) return sandboxPath;
    const { sandbox, host } = this.flatpakHome;
    if (sandboxPath.startsWith(host + '/') || !sandboxPath.startsWith(sandbox + '/')) return sandboxPath;
    // Flatpak Steam keeps its games' home in its app folder, but a folder granted to the sandbox keeps its host path
    const moved = path.join(host, sandboxPath.slice(sandbox.length + 1));
    return !existsSync(sandboxPath) && existsSync(moved) ? moved : sandboxPath;
  }

  async #hostCandidates() {
    if (this.gameConfig?.remote) return [this.gameConfig.remote.host];
    if (this.fixedHost) return [this.fixedHost];
    if (this.gameConfig?.isAgentInstance) return [LOOPBACK];
    const configured = configuredGameHost();
    if (configured) return [configured];
    await this.detectPlatform();
    if (this.platform !== 'wsl') return [LOOPBACK];
    // WSL1 and WSL2's mirrored networking share Windows' loopback; WSL2's NAT reaches Windows only through the default gateway
    const gateway = await this.#wslGateway();
    return gateway && gateway !== LOOPBACK ? [LOOPBACK, gateway] : [LOOPBACK];
  }

  #wslGateway() {
    this.wslGatewayLookup ??= execAsync('ip route show default').then(
      ({ stdout }) => parseDefaultGateway(stdout),
      (err) => {
        console.error(`Could not read the default route to find the Windows host: ${err.message}`);
        return null;
      },
    );
    return this.wslGatewayLookup;
  }

  reachHint() {
    const remote = this.gameConfig?.remote;
    if (remote && isLoopbackHost(remote.host)) {
      return ` Nothing answers on this machine's port ${this.port} unless the ssh tunnel to the game's machine is ` +
        `running: ${TUNNEL_FORM(this.port)}.`;
    }
    if (remote) {
      return ` A game on another machine answers only with the Unity Inspector Mod's "Allow remote connections" ` +
        `setting on and its port open in that machine's firewall.`;
    }
    if (this.fixedHost || this.gameConfig?.isAgentInstance) return '';
    if (configuredGameHost()) {
      return ` A game on another machine answers only with the Unity Inspector Mod's "Allow remote connections" ` +
        `setting on and its port open in that machine's firewall.`;
    }
    if (this.platform !== 'wsl') return '';
    const tried = this.lastHosts.length > 0 ? this.lastHosts.join(', then ') : LOOPBACK;
    return ` On WSL this server tries ${tried}: the Windows host answers there only with the Unity Inspector Mod's ` +
      `"Allow remote connections" setting on and Broforce allowed through the Windows firewall, and ` +
      `${GAME_HOST_ENV} names the host outright.`;
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    if (this.connected && this.socket && !this.socket.destroyed) return Promise.resolve();

    const attempt = this.#openSocket(this.connectGeneration);
    this.connectPromise = attempt;
    attempt
      .catch(() => {})
      .finally(() => {
        if (this.connectPromise === attempt) this.connectPromise = null;
      });
    return attempt;
  }

  async #openSocket(generation) {
    const superseded = () => this.connectGeneration !== generation;

    if (!Number.isInteger(this.port) || this.port < 1) {
      throw new Error(
        this.noPortMessage ||
        'No inspector port is known for this target yet — the launcher has not allocated one. Use launch_game to start it.'
      );
    }
    const hosts = await this.#hostCandidates();
    if (superseded()) {
      throw new Error('Connection attempt abandoned — the client was disconnected');
    }

    this.#closeSocket('Connection replaced by a new connect()');
    this.lastHosts = hosts;

    return new Promise((resolve, reject) => {
      const port = this.port;
      let socket = null;
      let host = null;
      let hostIndex = 0;
      let settled = false;
      let tcpConnected = false;
      let located = null;
      let helloBuffer = '';

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (this.abandonAttempt === abandon) this.abandonAttempt = null;
        fn();
      };

      const abandon = () => {
        settle(() => {
          if (this.socket === socket) this.socket = null;
          socket.removeAllListeners();
          socket.destroy();
          reject(new Error('Connection attempt abandoned — the client was disconnected'));
        });
      };
      this.abandonAttempt = abandon;

      const duringHandshake = (error) => {
        if (tcpConnected) error.stage = 'handshake';
        return error;
      };

      const refuse = (error) => {
        settle(() => {
          socket.destroy();
          reject(error);
        });
      };

      const connectTimer = setTimeout(() => {
        if (tcpConnected) {
          const error = duringHandshake(new Error(
            `The Unity Inspector at ${host}:${port} accepted the connection but did not answer the ` +
            `connection handshake within ${this.connectTimeoutMs}ms`
          ));
          error.code = HANDSHAKE_TIMEOUT;
          refuse(error);
          return;
        }
        const hint = this.reachHint();
        refuse(new Error(
          `Timed out connecting to Unity Inspector at ${host}:${port} after ${this.connectTimeoutMs}ms${hint ? `.${hint}` : ''}`
        ));
      }, this.connectTimeoutMs);

      const answerHello = (line) => {
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          const error = duringHandshake(new Error(
            `${host}:${port} answered the connection handshake with something other than the Unity Inspector Mod's reply: ${line.slice(0, 200)}`
          ));
          error.code = HANDSHAKE_UNREADABLE;
          refuse(error);
          return;
        }
        const refusal = handshakeOutcome(response, located, port);
        if (refusal) {
          console.error(`Unity Inspector at ${host}:${port} refused the handshake: ${refusal.message}`);
          refuse(refusal);
          return;
        }
        settle(() => {
          this.connected = true;
          console.error(`Connected to Unity Inspector at ${host}:${port}`);
          resolve();
        });
      };

      const drainHello = () => {
        if (located === null || settled) return;
        const newlineIndex = helloBuffer.indexOf('\n');
        if (newlineIndex === -1) return;
        const line = helloBuffer.slice(0, newlineIndex).trim();
        helloBuffer = helloBuffer.slice(newlineIndex + 1);
        if (!line) {
          drainHello();
          return;
        }
        answerHello(line);
        if (this.connected && this.socket === socket && helloBuffer) this.#onData(helloBuffer);
        helloBuffer = '';
      };

      const tryHost = () => {
        host = hosts[hostIndex];
        const current = new net.Socket();
        // A multi-byte character can straddle two reads; the socket's decoder carries it across
        current.setEncoding('utf8');
        socket = current;
        this.socket = current;

        current.connect(port, host, async () => {
          if (superseded()) {
            abandon();
            return;
          }
          tcpConnected = true;

          try {
            located = await readTokenFile(await this.#tokenSearch(port));
          } catch (err) {
            console.error(`Could not look for the inspector token: ${err.message}`);
            located = { path: null, token: null, searched: [], override: false };
          }
          if (settled) return;
          if (superseded()) {
            abandon();
            return;
          }

          const hello = { id: `${Date.now()}-${++this.requestCounter}`, method: 'hello', params: { token: located.token, protocol: HANDSHAKE_PROTOCOL } };
          current.write(JSON.stringify(hello) + '\n');
          drainHello();
        });

        current.on('data', (text) => {
          if (this.socket !== current) return;
          if (!settled) {
            helloBuffer += text;
            drainHello();
            return;
          }
          this.#onData(text);
        });

        current.on('error', (err) => {
          if (!settled && !tcpConnected && hostIndex + 1 < hosts.length && NEXT_HOST_CODES.has(err.code)) {
            console.error(`Nothing answered at ${host}:${port} (${err.code}); trying ${hosts[hostIndex + 1]}`);
            current.removeAllListeners();
            current.destroy();
            hostIndex++;
            tryHost();
            return;
          }
          if (this.socket === current) this.connected = false;
          const wasSettled = settled;
          settle(() => reject(duringHandshake(this.#remoteFailure(err, port, tcpConnected))));
          if (wasSettled) console.error(`Socket error: ${err.message}`);
          this.#connectionLost(current);
        });

        current.on('close', () => {
          if (this.socket === current) this.connected = false;
          console.error('Connection to Unity Inspector closed');
          settle(() => reject(duringHandshake(this.#remoteFailure(new Error('Connection closed before it was established'), port, tcpConnected))));
          this.#connectionLost(current);
        });
      };

      tryHost();
    });
  }

  #remoteFailure(err, port, tcpConnected) {
    const remote = this.gameConfig?.remote;
    if (!remote) return err;
    return tcpConnected ? remoteHandshakeClose(remote, port) : remoteConnectError(err, remote, port);
  }

  async #tokenSearch(port) {
    if (this.tokenSearch) return this.tokenSearch(port);
    if (String(process.env[TOKEN_FILE_ENV] ?? '').trim()) return steamTokenSearch(port);
    await this.detectPlatform();
    return steamTokenSearch(port, {
      protonPrefix: this.protonPrefix,
      gameData: await gameDataLocations(this.gameConfig ?? undefined),
      wsl: this.platform === 'wsl',
    });
  }

  #closeSocket(reason) {
    if (this.socket) {
      const old = this.socket;
      this.socket = null;
      old.removeAllListeners();
      old.destroy();
      this.#failPending(new Error(reason), old);
    }
    this.recvBuffer = '';
    this.connected = false;
  }

  #teardownSocket(reason) {
    this.connectGeneration++;
    this.connectPromise = null;

    const abandon = this.abandonAttempt;
    this.abandonAttempt = null;
    if (abandon) abandon();

    this.#closeSocket(reason);
  }

  #failPending(error, socket) {
    if (this.pending.size === 0) return;
    for (const [id, waiter] of [...this.pending]) {
      if (socket && waiter.socket && waiter.socket !== socket) continue;
      this.pending.delete(id);
      waiter.finish(() => waiter.reject(error));
    }
  }

  async #connectionLost(socket) {
    if (this.#lostSockets.has(socket)) return;
    if (![...this.pending.values()].some(waiter => waiter.socket === socket)) return;
    this.#lostSockets.add(socket);
    this.#failPending(new Error(await this.#lostConnectionMessage()), socket);
  }

  async #lostConnectionMessage() {
    const remote = this.gameConfig?.remote;
    if (remote) {
      return `The connection to the remote game at ${remoteEndpoint({ host: remote.host, port: this.port })} closed ` +
        `under the command, which may have run: the game may have exited or crashed, its Unity Inspector Mod's ` +
        `server stopped${isLoopbackHost(remote.host) ? ', or the tunnel dropped' : ''}. Check the game before repeating it.`;
    }
    const deadline = Date.now() + LOST_CONNECTION_SETTLE_MS;
    for (;;) {
      invalidateGameProcessScan();
      const alive = await isGameRunning(this.gameConfig ?? undefined).catch(() => null);
      if (alive === false) return CONNECTION_LOST_MESSAGE;
      if (alive === null) {
        return "Connection closed — the game may have exited or crashed, or the Unity Inspector Mod's server was stopped";
      }
      if (Date.now() >= deadline) {
        return 'The Unity Inspector Mod closed the connection while the game kept running: its server was stopped ' +
          'or restarted, or the mod was disabled or reloaded';
      }
      await delay(LOST_CONNECTION_POLL_MS);
    }
  }

  async #connectFailure(err) {
    if (err.code !== 'ECONNREFUSED' || this.gameConfig?.remote) return err;
    const where = `${this.lastHosts.join(' or ')}:${this.port}`;
    const running = await isGameRunning(this.gameConfig ?? undefined).catch(() => null);
    if (running === false) return new Error('Game is not running. Use launch_game to start it.');
    if (running === true) {
      return new Error(
        `The game is running, but nothing is listening on ${where}: the Unity Inspector Mod may still be loading, ` +
        `its server may be stopped or the mod disabled, or it listens on another port.`
      );
    }
    return new Error(
      `Nothing is listening on ${where}, and whether the game is running cannot be seen from here: it may not be ` +
      `running, or the Unity Inspector Mod may still be loading or have its server stopped.${this.reachHint()}`
    );
  }

  #onData(text) {
    let start = 0;
    let newlineIndex;
    while ((newlineIndex = text.indexOf('\n', start)) !== -1) {
      const line = (this.recvBuffer + text.slice(start, newlineIndex)).trim();
      this.recvBuffer = '';
      start = newlineIndex + 1;
      if (line) this.#dispatchLine(line);
    }
    this.recvBuffer += text.slice(start);
  }

  #dispatchLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      console.error(`Dropping unparseable response: ${line.slice(0, 200)}`);
      return;
    }

    const id = response.id === undefined || response.id === null ? null : String(response.id);
    let waiter = id === null ? null : this.pending.get(id);
    let waiterId = id;

    if (!waiter && id === null && this.pending.size === 1) {
      [waiterId, waiter] = [...this.pending][0];
    }

    if (!waiter) {
      console.error(`Dropping response with no waiter (id=${id ?? 'none'}): ${line.slice(0, 200)}`);
      return;
    }

    this.pending.delete(waiterId);
    waiter.finish(() => {
      if (response.success) {
        waiter.resolve(response.result);
      } else {
        const error = new Error(response.error || 'Command failed');
        error.code = COMMAND_FAILED;
        waiter.reject(error);
      }
    });
  }

  runCall(signal, fn) {
    if (!signal) return fn();
    const call = { entries: new Set(), signal };
    const onAbort = () => {
      for (const entry of [...call.entries]) this.#cancel(entry);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return this.#calls.run(call, fn).finally(() => signal.removeEventListener('abort', onAbort));
  }

  #cancel(entry) {
    if (entry.settled) return;
    const name = entry.method === 'input_plan' ? 'simulate_input' : entry.method;
    const error = cancelledError(name);
    if (entry.waiter) {
      const socket = entry.waiter.socket;
      entry.waiter.finish(() => entry.reject(error));
      if (this.socket === socket) this.#closeSocket(`${name} was cancelled while the game was running it`);
      return;
    }
    const queued = this.#queue.indexOf(entry);
    if (queued !== -1) this.#queue.splice(queued, 1);
    entry.reject(error);
  }

  sendCommand(method, params = {}, timeoutMs = null) {
    if (method === 'simulate_input') return this.#runInputPlan(params, timeoutMs ?? commandTimeout(method, params));
    return this.#enqueue(method, params, timeoutMs);
  }

  async #runInputPlan(params, budgetMs) {
    const callSignal = this.#calls.getStore()?.signal ?? null;
    const signal = callSignal?.aborted ? null : callSignal;
    const plan = {};
    this.inputPlans.add(plan);
    let running = null;
    try {
      let deadline = Infinity;
      let planSocket = null;
      let result = await this.#enqueue('simulate_input', params, budgetMs, (socket) => {
        deadline = Date.now() + budgetMs;
        planSocket = socket;
      });
      while (result?.pending === true) {
        running = { planId: result.planId, socket: planSocket };
        const left = deadline - Date.now();
        if (left <= 0) {
          const error = new Error(`Command timeout after ${budgetMs}ms: the game had not finished input plan ${result.planId}`);
          error.code = COMMAND_TIMEOUT;
          throw error;
        }
        const remaining = Number(result.remainingMs);
        const wait = Math.min(
          Math.max(Number.isFinite(remaining) ? remaining : 0, INPUT_PLAN_POLL_MIN_MS),
          INPUT_PLAN_POLL_MAX_MS,
          left,
        );
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, wait);
          signal?.addEventListener('abort', done, { once: true });
        });
        if (signal?.aborted) throw cancelledError('simulate_input');
        result = await this.#enqueue('input_plan', { planId: result.planId }, Math.max(DEFAULT_COMMAND_TIMEOUT_MS, deadline - Date.now()));
      }
      running = null;
      return result;
    } finally {
      if (running) this.#cancelInputPlan(running);
      this.inputPlans.delete(plan);
    }
  }

  #cancelInputPlan({ planId, socket }) {
    this.#enqueue('cancel_input_plan', { planId }, INPUT_PLAN_CANCEL_BUDGET_MS, null, socket)
      .catch((err) => console.error(`Could not cancel input plan ${planId}: ${err.message}`));
  }

  #enqueue(method, params, timeoutMs, onWrite = null, onlyOn = null) {
    return new Promise((resolve, reject) => {
      const call = this.#calls.getStore() ?? null;
      const entry = { method, params, timeoutMs, onWrite, onlyOn, settled: false, waiter: null };
      const settle = (fn) => {
        if (entry.settled) return;
        entry.settled = true;
        call?.entries.delete(entry);
        fn();
      };
      entry.resolve = (value) => settle(() => resolve(value));
      entry.reject = (error) => settle(() => reject(error));
      call?.entries.add(entry);
      this.#queue.push(entry);
      this.#pump();
    });
  }

  #pump() {
    if (this.#active) return;
    const entry = this.#queue.shift();
    if (!entry) return;
    this.#active = entry;
    this.#run(entry)
      .catch((err) => entry.reject(err))
      .finally(() => {
        this.#active = null;
        this.#pump();
      });
  }

  async #run(entry) {
    if (entry.settled) return;
    if (entry.onlyOn && (!this.isConnected() || this.socket !== entry.onlyOn)) {
      entry.resolve(null);
      return;
    }
    if (!this.isConnected()) {
      try {
        await this.connect();
      } catch (err) {
        entry.reject(await this.#connectFailure(err));
        return;
      }
    }
    if (entry.settled) return;

    const socket = this.socket;
    if (!this.isConnected()) {
      // A disconnect() can land between connect() resolving and this point
      entry.reject(new Error('Not connected to the Unity Inspector — the connection was closed before the command was sent'));
      return;
    }

    const id = `${Date.now()}-${++this.requestCounter}`;
    const timeout = entry.timeoutMs ?? commandTimeout(entry.method, entry.params);
    const message = JSON.stringify({ id, method: entry.method, params: entry.params }) + '\n';

    const paramsText = JSON.stringify(entry.params ?? {});
    console.error(`Sending ${entry.method} (id ${id}, ${Buffer.byteLength(paramsText)} bytes of params): ${paramsText.slice(0, 200)}`);

    await new Promise((done) => {
      let settled = false;
      const waiter = {
        socket,
        method: entry.method,
        timeoutHandle: null,
        pollHandle: null,
        resolve: (value) => entry.resolve(value),
        reject: (error) => entry.reject(error),
      };

      waiter.finish = (fn) => {
        if (settled) return;
        settled = true;
        if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
        if (waiter.pollHandle) clearInterval(waiter.pollHandle);
        this.pending.delete(id);
        fn();
        done();
      };

      entry.waiter = waiter;
      this.pending.set(id, waiter);

      waiter.timeoutHandle = setTimeout(() => {
        if (this.#lostSockets.has(socket)) return;
        waiter.finish(() => entry.reject(commandTimeoutError(timeout)));
        if (this.socket === socket) this.#closeSocket(`${entry.method} timed out and its connection was dropped`);
      }, timeout);

      let sawAlive = false;
      let polling = false;
      if (!this.gameConfig?.remote) waiter.pollHandle = setInterval(() => {
        if (polling || settled) return;
        polling = true;
        isGameRunning(this.gameConfig ?? undefined)
          .then((alive) => {
            polling = false;
            if (settled) return;
            if (alive === true) {
              sawAlive = true;
            } else if (alive === false && sawAlive) {
              waiter.finish(() => {
                this.connected = false;
                entry.reject(new Error('Game process died — the command likely caused a crash'));
              });
            }
          })
          .catch(() => { polling = false; });
      }, 500);

      entry.onWrite?.(socket);
      socket.write(message, (err) => {
        if (err) {
          waiter.finish(() => entry.reject(new Error(`Failed to send command: ${err.message}`)));
        }
      });
    });
  }

  isConnected() {
    return this.connected && this.socket !== null && !this.socket.destroyed;
  }

  disconnect(reason = 'Disconnected') {
    this.#teardownSocket(reason);
  }
}
