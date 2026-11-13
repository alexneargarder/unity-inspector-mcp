import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { INSTANCE_STOP_TIMEOUT_MS, instanceConfig } from './instance.js';
import { LAUNCH_OUTPUT_FIFO_SUFFIX } from './launch-record.js';
import { tokenizeCommand } from './command-line.js';
import { resolveSteamLaunch } from './steam-launch.js';

export const STEAM_APP_ID = 274190;
export const STEAM_LAUNCH_URL = `steam://rungameid/${STEAM_APP_ID}`;

// The bracketed first characters keep the pattern from matching the `sh -c` wrapper that runs it
export const POSIX_GAME_CHECK_CMD =
  "pgrep -x 'Broforce.x86_64' >/dev/null 2>&1 || " +
  "pgrep -x Broforce >/dev/null 2>&1 || " +
  "pgrep -f '[B]roforce.*[.]e[x]e' >/dev/null 2>&1";

export const POSIX_GAME_PID_CMD =
  "pgrep -x 'Broforce.x86_64' 2>/dev/null || " +
  "pgrep -x Broforce 2>/dev/null";

// Under Proton the process name is the wine loader, so the game is only findable by command line
export const POSIX_GAME_CMDLINE_PID_CMD =
  "pgrep -f '[B]roforce.*[.]e[x]e' 2>/dev/null";

// Name-based killing survives only where /proc does not: Linux kills the pids it owns instead
export const POSIX_GAME_KILL_CMD =
  "r=1; " +
  "pkill -9 -x Broforce 2>/dev/null && r=0; " +
  "pkill -9 -f '[B]roforce.*[.]e[x]e' 2>/dev/null && r=0; " +
  "exit $r";

export const WINDOWS_IMAGE_NAMES = ['Broforce.exe', 'Broforce_beta.exe'];

// /proc/<pid>/comm truncates at 15 characters, which is exactly the length of this name
export const LINUX_GAME_COMM = 'Broforce.x86_64';
const WINE_COMM_RE = /wine|proton|\.exe$/i;
// comm truncation also cuts 'Broforce_beta.exe' down to 'Broforce_beta.e', so any prefix counts
const GAME_COMM_PREFIX_RE = /^Broforce/;
const GAME_EXE_ARG_RE = /(^|[\/\\])Broforce[^\/\\]*\.exe$/i;
// A renamed copy of the same Linux binary is still the game, and comm truncates the name
const LINUX_GAME_ARGV0_RE = /^Broforce.*\.x86_64$/;
const SCAN_CACHE_MS = 750;
const DOORSTOP_ANCESTOR_DEPTH = 8;
const CLOCK_TICKS_PER_SECOND = 100;
const KILL_GRACE_MS = 3000;
const KILL_POLL_MS = 100;
const KILL_CONFIRM_MS = 2000;
// taskkill and pkill answer for the signal, not for the process leaving
const NAME_KILL_CONFIRM_MS = 5000;
const NAME_KILL_POLL_MS = 250;
const STOP_COMMAND_TIMEOUT_MS = INSTANCE_STOP_TIMEOUT_MS;
// A command that exits while something it started still holds its pipes never closes them
const EXIT_DRAIN_MS = 250;
const PROC_READ_TIMEOUT_MS = 500;
// The probe and the root discovery both have to settle inside the wrapper's 15s takeover poll
const INSTANCE_PROBE_TIMEOUT_MS = 5000;
// A command asked to print something for a caller, rather than to answer a question this server
// blocks on: the argument-help capture is the only one, and it may take its time
const COMMAND_CAPTURE_TIMEOUT_MS = 10000;
// --help is the only question safe to put to a launcher that may not have an instance mode: one
// without it takes any other first word for a profile name and launches the user's game
const INSTANCE_HELP_RE = /\binstance <id>/;
const LIST_COMMAND_TIMEOUT_MS = 10000;
const REMOVE_COMMAND_TIMEOUT_MS = INSTANCE_STOP_TIMEOUT_MS;

const isWindows = (platform = process.platform) => platform === 'win32';
const isLinux = () => process.platform === 'linux';
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function isWslRelease(release = os.release()) {
  return /microsoft/i.test(String(release));
}

const releaseNamesWsl = () => process.platform === 'linux' && isWslRelease();
let wslProbe = releaseNamesWsl;

export function isWsl() {
  return wslProbe();
}

export function setWslProbe(probe = null) {
  wslProbe = probe ?? releaseNamesWsl;
}

export const GAME_HOST_ENV = 'UNITY_INSPECTOR_HOST';

export function configuredGameHost(env = process.env) {
  const host = String(env[GAME_HOST_ENV] ?? '').trim();
  return host || null;
}

export const isLoopbackHost = (host) => /^(localhost|::1|127(\.\d{1,3}){3})$/i.test(host);

export function remoteEndpoint({ host, port }) {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function userGameOutOfReach(config, env = process.env) {
  if (config?.remote) {
    return config.remote.fromEnv
      ? `the user's game runs on ${config.remote.host} (${GAME_HOST_ENV}), whose processes this server cannot see`
      : `the remote game at ${remoteEndpoint(config.remote)} runs on another machine, whose processes this server cannot see`;
  }
  if (config?.isAgentInstance) return null;
  const host = configuredGameHost(env);
  if (host !== null && !isLoopbackHost(host)) {
    return `the user's game runs on ${host} (${GAME_HOST_ENV}), whose processes this server cannot see`;
  }
  if (isWsl()) {
    return "the user's game runs on Windows, outside WSL, whose processes this server cannot see";
  }
  return null;
}

export function runChild(command, args, { timeoutMs = 10000, capture = true } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore'],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let exited = null;
    let drain = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      const error = new Error(`did not finish within ${timeoutMs / 1000}s`);
      error.code = 'ETIMEDOUT';
      finish({ code: null, signal: 'SIGKILL', stdout, stderr, error });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => finish({ code: null, signal: null, stdout, stderr, error }));
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code, signal, stdout, stderr, error: null });
      }, EXIT_DRAIN_MS);
    });
    child.on('close', (code, signal) => finish({
      code: exited ? exited.code : code,
      signal: exited ? exited.signal : signal,
      stdout,
      stderr,
      error: null,
    }));
  });
}

export function commandFailure(display, { error, code, stderr }) {
  if (error?.code === 'ETIMEDOUT') return `\`${display}\` ${error.message}`;
  if (error) return `\`${display}\` could not run (${error.message})`;
  if (code !== 0) return `\`${display}\` exited ${code}${stderr?.trim() ? ` (${stderr.trim()})` : ''}`;
  return null;
}

const TIMED_OUT = Symbol('timed out');

