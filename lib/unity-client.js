import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isGameRunning } from './game-process.js';

const execAsync = promisify(exec);

export const DEFAULT_COMMAND_TIMEOUT_MS = 6000;
export const SCENE_COMMAND_TIMEOUT_MS = 10000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

const SCENE_COMMANDS = new Set([
  'go_to_level',
  'restart_level',
  'swap_bro',
  'set_bro',
  'take_screenshot',
]);

export function commandTimeout(method, params = {}) {
  if (method === 'execute_script' || method === 'compile_script') return 30000;
  if (method === 'unload_script') return 20000;
  if (method === 'execute_code') return 10000;

  if (method === 'simulate_input' && params) {
    if (Array.isArray(params.sequence) && params.sequence.length > 0) {
      const held = params.sequence.reduce(
        (total, step) => total + (step?.action ? (step.duration > 0 ? step.duration : 50) : 0) + (step?.wait ?? 0),
        0
      );
      return Math.max(held + 1000, DEFAULT_COMMAND_TIMEOUT_MS);
    }

    if (params.count > 1) {
      const interval = params.interval || 200;
      const duration = params.duration > 0 ? params.duration : 50;
      return Math.max(
        (params.count - 1) * interval + params.count * duration + 1000,
        DEFAULT_COMMAND_TIMEOUT_MS
      );
    }
  }

  if (SCENE_COMMANDS.has(method)) return SCENE_COMMAND_TIMEOUT_MS;
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
    const { args, ...compile } = run;
    if (Object.keys(args ?? {}).length > 0) {
      throw new Error("execute_script's compileOnly cannot take args: nothing runs to receive them");
    }
    return { method: 'compile_script', params: compile };
  }

  return { method: tool, params };
}

export const DEFAULT_PORT = 9999;

export const HANDSHAKE_PROTOCOL = 1;
export const HANDSHAKE_REFUSED = 'HANDSHAKE_REFUSED';
export const HANDSHAKE_TIMEOUT = 'HANDSHAKE_TIMEOUT';
export const TOKEN_FILE_ENV = 'UNITY_INSPECTOR_TOKEN_FILE';
export const UNITY_PRODUCT_DIR = 'Free Lives/Broforce';
const WSL_USERS_ROOT = '/mnt/c/Users';
let wslUsersRootSetting = WSL_USERS_ROOT;

