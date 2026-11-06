import { AsyncLocalStorage } from 'async_hooks';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GAME_HOST_ENV, configuredGameHost, invalidateGameProcessScan, isGameRunning, isWsl } from './game-process.js';

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

  let plannedMs = 0;
  let presses = 0;
  if (Array.isArray(params.sequence) && params.sequence.length > 0) {
    for (const step of params.sequence) {
      if (step?.action || step?.binding) {
        presses++;
        plannedMs += held(step.duration);
      }
      plannedMs += Math.max(0, number(step?.wait, 0));
    }
  } else {
    presses = Math.max(1, Math.floor(number(params.count, 1)));
    plannedMs = presses * held(params.duration) + (presses - 1) * Math.max(0, number(params.interval, 200));
  }

  const budget = plannedMs + Math.min(presses * INPUT_PRESS_ALLOWANCE_MS, INPUT_FRAME_ALLOWANCE_CAP_MS) + TRANSPORT_MARGIN_MS;
  return Math.min(Math.max(budget, DEFAULT_COMMAND_TIMEOUT_MS), MAX_TIMER_MS);
}

const STEP_KEYS = ['action', 'binding', 'duration', 'wait'];

export function simulateInputProblem(args) {
  const hasAction = Boolean(args.action);
  const hasBinding = Boolean(args.binding);
  const hasSequence = Array.isArray(args.sequence) && args.sequence.length > 0;
  if (hasAction + hasBinding + hasSequence !== 1) return 'Exactly one of action, binding or sequence is required';
  if (args.player != null && (args.player < 0 || args.player > 3)) return `player must be 0 to 3, got ${args.player}`;

  if (!hasSequence) {
    if ([args.duration, args.count, args.interval].some((value) => value < 0)) {
      return 'duration, count and interval must not be negative';
    }
    if (args.count != null && args.count < 1) return 'count must be at least 1';
    return null;
  }

  if ([args.duration, args.count, args.interval].some((value) => value !== undefined && value !== null)) {
    return 'duration, count and interval apply to an action, not to a sequence; give each step its own duration and wait';
  }
  for (const [i, step] of args.sequence.entries()) {
    const stray = Object.keys(step).find((key) => !STEP_KEYS.includes(key));
    if (stray !== undefined) return `Step ${i} has no key "${stray}"; a step takes action, binding, duration and wait`;
    if (step.action && step.binding) return `Step ${i} has both an action and a binding; a step presses one`;
    if (step.duration < 0 || step.wait < 0) return `Step ${i} has a negative duration or wait`;
    if (!step.action && !step.binding && step.duration != null) return `Step ${i} has a duration but no action or binding; a pause is a step with only a wait`;
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

  if (tool === 'execute_script') {
    const { compileOnly, ...run } = params;
    if (!compileOnly) return { method: 'execute_script', params: run };
    const { args, origin, ...compile } = run;
    if (Object.keys(args ?? {}).length > 0) {
      throw new Error("execute_script's compileOnly cannot take args: nothing runs to receive them");
    }
    return { method: 'compile_script', params: compile };
  }

  return { method: tool, params };
}

export const DEFAULT_PORT = 9999;

const CONNECTION_LOST_MESSAGE = 'Connection closed — game likely crashed';

export const HANDSHAKE_PROTOCOL = 1;
export const HANDSHAKE_REFUSED = 'HANDSHAKE_REFUSED';
export const HANDSHAKE_TIMEOUT = 'HANDSHAKE_TIMEOUT';
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

export async function unityDataDirs({
  env = process.env,
  home = os.homedir(),
  protonPrefix = null,
  wsl = false,
  wslUsersRoot = null,
} = {}) {
  const linux = [];
  const xdg = String(env.XDG_CONFIG_HOME ?? '').trim();
  if (xdg && path.isAbsolute(xdg)) linux.push(path.join(xdg, 'unity3d', UNITY_PRODUCT_DIR));
  linux.push(path.join(home, '.config/unity3d', UNITY_PRODUCT_DIR));
  // Under Flatpak Steam a game's ~/.config lands in Steam's app folder, and its XDG_CONFIG_HOME is that folder's config/
  linux.push(path.join(home, FLATPAK_STEAM_HOME, 'config/unity3d', UNITY_PRODUCT_DIR));
  linux.push(path.join(home, FLATPAK_STEAM_HOME, '.config/unity3d', UNITY_PRODUCT_DIR));

  const windows = [];
  if (env.USERPROFILE) windows.push(path.join(env.USERPROFILE, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  windows.push(path.join(home, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  if (protonPrefix) {
    windows.push(path.join(protonPrefix, 'drive_c/users/steamuser/AppData/LocalLow', UNITY_PRODUCT_DIR));
  }
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

export async function readTokenFile({ files, searched, override }) {
  const found = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) found.push({ file, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file } of found) {
    try {
      const token = (await fs.readFile(file, 'utf8')).trim();
      return { path: file, token: token || null, searched, override };
    } catch {}
  }
  return { path: null, token: null, searched, override };
}

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
  if (located.path) {
    return handshakeRefusal(
      `The Unity Inspector Mod refused the token in ${located.path}.${error ? ` ${error}` : ''}`,
      'token',
    );
  }
  const where = located.override ? `${located.searched[0]} (${TOKEN_FILE_ENV})` : located.searched.join(', ');
  return handshakeRefusal(
    `Found no ${tokenFileName(port)} in ${where}. The Unity Inspector Mod writes it when its server starts.`,
    'token',
  );
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
    this.gameConfig = gameConfig;
    this.noPortMessage = noPortMessage;
    this.tokenSearch = tokenSearch;
    if (port === this.port) return false;
    this.disconnect("The game target's port changed before this command was answered");
    this.port = port;
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
      if (this.protonPrefix) return path.join(this.protonPrefix, `dosdevices/${driveLetter}:`, match[2]);
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
          refuse(duringHandshake(new Error(
            `${host}:${port} answered the connection handshake with something other than the Unity Inspector Mod's reply: ${line.slice(0, 200)}`
          )));
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
          settle(() => reject(duringHandshake(err)));
          if (wasSettled) console.error(`Socket error: ${err.message}`);
          this.#connectionLost(current);
        });

        current.on('close', () => {
          if (this.socket === current) this.connected = false;
          console.error('Connection to Unity Inspector closed');
          settle(() => reject(duringHandshake(new Error('Connection closed before it was established'))));
          this.#connectionLost(current);
        });
      };

      tryHost();
    });
  }

  async #tokenSearch(port) {
    if (this.tokenSearch) return this.tokenSearch(port);
    if (!String(process.env[TOKEN_FILE_ENV] ?? '').trim()) await this.detectPlatform();
    return steamTokenSearch(port, { protonPrefix: this.protonPrefix, wsl: this.platform === 'wsl' });
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
    if (err.code !== 'ECONNREFUSED') return err;
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
    this.recvBuffer += text;

    let newlineIndex;
    while ((newlineIndex = this.recvBuffer.indexOf('\n')) !== -1) {
      const line = this.recvBuffer.slice(0, newlineIndex).trim();
      this.recvBuffer = this.recvBuffer.slice(newlineIndex + 1);
      if (line) this.#dispatchLine(line);
    }
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
        waiter.reject(new Error(response.error || 'Command failed'));
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
      waiter.pollHandle = setInterval(() => {
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