export function createProcReader(procRoot = '/proc', fileSystem = fsp, { readTimeoutMs = PROC_READ_TIMEOUT_MS } = {}) {
  const readText = async (relative) => {
    try {
      return await fileSystem.readFile(path.join(procRoot, relative), 'utf8');
    } catch {
      return null;
    }
  };

  // cmdline and environ read the process's memory under its mmap lock, which a process stuck in the kernel holds for as long as it is stuck; each hung read also holds one of libuv's four fs threads
  const hung = new Set();
  const readMemory = async (pid, name) => {
    const key = `${pid}/${name}`;
    if (hung.has(key)) return null;
    const read = readText(key);
    let timer;
    const result = await Promise.race([
      read,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), readTimeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (result !== TIMED_OUT) return result;
    hung.add(key);
    read.finally(() => hung.delete(key));
    return null;
  };

  return {
    async pids() {
      const entries = await fileSystem.readdir(procRoot);
      return entries.filter(name => /^\d+$/.test(name));
    },
    comm: (pid) => readText(`${pid}/comm`),
    stat: (pid) => readText(`${pid}/stat`),
    cmdline: (pid) => readMemory(pid, 'cmdline'),
    environ: (pid) => readMemory(pid, 'environ'),
    async cwd(pid) {
      try {
        return await fileSystem.readlink(path.join(procRoot, String(pid), 'cwd'));
      } catch {
        return null;
      }
    },
    async exe(pid) {
      try {
        return await fileSystem.readlink(path.join(procRoot, String(pid), 'exe'));
      } catch {
        return null;
      }
    },
    async bootTimeMs() {
      return parseBootTimeMs(await readText('stat'));
    },
  };
}

const nulTokens = (text) => String(text ?? '').split('\0').filter(Boolean);

let sharedReader = null;
let realReader = null;

// One reader instance, so the scan cache can key on it
export function defaultProcReader() {
  if (sharedReader) return sharedReader;
  // What runs on the machine would decide a test's outcome: a test injects a fixed table, or opts in
  // to the real one with setProcReader(createProcReader())
  if (process.env.UNITY_INSPECTOR_TEST) {
    throw new Error(
      'Refusing to read the real process table while UNITY_INSPECTOR_TEST is set: what runs on this machine ' +
      'would decide the outcome. A test must inject a reader (setProcReader).'
    );
  }
  realReader ??= createProcReader();
  return realReader;
}

// The tests drive the ownership rules that run without an injected reader
export function setProcReader(reader = null) {
  sharedReader = reader;
  invalidateGameProcessScan();
}

export function parseBootTimeMs(stat) {
  const match = /^btime\s+(\d+)$/m.exec(String(stat ?? ''));
  return match ? Number(match[1]) * 1000 : null;
}

// The comm field is parenthesised and can contain spaces, so the fields are counted from the last ')'
export function parseStatStartTicks(stat) {
  const text = String(stat ?? '');
  const close = text.lastIndexOf(')');
  if (close === -1) return null;
  const afterComm = text.slice(close + 1).trim().split(/\s+/);
  const ticks = Number(afterComm[19]);
  return Number.isFinite(ticks) ? ticks : null;
}

export function parseStatState(stat) {
  const text = String(stat ?? '');
  const close = text.lastIndexOf(')');
  return close === -1 ? null : (text.slice(close + 1).trim().split(/\s+/)[0] || null);
}

export function parseStatPpid(stat) {
  const text = String(stat ?? '');
  const close = text.lastIndexOf(')');
  if (close === -1) return null;
  const ppid = Number(text.slice(close + 1).trim().split(/\s+/)[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

export function isUnder(child, parent) {
  if (!child || !parent) return false;
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// A path merely mentioned in an argument is not the program: only a whole argv element counts
export function argvNamesGameExe(cmdline) {
  return nulTokens(cmdline).some(token => GAME_EXE_ARG_RE.test(token));
}

// The program a process is running is argv[0] and nothing else
export function argv0NamesLinuxGame(cmdline) {
  const [argv0] = nulTokens(cmdline);
  return argv0 ? LINUX_GAME_ARGV0_RE.test(path.basename(argv0)) : false;
}

// 'comm' is the game itself; 'cmdline' can also be a wine process of the launcher chain around it
export async function matchGameProcess(reader, pid) {
  const comm = (await reader.comm(pid) ?? '').trim();
  if (comm === LINUX_GAME_COMM) return 'comm';
  if (!comm) return null;

  const broforceComm = GAME_COMM_PREFIX_RE.test(comm);
  // Under Proton the game runs as a wine process, so only its command line names it
  if (!broforceComm && !WINE_COMM_RE.test(comm)) return null;

  const cmdline = await reader.cmdline(pid);
  // A renamed copy of the Linux binary is the game itself, whatever comm was truncated to
  if (broforceComm && argv0NamesLinuxGame(cmdline)) return 'comm';
  return argvNamesGameExe(cmdline) ? 'cmdline' : null;
}

let scanCache = null;

export function invalidateGameProcessScan() {
  scanCache = null;
}

// The crash detector polls twice a second and a /proc walk is not free, so repeats share one scan
export function scanGameProcesses(reader = defaultProcReader(), { maxAgeMs = SCAN_CACHE_MS } = {}) {
  const now = Date.now();
  if (scanCache && scanCache.reader === reader && now - scanCache.at < maxAgeMs) return scanCache.promise;

  const promise = walkGameProcesses(reader);
  scanCache = { reader, at: now, promise };
  promise.catch(() => {
    if (scanCache?.promise === promise) scanCache = null;
  });
  return promise;
}

async function walkGameProcesses(reader) {
  const bootTimeMs = await reader.bootTimeMs();
  const found = [];

  for (const pid of await reader.pids()) {
    const match = await matchGameProcess(reader, pid);
    if (match === null) continue;

    const stat = await reader.stat(pid);
    // A game that has exited stays in the table until its parent reaps it
    if (parseStatState(stat) === 'Z') continue;
    const ticks = parseStatStartTicks(stat);
    found.push({
      pid: Number(pid),
      match,
      cwd: (await reader.cwd(pid)) ?? null,
      startMs: bootTimeMs !== null && ticks !== null
        ? bootTimeMs + (ticks * 1000) / CLOCK_TICKS_PER_SECOND
        : null,
    });
  }

  return found;
}

export function ownsProcess(proc, config) {
  if (config.remote) throw new Error(`No local process belongs to a remote target: ${userGameOutOfReach(config)}`);
  if (config.isAgentInstance) {
    // Without the launcher's root there is no work directory to compare against, and answering
    // "not ours" for every process would read as an instance with no game running
    if (!config.workDir) throw new Error(`Instance ${config.id} has no known root yet`);
    return isUnder(proc.cwd, config.workDir);
  }
  // An unreadable cwd belongs to a process of another user, which is never an agent instance
  return proc.cwd === null ? true : !isUnder(proc.cwd, config.instancesRoot);
}

export async function ownedGameProcesses(config = instanceConfig(), reader = null) {
  const outOfReach = userGameOutOfReach(config);
  if (outOfReach) throw new Error(`Cannot list the game's processes: ${outOfReach}`);
  return (await scanGameProcesses(reader ?? defaultProcReader())).filter(proc => ownsProcess(proc, config));
}

export async function isGameRunning(config = instanceConfig(), reader = null) {
  if (userGameOutOfReach(config)) return null;
  reader ??= defaultProcReader();
  if (!isWindows() && isLinux()) {
    try {
      return (await ownedGameProcesses(config, reader)).length > 0;
    } catch {
      return null;
    }
  }
  return nameBasedGameRunning();
}

export async function nameBasedGameRunning({ platform = process.platform, run = runChild } = {}) {
  if (isWindows(platform)) return isGameRunningWindows(run);

  const { code, error } = await run('sh', ['-c', POSIX_GAME_CHECK_CMD], { capture: false });
  if (error) return null;
  if (code === 0) return true;
  if (code === 1) return false;
  return null; // 127 = pgrep missing, 2/3 = pgrep failure
}

async function isGameRunningWindows(run = runChild) {
  let sawUsableAnswer = false;

  for (const image of WINDOWS_IMAGE_NAMES) {
    const { code, stdout, error } = await run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH']);
    // tasklist exits 0 even when the filter matches nothing, so inspect output.
    if (error || code !== 0) continue;
    sawUsableAnswer = true;
    if (stdout.toLowerCase().includes(image.toLowerCase())) return true;
  }

  return sawUsableAnswer ? false : null;
}

const WINDOWS_GAME_FILTER = WINDOWS_IMAGE_NAMES.map(image => `Name='${image}'`).join(' OR ');
const WINDOWS_DOORSTOP_FILTER = `(${WINDOWS_GAME_FILTER}) AND CommandLine LIKE '%--doorstop-target%'`;
const WMIC_DOORSTOP_FILTER = `(${WINDOWS_IMAGE_NAMES.map(image => `name='${image}'`).join(' or ')}) and CommandLine like '%--doorstop-target%'`;

function windowsProcessScript(filter) {
  return `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { ` +
    `[pscustomobject]@{ start = $_.CreationDate.ToUniversalTime().ToString('o'); ` +
    `commandLine = $_.CommandLine; path = $_.ExecutablePath } } | ConvertTo-Json -Compress`;
}

export async function windowsProcesses(filter, run = runChild) {
  // An encoded command reaches PowerShell intact, whatever quoting the filter carries
  const encoded = Buffer.from(windowsProcessScript(filter), 'utf16le').toString('base64');
  // WMIC is disabled by default on current Windows 11
  const { code, stdout, error } = await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  if (error || code !== 0) return null;
  const text = String(stdout ?? '').trim();
  if (text === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => ({
      startMs: typeof entry.start === 'string' ? Date.parse(entry.start) : NaN,
      commandLine: typeof entry.commandLine === 'string' ? entry.commandLine : '',
      path: typeof entry.path === 'string' ? entry.path : null,
    }));
}

export async function windowsGameStartTime(run = runChild) {
  const processes = await windowsProcesses(WINDOWS_GAME_FILTER, run);
  if (processes !== null) {
    const starts = processes.map(proc => proc.startMs).filter(Number.isFinite);
    return starts.length > 0 ? Math.min(...starts) : null;
  }

  const starts = [];
  for (const image of WINDOWS_IMAGE_NAMES) {
    const { code, stdout, error } = await run('wmic', [
      'process', 'where', `name='${image}'`, 'get', 'CreationDate',
    ]);
    if (error || code !== 0) continue;
    for (const line of stdout.replace(/\0/g, '').split('\n')) {
      const parsed = parseWmicCreationDate(line);
      if (parsed !== null) starts.push(parsed);
    }
  }
  return starts.length > 0 ? Math.min(...starts) : null;
}

export function parseWmicCreationDate(raw) {
  const match = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{1,4})/.exec(String(raw).trim());
  if (!match) return null;
  const utc = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
    Math.floor(Number(match[7]) / 1000),
  );
  return utc - Number(match[8]) * 60000;
}

function pidsFrom(result) {
  if (result.error || result.code !== 0) return [];
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

// Number('') is 0, which would read as "started this instant", so blank lines go first
export function startFromEtimes(stdout, now = Date.now(), pick = 'earliest') {
  const seconds = String(stdout ?? '').split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter(value => Number.isFinite(value));
  if (seconds.length === 0) return null;
  return now - (pick === 'latest' ? Math.min(...seconds) : Math.max(...seconds)) * 1000;
}

export function startFromLstart(stdout, pick = 'earliest') {
  const times = String(stdout ?? '').split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map(line => Date.parse(line))
    .filter(value => Number.isFinite(value));
  if (times.length === 0) return null;
  return pick === 'latest' ? Math.max(...times) : Math.min(...times);
}

export async function gameStartTime(config = instanceConfig(), reader = null) {
  if (userGameOutOfReach(config)) return null;
  reader ??= defaultProcReader();
  if (isLinux()) {
    let owned;
    try {
      owned = await ownedGameProcesses(config, reader);
    } catch {
      return null;
    }
    // Command-line matches include the launcher chain, so the game is the last of them to start
    const exact = owned.filter(proc => proc.match === 'comm');
    const pool = exact.length > 0 ? exact : owned;
    const starts = pool.map(proc => proc.startMs).filter(Number.isFinite);
    if (starts.length === 0) return null;
    return exact.length > 0 ? Math.min(...starts) : Math.max(...starts);
  }

  if (isWindows()) return windowsGameStartTime();

  const byName = pidsFrom(await runChild('sh', ['-c', POSIX_GAME_PID_CMD]));
  // Command-line matches include the launcher chain, so the game is the last of them to start
  const pick = byName.length > 0 ? 'earliest' : 'latest';
  const pids = byName.length > 0
    ? byName
    : pidsFrom(await runChild('sh', ['-c', POSIX_GAME_CMDLINE_PID_CMD]));
  if (pids.length === 0) return null;

  // etimes (elapsed seconds) is procps/BSD only; lstart is the portable answer.
  const elapsed = await runChild('ps', ['-o', 'etimes=', '-p', pids.join(',')]);
  if (!elapsed.error && elapsed.code === 0) {
    const start = startFromEtimes(elapsed.stdout, Date.now(), pick);
    if (start !== null) return start;
  }

  const started = await runChild('ps', ['-o', 'lstart=', '-p', pids.join(',')]);
  if (!started.error && started.code === 0) {
    const start = startFromLstart(started.stdout, pick);
    if (start !== null) return start;
  }

  return null;
}

const STEAM_MANIFEST = `appmanifest_${STEAM_APP_ID}.acf`;
const GOG_INFO_RE = /^goggame-\d+\.info$/;

function unixPathOfWineArg(arg) {
  // Proton hands the game a Windows path, and its Z: drive is the Unix root
  if (/^[zZ]:[\\/]/.test(arg)) return arg.slice(2).replace(/\\/g, '/');
  return arg.startsWith('/') ? arg : null;
}

export async function runningGameDir(config = instanceConfig(), {
  reader = null,
  platform = process.platform,
  run = runChild,
} = {}) {
  if (userGameOutOfReach(config)) return null;
  reader ??= defaultProcReader();
  if (platform === 'linux') {
    let owned;
    try {
      owned = await ownedGameProcesses(config, reader);
    } catch {
      return null;
    }
    for (const proc of owned.filter(entry => entry.match === 'comm')) {
      const exe = await reader.exe?.(proc.pid);
      if (exe) return path.dirname(exe.replace(/ \(deleted\)$/, ''));
    }
    for (const proc of owned) {
      const token = nulTokens(await reader.cmdline(proc.pid)).find(arg => GAME_EXE_ARG_RE.test(arg));
      const exe = token ? unixPathOfWineArg(token) : null;
      if (exe) return path.dirname(exe);
    }
    return null;
  }
  if (isWindows(platform)) {
    const exe = (await windowsProcesses(WINDOWS_GAME_FILTER, run))?.find(proc => proc.path)?.path;
    return exe ? path.win32.dirname(exe) : null;
  }
  return null;
}

export async function storeOfGameDir(dir, fileSystem = fsp) {
  let entries;
  try {
    entries = await fileSystem.readdir(dir);
  } catch {
    return { store: null, storeBuild: null };
  }

  const gogInfo = entries.find(name => GOG_INFO_RE.test(name));
  if (gogInfo) {
    let storeBuild = null;
    try {
      const info = JSON.parse(await fileSystem.readFile(path.join(dir, gogInfo), 'utf8'));
      if (info?.buildId !== undefined && info.buildId !== null) storeBuild = String(info.buildId);
    } catch {}
    return { store: 'gog', storeBuild };
  }

  const pathOps = /^[A-Za-z]:[\\/]/.test(dir) ? path.win32 : path;
  const common = pathOps.dirname(dir);
  const steamapps = pathOps.dirname(common);
  if (pathOps.basename(common).toLowerCase() === 'common' && pathOps.basename(steamapps).toLowerCase() === 'steamapps') {
    let storeBuild = null;
    try {
      const manifest = await fileSystem.readFile(pathOps.join(steamapps, STEAM_MANIFEST), 'utf8');
      storeBuild = /"buildid"\s+"(\d+)"/i.exec(manifest)?.[1] ?? null;
    } catch {}
    return { store: 'steam', storeBuild };
  }
  return { store: null, storeBuild: null };
}

export async function gameBuild(config = instanceConfig(), { fileSystem = fsp, ...options } = {}) {
  const gameDir = await runningGameDir(config, options);
  if (gameDir === null) return null;
  return { ...(await storeOfGameDir(gameDir, fileSystem)), gameDir };
}

// prune is for the paths that act on the answer; a mere ownership question leaves the file alone,
// since a pidfile written moments ago names a game that has not exec'd into its own cwd yet
export async function readValidatedPidfile(config, { reader = defaultProcReader(), fileSystem = fsp, prune = false } = {}) {
  if (!config.isAgentInstance) return null;

  let raw;
  try {
    raw = await fileSystem.readFile(config.pidfile, 'utf8');
  } catch {
    return null;
  }

  const pid = Number(String(raw).trim());
  const valid = Number.isInteger(pid) && pid > 0
    && (await matchGameProcess(reader, pid)) !== null
    && isUnder(await reader.cwd(pid), config.workDir);
  if (valid) return pid;

  if (prune) {
    try {
      await fileSystem.unlink(config.pidfile);
    } catch {}
  }
  return null;
}

function pidIsAlive(kill, pid) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else
    return error?.code !== 'ESRCH';
  }
}

let instanceCommandRunner = runChild;

export function setInstanceCommandRunner(run = runChild) {
  instanceCommandRunner = run;
}

export function realKill(pid, signal) {
  if (process.env.UNITY_INSPECTOR_TEST && signal !== 0) {
    throw new Error(
      `Refusing to signal pid ${pid} while UNITY_INSPECTOR_TEST is set: it may be a real game. ` +
      'A test must inject kill.'
    );
  }
  return process.kill(pid, signal);
}
let killSignaller = realKill;

// The tests drive the stop path that runs without an injected kill
export function setKillSignaller(kill = realKill) {
  killSignaller = kill;
}

let instanceModeVerdict = null;
let instanceModeProbe = null;
let probeFailure = null;

// null means the lazy probe has not run yet, which is not the same as a launcher without the mode
export function instanceModeChecked() {
  return instanceModeVerdict;
}

export function instanceProbeFailure() {
  return probeFailure;
}

export function resetInstanceModeProbe(verdict = null) {
  instanceModeVerdict = verdict;
  instanceModeProbe = null;
  probeFailure = null;
  helpCaptures.clear();
}

function describeHelpFailure({ text, code, error }) {
  if (error?.code === 'ETIMEDOUT') return `it ${error.message}`;
  if (error) return `it could not be run (${error.message})`;
  const first = String(text ?? '').split('\n').map(line => line.trim()).find(Boolean);
  return `it exited with status ${code}${first ? `: ${first.slice(0, 200)}` : ''}`;
}

// A launcher without an instance mode takes `instance` for a profile name and launches the game.
// One verdict per process — every path asks the same configured launcher the same question — but
// only from a `--help` that answered: one that could not run, timed out or exited non-zero settles
// nothing, and leaves the verdict unset for the caller to ask again
export function probeLauncherHelp(command, args, { runProbe = instanceCommandRunner, timeoutMs = INSTANCE_PROBE_TIMEOUT_MS } = {}) {
  if (instanceModeVerdict !== null) return Promise.resolve(instanceModeVerdict);

  instanceModeProbe ??= (async () => {
    const help = await captureCommandHelp(command, args, { run: runProbe, timeoutMs });
    if (!help.error && help.code === 0) {
      instanceModeVerdict = INSTANCE_HELP_RE.test(help.text);
      probeFailure = null;
    } else {
      probeFailure = describeHelpFailure(help);
      // The capture is memoized per command line, and a failed one must not be replayed to the retry
      forgetCommandHelp(command, args);
    }
    instanceModeProbe = null;
    return instanceModeVerdict === true;
  })();
  return instanceModeProbe;
}

export function probeInstanceMode(config, options = {}) {
  // A session with no instance of its own still asks, since the instances root comes from the same
  // launcher and is what tells the user's game from another session's
  if (!config.launchCommand) return Promise.resolve(false);
  // The setting's own leading arguments belong to every verb, `--help` included
  return probeLauncherHelp(config.launchCommand, config.leadingArgs, options);
}

// Whatever the command printed, and how it ended: usage on a non-zero exit is still usage
export async function runCommandCapture(command, args = [], { run = instanceCommandRunner, timeoutMs = COMMAND_CAPTURE_TIMEOUT_MS } = {}) {
  try {
    const { code, stdout, stderr, error } = await run(command, args, { timeoutMs });
    return { text: `${stdout ?? ''}${stderr ?? ''}`.trim(), code: code ?? null, error: error ?? null };
  } catch (error) {
    return { text: '', code: null, error };
  }
}

// One `--help` run per command line, so a program named as both the launch command and the instance
// launcher is asked once and its answer serves the instance probe and the argument channel alike
const helpCaptures = new Map();

export function forgetCommandHelp(command, args = []) {
  helpCaptures.delete(JSON.stringify([command, ...args]));
}

export function captureCommandHelp(command, args = [], options = {}) {
  const key = JSON.stringify([command, ...args]);
  let capture = helpCaptures.get(key);
  if (capture === undefined) {
    // One budget for the one run, whether the probe or the argument channel asked for it
    capture = runCommandCapture(command, [...args, '--help'], { timeoutMs: INSTANCE_PROBE_TIMEOUT_MS, ...options });
    helpCaptures.set(key, capture);
  }
  return capture;
}

export function summarizeInstanceList(text) {
  const objects = [];
  let unparsed = 0;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objects.push(parsed);
      else unparsed++;
    } catch {
      unparsed++;
    }
  }
  if (objects.length === 0) return null;

  // The header is the object that names no instance; instancesRoot is where they live
  const header = objects.find(entry => entry.id === undefined) ?? null;
  const cap = header?.cap === null || header?.cap === undefined ? NaN : Number(header.cap);
  const headerPath = (key) => (typeof header?.[key] === 'string' && header[key] !== '' ? header[key] : null);
  const isSet = (flag) => flag === true || flag === 1 || flag === 'true';
  const describe = (entry) => ({
    id: String(entry.id),
    port: entry.port ?? null,
    last_launch: entry.last_launch ?? null,
    stale: entry.stale ?? null,
  });
  const listed = objects.filter(entry => entry.id !== undefined && entry.id !== null && String(entry.id) !== '');
  const running = listed.filter(entry => isSet(entry.running)).map(describe);
  const holders = listed
    .filter(entry => isSet(entry.running) || isSet(entry.launching))
    .map(entry => (isSet(entry.running) ? describe(entry) : { ...describe(entry), launching: true }));

  return {
    instancesRoot: headerPath('instancesRoot'),
    stageRoot: headerPath('stageRoot'),
    cap: Number.isInteger(cap) && cap >= 0 ? cap : null,
    running,
    ids: running.map(entry => entry.id),
    holders,
    count: Number.isInteger(header?.count) && header.count >= 0 ? header.count : running.length,
    unparsed,
  };
}