export function setWslUsersRoot(root = WSL_USERS_ROOT) {
  wslUsersRootSetting = root;
  return wslUsersRootSetting;
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
  wslUsersRoot = wslUsersRootSetting,
} = {}) {
  const linux = [];
  const xdg = String(env.XDG_CONFIG_HOME ?? '').trim();
  if (xdg && path.isAbsolute(xdg)) linux.push(path.join(xdg, 'unity3d', UNITY_PRODUCT_DIR));
  linux.push(path.join(home, '.config/unity3d', UNITY_PRODUCT_DIR));

  const windows = [];
  if (env.USERPROFILE) windows.push(path.join(env.USERPROFILE, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  windows.push(path.join(home, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
  if (protonPrefix) {
    windows.push(path.join(protonPrefix, 'drive_c/users/steamuser/AppData/LocalLow', UNITY_PRODUCT_DIR));
  }
  if (wsl) {
    let users = [];
    try {
      users = (await fs.readdir(wslUsersRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
    } catch {}
    for (const user of users) windows.push(path.join(wslUsersRoot, user, 'AppData/LocalLow', UNITY_PRODUCT_DIR));
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

// UNITY_INSPECTOR_PORT is the user's game only; an instance's port is the one its launcher allocated
export function defaultPort(env = process.env) {
  const raw = (env.UNITY_INSPECTOR_PORT || '').trim();
  if (!raw) return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Ignoring invalid UNITY_INSPECTOR_PORT="${raw}"; using ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}

export class UnityInspectorClient {
  constructor({ host = null, port = defaultPort(), connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    this.host = host;
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

    this.socket = null;
    this.recvBuffer = '';
    this.pending = new Map();
    this.connectPromise = null;
    this.requestCounter = 0;
    this.abandonAttempt = null;
    this.connectGeneration = 0;
  }

  // A re-point under a command in flight would answer it from the other game, so callers check first
  inFlightCommands() {
    return [...this.pending.values()].map(waiter => waiter.method).filter(Boolean);
  }

  // A target switch re-points the client: the old game's socket is dropped, never reused
  pointAt({ port, gameConfig = null, noPortMessage = null, tokenSearch = null }) {
    this.gameConfig = gameConfig;
    this.noPortMessage = noPortMessage;
    this.tokenSearch = tokenSearch;
    if (port === this.port) return false;
    this.disconnect();
    this.port = port;
    return true;
  }

  async detectPlatform() {
    if (this.platform) return;

    if (os.release().toLowerCase().includes('microsoft')) {
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

  async detectGamePaths() {
    const steamPaths = [
      path.join(os.homedir(), '.local/share/Steam'),
      path.join(os.homedir(), '.steam/steam'),
    ];

    for (const steamPath of steamPaths) {
      const gamePath = path.join(steamPath, 'steamapps/common/Broforce');
      try {
        await fs.access(gamePath);
        this.gamePath = gamePath;

        const prefixPath = path.join(steamPath, 'steamapps/compatdata/274190/pfx');
        try {
          await fs.access(prefixPath);
          this.protonPrefix = prefixPath;
          console.error(`Proton prefix found: ${prefixPath}`);
        } catch {
          console.error('No Proton prefix found - assuming native Linux/Distrobox');
        }
        return;
      } catch {
        continue;
      }
    }
    console.error('Could not auto-detect game path');
  }

  translateScreenshotPath(gameSidePath) {
    if (!gameSidePath) return gameSidePath;

    if (gameSidePath.startsWith('/')) {
      return gameSidePath;
    }

    if (this.platform === 'wsl') {
      const match = gameSidePath.match(/^([A-Za-z]):\/(.*)/);
      if (match) {
        return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
      }
      return gameSidePath;
    }

    if (this.platform === 'linux' && this.protonPrefix) {
      const match = gameSidePath.match(/^([A-Za-z]):\/(.*)/);
      if (match) {
        const driveLetter = match[1].toLowerCase();
        if (driveLetter === 'z') {
          return '/' + match[2];
        }
        return path.join(this.protonPrefix, `dosdevices/${driveLetter}:`, match[2]);
      }
    }

    return gameSidePath;
  }

  async getServerHost() {
    await this.detectPlatform();

    if (this.platform === 'wsl') {
      try {
        const result = await execAsync('ip route show default');
        const host = result.stdout.split(' ')[2];
        console.error(`WSL: using Windows host: ${host}`);
        return host;
      } catch (e) {
        console.error('Failed to get WSL host, using fallback: 172.21.80.1');
        return '172.21.80.1';
      }
    }
    return '127.0.0.1';
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
    if (!this.host) {
      this.host = await this.getServerHost();
    }
    if (superseded()) {
      throw new Error('Connection attempt abandoned — the client was disconnected');
    }

    this.#closeSocket('Connection replaced by a new connect()');

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      let settled = false;

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

      const host = this.host;
      const port = this.port;
      let tcpConnected = false;
      let located = null;
      let helloBuffer = '';

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
        refuse(new Error(
          `Timed out connecting to Unity Inspector at ${host}:${port} after ${this.connectTimeoutMs}ms`
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

      socket.connect(port, host, async () => {
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
        socket.write(JSON.stringify(hello) + '\n');
        drainHello();
      });

      socket.on('data', (chunk) => {
        if (this.socket !== socket) return;
        if (!settled) {
          helloBuffer += chunk.toString();
          drainHello();
          return;
        }
        this.#onData(chunk);
      });

      socket.on('error', (err) => {
        if (this.socket === socket) this.connected = false;
        const wasSettled = settled;
        settle(() => reject(duringHandshake(err)));
        if (wasSettled) console.error(`Socket error (idle): ${err.message}`);
        this.#failPending(new Error(`Connection lost during command: ${err.message}`), socket);
      });

      socket.on('close', () => {
        if (this.socket === socket) this.connected = false;
        console.error('Connection to Unity Inspector closed');
        settle(() => reject(duringHandshake(new Error('Connection closed before it was established'))));
        this.#failPending(new Error('Connection closed — game likely crashed'), socket);
      });
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

  #onData(chunk) {
    this.recvBuffer += chunk.toString();

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

    // The mod answers unparseable requests and internal errors with a null id
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

  async checkHealth() {
    try {
      await this.sendCommand('ping', {});
      return true;
    } catch (error) {
      console.error('Health check failed:', error.message);
      return false;
    }
  }

  async sendCommand(method, params = {}, timeoutMs = null) {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      try {
        await this.connect();
      } catch (err) {
        if (err.code === 'ECONNREFUSED') {
          throw new Error('Game is not running. Use launch_game to start it.');
        }
        throw err;
      }
    }

    const socket = this.socket;
    if (!this.connected || !socket || socket.destroyed) {
      // A disconnect() can land between connect() resolving and this point
      throw new Error('Not connected to the Unity Inspector — the connection was closed before the command was sent');
    }

    const id = `${Date.now()}-${++this.requestCounter}`;
    const timeout = timeoutMs ?? commandTimeout(method, params);
    const message = JSON.stringify({ id, method, params }) + '\n';

    console.error(`Sending message: ${message.trim()}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = { resolve, reject, socket, method, timeoutHandle: null, pollHandle: null };

      waiter.finish = (fn) => {
        if (settled) return;
        settled = true;
        if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
        if (waiter.pollHandle) clearInterval(waiter.pollHandle);
        this.pending.delete(id);
        fn();
      };

      this.pending.set(id, waiter);

      waiter.timeoutHandle = setTimeout(() => {
        waiter.finish(() => reject(new Error(`Command timeout after ${timeout}ms`)));
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
                reject(new Error('Game process died — the command likely caused a crash'));
              });
            }
          })
          .catch(() => { polling = false; });
      }, 500);

      socket.write(message, (err) => {
        if (err) {
          waiter.finish(() => reject(new Error(`Failed to send command: ${err.message}`)));
        }
      });
    });
  }

  isConnected() {
    return this.connected && this.socket !== null && !this.socket.destroyed;
  }

  disconnect() {
    this.#teardownSocket('Disconnected');
  }
}