export async function listInstances(config, { run = instanceCommandRunner, timeoutMs = LIST_COMMAND_TIMEOUT_MS } = {}) {
  const { code, stdout, error } = await run(config.launchCommand, config.listArgs, { timeoutMs });
  if (error || code !== 0) return null;
  return summarizeInstanceList(stdout);
}

export async function removeInstance(config, { run = instanceCommandRunner, timeoutMs = REMOVE_COMMAND_TIMEOUT_MS } = {}) {
  const display = [config.launchCommand, ...config.removeArgs].join(' ');
  const outcome = await run(config.launchCommand, config.removeArgs, { timeoutMs });
  const failure = commandFailure(display, outcome);
  if (failure) {
    return {
      removed: false,
      detail: failure + (outcome.error?.code === 'ETIMEDOUT' ? '; what it had started may still be deleting the directory' : ''),
    };
  }
  return { removed: true, detail: `Removed instance ${config.id} with \`${display}\`` };
}

// A stop that left nothing running stopped the game, and its exit status is a note on how
const stopNote = (attempt) => (attempt.failure ? `, though ${attempt.failure}` : '');

// Run the launcher's own stop and let /proc, not the command, say whether it worked
async function stopThroughLauncher(config, { command, args, runStop, timeoutMs, reader }) {
  const display = [command, ...args].join(' ');
  const outcome = await runStop(command, args, { timeoutMs });
  invalidateGameProcessScan();

  const failure = commandFailure(display, outcome);

  // Whatever the command claimed, /proc has the last word on what is still running
  let remaining;
  try {
    remaining = (await ownedGameProcesses(config, reader)).map(proc => proc.pid);
  } catch (err) {
    return { display, failure: failure ?? `\`${display}\` reported success but /proc could not confirm it (${err.message})` };
  }

  if (remaining.length > 0) {
    return {
      display,
      remaining,
      exitedCleanly: failure === null,
      failure: failure ?? `\`${display}\` reported success but pid ${remaining.join(', ')} was still running`,
    };
  }
  // The command's exit status is a note; what is left in /proc is the verdict
  return { display, failure, remaining, cleared: true };
}

// The launcher's stop tears the instance's display down as well, which killing its pid cannot do
async function stopThroughInstanceCommand(config, { runStop, timeoutMs, reader, fileSystem, hadTargets }) {
  const attempt = await stopThroughLauncher(config, {
    command: config.launchCommand,
    args: config.stopArgs,
    runStop,
    timeoutMs,
    reader,
  });
  if (!attempt.cleared) return attempt;
  // With nothing to stop, a command that failed is worth reporting as the failure it was
  if (attempt.failure && !hadTargets) return attempt;

  try {
    await fileSystem.unlink(config.pidfile);
  } catch {}
  return {
    result: hadTargets
      ? { killed: true, detail: `Stopped instance ${config.id} with \`${attempt.display}\`${stopNote(attempt)}` }
      // Nothing was stopped, but the tidy-up the launcher was asked for is what succeeded here
      : { killed: false, tidied: true, detail: `No Broforce process is running for instance ${config.id}; \`${attempt.display}\` tidied the instance up` },
  };
}

// The user's own stop command, which knows how their game was started
async function stopUserGameThroughCommand(config, { command, args, runStop, timeoutMs, reader }) {
  const attempt = await stopThroughLauncher(config, {
    command,
    args,
    runStop,
    timeoutMs,
    reader,
  });
  return attempt.cleared
    ? { result: { killed: true, detail: `Stopped the user's game with \`${attempt.display}\`${stopNote(attempt)}` } }
    : attempt;
}

// The command that stops the user's game, when the user configured one
export function userStopCommand(env = process.env) {
  const custom = (env.BROFORCE_STOP_CMD || '').trim();
  if (!custom) return null;
  try {
    const tokens = tokenizeCommand(custom);
    return tokens.length > 0 ? tokens : null;
  } catch {
    return null;
  }
}

async function killGameLinux({
  config = instanceConfig(),
  reader = defaultProcReader(),
  fileSystem = fsp,
  kill = killSignaller,
  graceMs = KILL_GRACE_MS,
  pollMs = KILL_POLL_MS,
  confirmMs = KILL_CONFIRM_MS,
  runStop = instanceCommandRunner,
  stopTimeoutMs = STOP_COMMAND_TIMEOUT_MS,
  runProbe = instanceCommandRunner,
  probeTimeoutMs = INSTANCE_PROBE_TIMEOUT_MS,
  env = process.env,
  // Why the pid-scoped kill of the user's game must not run, when something says it must not
  signalRefusal = null,
} = {}) {
  const label = config.isAgentInstance ? `instance ${config.id}` : "the user's game";

  let targets = [];
  const pidfilePid = await readValidatedPidfile(config, { reader, fileSystem, prune: true });
  if (pidfilePid !== null) {
    targets = [pidfilePid];
  } else {
    try {
      targets = (await ownedGameProcesses(config, reader)).map(proc => proc.pid);
    } catch (error) {
      return { killed: false, unknown: true, detail: `Could not read /proc to find the game process: ${error.message}` };
    }
  }

  let stopCommandFailure = null;
  let stopCommandExitedCleanly = false;
  let stopCommandDisplay = null;
  if (config.isAgentInstance) {
    if (await probeInstanceMode(config, { runProbe, timeoutMs: probeTimeoutMs })) {
      const attempt = await stopThroughInstanceCommand(config, {
        runStop,
        timeoutMs: stopTimeoutMs,
        reader,
        fileSystem,
        hadTargets: targets.length > 0,
      });
      if (attempt.result) return attempt.result;
      stopCommandFailure = attempt.failure;
      stopCommandExitedCleanly = attempt.exitedCleanly === true;
      stopCommandDisplay = attempt.display;
      targets = attempt.remaining ?? targets.filter(pid => pidIsAlive(kill, pid));
    } else {
      stopCommandFailure = `${config.launchCommand} has no instance mode`;
    }
  } else if (targets.length > 0) {
    // BROFORCE_STOP_CMD is how the user stops their own game; the signal is the fallback
    const stopTokens = userStopCommand(env);
    if (stopTokens !== null) {
      const attempt = await stopUserGameThroughCommand(config, {
        command: stopTokens[0],
        args: stopTokens.slice(1),
        runStop,
        timeoutMs: stopTimeoutMs,
        reader,
      });
      if (attempt.result) return attempt.result;
      stopCommandFailure = attempt.failure;
      stopCommandExitedCleanly = attempt.exitedCleanly === true;
      stopCommandDisplay = attempt.display;
      targets = attempt.remaining ?? targets.filter(pid => pidIsAlive(kill, pid));
    }
  }

  if (targets.length === 0) {
    return {
      killed: false,
      detail: `No Broforce process is running for ${label}`
        + (stopCommandFailure ? ` (${stopCommandFailure})` : ''),
    };
  }

  // The configured stop command is the user's own tool and has already had its turn; the signal is
  // this server's, and it is refused while the processes it would take down cannot be told apart
  if (signalRefusal !== null && !config.isAgentInstance) {
    return {
      killed: false,
      unknown: true,
      detail: `Did not signal ${label} (pid ${targets.join(', ')}): ${signalRefusal}`
        + (stopCommandFailure ? `; ${stopCommandFailure}` : ''),
    };
  }

  const failures = [];
  let signalled = [];
  for (const pid of targets) {
    try {
      kill(pid, 'SIGTERM');
      signalled.push(pid);
    } catch (error) {
      if (error?.code !== 'ESRCH') failures.push(`pid ${pid}: ${error.message}`);
    }
  }

  const signalledAny = signalled.length;
  const deadline = Date.now() + graceMs;
  while (signalled.length > 0 && Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    signalled = signalled.filter(pid => pidIsAlive(kill, pid));
  }
  for (const pid of signalled) {
    try {
      kill(pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') failures.push(`pid ${pid}: ${error.message}`);
    }
  }

  // A killed process leaves the table a moment later, so one look is not an answer
  const confirmDeadline = Date.now() + confirmMs;
  let survivors = targets.filter(pid => pidIsAlive(kill, pid));
  while (survivors.length > 0 && Date.now() < confirmDeadline) {
    await delay(Math.min(pollMs, Math.max(0, confirmDeadline - Date.now())));
    survivors = survivors.filter(pid => pidIsAlive(kill, pid));
  }
  if (config.isAgentInstance && survivors.length === 0) {
    try {
      await fileSystem.unlink(config.pidfile);
    } catch {}
  }
  invalidateGameProcessScan();

  if (survivors.length === targets.length) {
    return {
      killed: false,
      unknown: true,
      survivors,
      detail: (stopCommandFailure ? `${stopCommandFailure}. ` : '')
        + `Could not stop ${label} (pid ${survivors.join(', ')})`
        + (failures.length > 0 ? `: ${failures.join('; ')}` : ', which is still running'),
    };
  }
  if (signalledAny === 0 && failures.length === 0) {
    // The stop command's own target can leave between its exit and the signal, and that counts as stopped
    return stopCommandExitedCleanly
      ? { killed: true, detail: `Stopped ${label} with \`${stopCommandDisplay}\`` }
      : { killed: false, detail: `The game process of ${label} had already exited` };
  }
  // A stop that left one of several processes behind is not a clean stop, whatever it managed
  return {
    killed: survivors.length === 0,
    survivors,
    detail: `Stopped ${label} (pid ${targets.filter(pid => !survivors.includes(pid)).join(', ')})`
      + (stopCommandFailure ? ` by signal (${stopCommandFailure})` : '')
      + (survivors.length > 0 ? `; pid ${survivors.join(', ')} is still running` : '')
      + (failures.length > 0 ? `; ${failures.join('; ')}` : ''),
  };
}

export async function killGame(options = {}) {
  const {
    platform = process.platform,
    run = runChild,
    confirmMs = NAME_KILL_CONFIRM_MS,
    pollMs = NAME_KILL_POLL_MS,
  } = options;
  const outOfReach = userGameOutOfReach(options.config ?? instanceConfig(), options.env);
  if (outOfReach) {
    return { killed: false, unknown: true, detail: `Could not stop the user's game: ${outOfReach}` };
  }
  if (platform === 'linux') return killGameLinux(options);
  if (run === runChild && process.env.UNITY_INSPECTOR_TEST) {
    throw new Error(
      `Refusing to kill Broforce by name on ${platform} while UNITY_INSPECTOR_TEST is set: it may be a real game. ` +
      'A test must inject run.'
    );
  }

  const signalled = await killGameByName(platform, run);
  if (!signalled.killed) return signalled;

  const deadline = Date.now() + confirmMs;
  for (;;) {
    const running = await nameBasedGameRunning({ platform, run });
    if (running === false) return signalled;
    if (running === null) {
      return { ...signalled, detail: `${signalled.detail}; whether it has exited could not be checked` };
    }
    if (Date.now() >= deadline) {
      return {
        killed: false,
        unknown: true,
        detail: `${signalled.detail}, but a Broforce process was still running ${confirmMs / 1000}s later`,
      };
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

async function killGameByName(platform, run) {
  if (isWindows(platform)) {
    const killedImages = [];
    const failures = [];
    for (const image of WINDOWS_IMAGE_NAMES) {
      const { code, error, stderr } = await run('taskkill', ['/F', '/IM', image]);
      if (error) {
        failures.push(`could not run taskkill for ${image}: ${error.message}`);
      } else if (code === 0) {
        killedImages.push(image);
      } else if (code !== 128) {
        // 128 = "process not found", which is not a failure worth reporting.
        failures.push(`${image}: taskkill exited ${code}${stderr.trim() ? ` (${stderr.trim()})` : ''}`);
      }
    }
    if (killedImages.length > 0) {
      return { killed: true, detail: `Killed ${killedImages.join(', ')}` };
    }
    if (failures.length > 0) {
      return { killed: false, unknown: true, detail: failures.join('; ') };
    }
    return { killed: false, detail: 'No Broforce process was running' };
  }

  // The kill command silences stderr, so a missing pkill (127) would otherwise read as a clean no-op
  const probe = await run('sh', ['-c', 'command -v pkill >/dev/null 2>&1'], { capture: false });
  if (probe.error || probe.code !== 0) {
    return {
      killed: false,
      unknown: true,
      detail: 'pkill is not available on this system, so the game could not be stopped',
    };
  }

  const { code, error, stderr } = await run('sh', ['-c', POSIX_GAME_KILL_CMD]);
  if (error) {
    return { killed: false, unknown: true, detail: `Could not run pkill: ${error.message}` };
  }
  if (code === 0) {
    return { killed: true, detail: 'Killed the running Broforce process' };
  }
  if (code !== 1) {
    return {
      killed: false,
      unknown: true,
      detail: `pkill exited ${code}${stderr.trim() ? ` (${stderr.trim()})` : ''}`,
    };
  }
  return { killed: false, detail: 'No Broforce process was running' };
}

// The bracketed "[d]oorstop" keeps the pattern from matching the `sh -c` wrapper that carries it
export const POSIX_DOORSTOP_SCAN_CMD = "pgrep -lf '[d]oorstop-target'";

const DOORSTOP_TARGET_FLAGS = ['--doorstop-target-assembly', '--doorstop-target'];
const DOORSTOP_TARGET_VARS = ['DOORSTOP_TARGET_ASSEMBLY', 'DOORSTOP_INVOKE_DLL_PATH'];
const UMM_LOG_NAME = 'Log.txt';
// macOS joins argv with plain spaces and Windows need not quote, so an unquoted target runs to the first .dll ending a token
const DOORSTOP_TARGET_ARG_RE = /(?:^|\s)"?--doorstop-target(?:-assembly)?"?\s+(?:"([^"\n]*)"|([^\s"][^"\n]*?\.dll)(?=\s|$))/gim;

export function doorstopTargetsIn(text) {
  return [...String(text ?? '').matchAll(DOORSTOP_TARGET_ARG_RE)].map(match => match[1] ?? match[2]).filter(Boolean);
}

function ummLogBesideTarget(targets, pathOps) {
  const distinct = new Set(targets);
  if (distinct.size !== 1) return null;
  return pathOps.join(pathOps.dirname([...distinct][0]), UMM_LOG_NAME);
}

function environOf(text) {
  const env = new Map();
  for (const entry of nulTokens(text)) {
    const split = entry.indexOf('=');
    if (split > 0) env.set(entry.slice(0, split), entry.slice(split + 1));
  }
  return env;
}

function absoluteIn(env, key) {
  const value = env.get(key);
  return value && path.isAbsolute(value) ? path.resolve(value) : null;
}

function doorstopTargetInArgv(argv) {
  for (let i = 0; i + 1 < argv.length; i++) {
    if (!DOORSTOP_TARGET_FLAGS.includes(argv[i])) continue;
    const target = unixPathOfWineArg(argv[i + 1]);
    if (target) return target;
  }
  return null;
}

// run_umm.sh turns the Doorstop argument into a variable before it execs the game, so the target is on
// the game's argv, its environment, or the command line of a process that started it
async function launchOfProcess(reader, pid) {
  const env = environOf(await reader.environ?.(pid));
  const xdg = absoluteIn(env, 'XDG_CONFIG_HOME');
  const home = absoluteIn(env, 'HOME');
  const winePrefix = absoluteIn(env, 'WINEPREFIX');
  const compatData = absoluteIn(env, 'STEAM_COMPAT_DATA_PATH');
  const found = {
    configHome: xdg ?? (home ? path.join(home, '.config') : null),
    winePrefix: winePrefix ?? (compatData ? path.join(compatData, 'pfx') : null),
    doorstopTarget: doorstopTargetInArgv(nulTokens(await reader.cmdline(pid))),
  };
  for (const key of DOORSTOP_TARGET_VARS) {
    found.doorstopTarget ??= env.has(key) ? unixPathOfWineArg(env.get(key)) : null;
  }

  let ancestor = parseStatPpid(await reader.stat(pid));
  for (let step = 0; step < DOORSTOP_ANCESTOR_DEPTH && !found.doorstopTarget && ancestor !== null && ancestor > 1; step++) {
    const stat = await reader.stat(ancestor);
    found.doorstopTarget = doorstopTargetInArgv(nulTokens(await reader.cmdline(ancestor)));
    ancestor = parseStatPpid(stat);
  }
  return found;
}

const NO_GAME_DATA = Object.freeze({ configHomes: [], winePrefixes: [], ummLog: null, ummLogs: [] });
let rememberedGameData = null;

export function forgetGameDataLocations() {
  rememberedGameData = null;
}

const rememberedGameDataOrNone = () => (rememberedGameData ? { ...rememberedGameData, ummLog: null } : NO_GAME_DATA);

const NO_UNPLACEABLE_INSTANCES = async () => null;
let unplaceableInstances = NO_UNPLACEABLE_INSTANCES;

// While instances cannot be placed every Broforce process reads as the user's, another session's included
export function setUnplaceableInstancesCheck(check = null) {
  unplaceableInstances = check ?? NO_UNPLACEABLE_INSTANCES;
}

async function instancesPlaceable() {
  try {
    return (await unplaceableInstances()) === null;
  } catch {
    return false;
  }
}

async function deriveGameData(config, reader) {
  const configHomes = new Set();
  const winePrefixes = new Set();
  const targets = new Set();
  for (const proc of await ownedGameProcesses(config, reader)) {
    const found = await launchOfProcess(reader, proc.pid);
    if (found.configHome) configHomes.add(found.configHome);
    if (found.winePrefix) winePrefixes.add(found.winePrefix);
    if (found.doorstopTarget) targets.add(path.resolve(found.doorstopTarget));
  }
  return {
    configHomes: [...configHomes],
    winePrefixes: [...winePrefixes],
    ummLog: ummLogBesideTarget(targets, path),
    ummLogs: [...targets].map(target => path.join(path.dirname(target), UMM_LOG_NAME)),
  };
}

export async function gameDataLocations(config = instanceConfig(), reader = null) {
  if (config?.isAgentInstance || userGameOutOfReach(config) || !isLinux()) return NO_GAME_DATA;
  if (!(await instancesPlaceable())) return rememberedGameDataOrNone();
  let derived = null;
  try {
    reader ??= defaultProcReader();
    derived = await deriveGameData(config, reader);
  } catch {}
  if (derived && (derived.configHomes.length > 0 || derived.winePrefixes.length > 0 || derived.ummLogs.length > 0)) {
    rememberedGameData = derived;
    return derived;
  }
  return rememberedGameDataOrNone();
}

export async function windowsActiveUmmLog(run = runChild) {
  const processes = await windowsProcesses(WINDOWS_DOORSTOP_FILTER, run);
  if (processes !== null) {
    return ummLogBesideTarget(processes.flatMap(proc => doorstopTargetsIn(proc.commandLine)), path.win32);
  }

  const { code, stdout, error } = await run('wmic', [
    'process', 'where', WMIC_DOORSTOP_FILTER, 'get', 'CommandLine',
  ]);
  if (error || code !== 0) return null;
  // wmic emits UTF-16LE when redirected; dropping the NULs recovers the command lines
  return ummLogBesideTarget(doorstopTargetsIn(stdout.replace(/\0/g, '')), path.win32);
}

// UMM writes its log beside its own assembly, which is the Doorstop target the running game was given
export async function activeUmmLog(config = instanceConfig(), { reader = null, platform = process.platform, run = runChild } = {}) {
  if (config?.isAgentInstance || userGameOutOfReach(config)) return null;
  if (platform === 'linux') return (await gameDataLocations(config, reader)).ummLog;
  if ((await nameBasedGameRunning({ platform, run })) !== true) return null;
  if (isWindows(platform)) return windowsActiveUmmLog(run);

  const { code, stdout, error } = await run('sh', ['-c', POSIX_DOORSTOP_SCAN_CMD]);
  if (error || code !== 0) return null;
  return ummLogBesideTarget(doorstopTargetsIn(stdout), path.posix);
}

const canonicalDir = (dir) => fsp.realpath(dir).catch(() => path.resolve(dir));

export async function wineserverHoldsPrefix(prefixDir, reader = defaultProcReader()) {
  const wanted = await canonicalDir(prefixDir);
  let pids;
  try {
    pids = await reader.pids();
  } catch {
    return false;
  }
  for (const pid of pids) {
    if (!/^wineserver/.test(String(await reader.comm(pid)))) continue;
    if (parseStatState(await reader.stat(pid)) === 'Z') continue;
    const prefix = /(?:^|\0)WINEPREFIX=([^\0]+)/.exec(String(await reader.environ?.(pid)))?.[1];
    // Proton sets WINEPREFIX to <compatdata>/pfx/, by whichever path to the library Steam was started with
    if (prefix && (await canonicalDir(prefix)) === wanted) return true;
  }
  return false;
}

export const VANILLA_FLAG = '--vanilla';

export function carriesVanillaFlag(args = []) {
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).includes(VANILLA_FLAG);
}

export function composeExtraLaunchArgs({ vanilla, launchArgs } = {}) {
  const given = [];
  if (launchArgs != null) {
    if (typeof launchArgs !== 'string') {
      throw new Error(`launchArgs must be a string, got ${typeof launchArgs}`);
    }
    given.push(...tokenizeCommand(launchArgs));
  }
  const end = given.indexOf('--');
  const forLauncher = end === -1 ? given : given.slice(0, end);
  const forGame = end === -1 ? [] : given.slice(end);
  return {
    vanilla: Boolean(vanilla) || carriesVanillaFlag(given),
    extraArgs: [...forLauncher.filter(arg => arg !== VANILLA_FLAG), ...forGame],
  };
}

function protocolLaunch(ignoredArgs, platform) {
  const url = STEAM_LAUNCH_URL;
  const shapes = {
    win32: { command: 'cmd', args: ['/c', 'start', '', url], display: `cmd /c start "" ${url}` },
    darwin: { command: 'open', args: [url], display: `open ${url}` },
  };
  return {
    ...(shapes[platform] ?? { command: 'xdg-open', args: [url], display: `xdg-open ${url}` }),
    source: 'steam-protocol',
    vanilla: false,
    ignoredArgs,
    ignoredReason: 'the Steam protocol launch does not accept them. Set BROFORCE_LAUNCH_CMD to use a launcher that does.',
    waitsOnExit: true,
    prepare: null,
    startCauses: null,
  };
}

// The target decides: an instance always goes through the launcher's instance mode, and the
// BROFORCE_LAUNCH_CMD override belongs to the user's game alone
export async function resolveLaunchCommand({ vanilla = false, extraArgs = [] } = {}, env = process.env, platform = process.platform, config = null, lookups = {}) {
  const target = config ?? instanceConfig(env);
  const flagged = vanilla ? [VANILLA_FLAG, ...extraArgs] : extraArgs;
  const configured = (source, command, leading) => {
    const args = [...leading, ...flagged];
    return {
      source,
      command,
      args,
      display: [command, ...args].join(' '),
      vanilla: Boolean(vanilla),
      ignoredArgs: [],
      waitsOnExit: true,
      prepare: null,
      startCauses: null,
    };
  };

  if (target.isAgentInstance) return configured('instance', target.launchCommand, target.launchArgs);

  const custom = (env.BROFORCE_LAUNCH_CMD || '').trim();
  if (custom) {
    const tokens = tokenizeCommand(custom);
    if (tokens.length === 0) {
      throw new Error('BROFORCE_LAUNCH_CMD is set but contains no command');
    }
    return configured('BROFORCE_LAUNCH_CMD', tokens[0], tokens.slice(1));
  }

  if (env.UNITY_INSPECTOR_TEST) {
    throw new Error(
      'Refusing a launch through Steam while UNITY_INSPECTOR_TEST is set: it would start the ' +
      "user's real game. Point BROFORCE_LAUNCH_CMD at a command of your own."
    );
  }

  return (await resolveSteamLaunch({ vanilla, extraArgs }, { env, platform, lookups })) ?? protocolLaunch(flagged, platform);
}

let lastSpawn = null;

// What the last spawnDetached asked for, so a test can hold the stdio contract to account
export function lastSpawnOptions() {
  return lastSpawn;
}

const STDERR_DRAIN = fileURLToPath(new URL('./stderr-drain.js', import.meta.url));
let drainProgram = [process.execPath, STDERR_DRAIN];

export function setStderrDrainProgram(program = [process.execPath, STDERR_DRAIN]) {
  drainProgram = program;
}

function startStderrDrain(file, limitBytes, stdin) {
  let fd = null;
  try {
    fs.rmSync(file, { force: true });
    fd = fs.openSync(file, 'wx', 0o600);
    const [command, ...leading] = drainProgram;
    const drain = spawn(command, [...leading, String(limitBytes)], { detached: true, stdio: [stdin, fd, 'ignore'] });
    drain.on('error', () => {});
    drain.stdin?.on('error', () => {});
    if (!drain.pid || (stdin === 'pipe' && !drain.stdin)) {
      drain.stdin?.destroy();
      return null;
    }
    drain.unref();
    drain.stdin?.unref();
    return drain;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const closeFd = (fd) => {
  try { fs.closeSync(fd); } catch {}
};

function pipedHandOff(file, limitBytes) {
  const drain = startStderrDrain(file, limitBytes, 'pipe');
  if (!drain) return null;
  return {
    drain,
    stderr: drain.stdin,
    handedOver: () => {},
    mark: (bytes) => {
      if (!drain.stdin.destroyed) drain.stdin.write(bytes, () => drain.stdin.destroy());
      return true;
    },
    close: () => drain.stdin.destroy(),
  };
}

async function fifoHandOff(file, limitBytes) {
  const fifo = `${file}.${process.pid}-${randomBytes(6).toString('hex')}${LAUNCH_OUTPUT_FIFO_SUFFIX}`;
  const { O_RDONLY, O_WRONLY, O_NONBLOCK } = fs.constants;
  let read = null;
  let write = null;
  let own = null;
  try {
    if ((await runChild('mkfifo', ['-m', '600', fifo], { capture: false })).code !== 0) return null;
    read = fs.openSync(fifo, O_RDONLY | O_NONBLOCK);
    write = fs.openSync(fifo, O_WRONLY);
    // Its own open: status flags are shared by every descriptor of one open, and the command's end must block
    own = fs.openSync(fifo, O_WRONLY | O_NONBLOCK);
  } catch {
    for (const fd of [read, write, own]) if (fd !== null) closeFd(fd);
    return null;
  } finally {
    fs.rmSync(fifo, { force: true });
  }
  const drain = startStderrDrain(file, limitBytes, read);
  closeFd(read);
  if (!drain) {
    closeFd(write);
    closeFd(own);
    return null;
  }
  const handedOver = () => {
    if (write !== null) closeFd(write);
    write = null;
  };
  const close = () => {
    handedOver();
    if (own !== null) closeFd(own);
    own = null;
  };
  return {
    drain,
    stderr: write,
    handedOver,
    mark: (bytes) => {
      if (own === null) return true;
      // Under PIPE_BUF a non-blocking write lands whole or fails with EAGAIN, never blocking or splitting the marker
      try {
        fs.writeSync(own, bytes);
      } catch (err) {
        if (err.code === 'EAGAIN') return false;
      }
      close();
      return true;
    },
    close,
  };
}

async function stderrHandOff(file, limitBytes) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return null;
  }
  return process.platform === 'win32' ? pipedHandOff(file, limitBytes) : fifoHandOff(file, limitBytes);
}

let spawnCommand = spawn;

export function setCommandSpawner(spawner = spawn) {
  spawnCommand = spawner;
}

// stdout stays closed whatever happens: it carries the MCP protocol on this process's own handle
export async function spawnDetached(command, args, { captureStderr = false, stderrTo = null } = {}) {
  let handOff = stderrTo ? await stderrHandOff(stderrTo.file, stderrTo.limitBytes) : null;
  return new Promise((resolve, reject) => {
    let stdio = captureStderr ? ['ignore', 'ignore', 'pipe'] : handOff ? ['ignore', 'ignore', handOff.stderr] : 'ignore';
    let child;
    try {
      try {
        child = spawnCommand(command, args, { detached: true, stdio });
      } catch (err) {
        if (!handOff) throw err;
        handOff.close();
        handOff = null;
        stdio = 'ignore';
        child = spawnCommand(command, args, { detached: true, stdio });
      }
    } catch (err) {
      lastSpawn = { command, args, stdio, drainPid: null };
      reject(err);
      return;
    } finally {
      handOff?.handedOver();
    }
    lastSpawn = { command, args, stdio, drainPid: handOff?.drain.pid ?? null };
    child.stderrHandOff = handOff;

    let settled = false;
    child.on('error', (err) => {
      handOff?.close();
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      // A piped stderr would hold the event loop open for as long as the launcher lives
      child.stderr?.unref?.();
      resolve(child);
    });
  });
}
