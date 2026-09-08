import { spawn } from 'child_process';
import fsp from 'fs/promises';
import path from 'path';

import { instanceConfig } from './instance.js';
import { tokenizeCommand } from './command-line.js';

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
const PROFILE_ANCESTOR_DEPTH = 8;
const CLOCK_TICKS_PER_SECOND = 100;
const KILL_GRACE_MS = 3000;
const KILL_POLL_MS = 100;
const KILL_CONFIRM_MS = 2000;
const STOP_COMMAND_TIMEOUT_MS = 20000;
// The probe and the root discovery both have to settle inside the wrapper's 15s takeover poll
const INSTANCE_PROBE_TIMEOUT_MS = 5000;
// A command asked to print something for a caller, rather than to answer a question this server
// blocks on: the argument-help capture is the only one, and it may take its time
const COMMAND_CAPTURE_TIMEOUT_MS = 10000;
// --help is the only question safe to put to a launcher that may not have an instance mode: one
// without it takes any other first word for a profile name and launches the user's game
const INSTANCE_HELP_RE = /\binstance <id>/;
const LIST_COMMAND_TIMEOUT_MS = 10000;
const REMOVE_COMMAND_TIMEOUT_MS = 20000;

const isWindows = () => process.platform === 'win32';
const isLinux = () => process.platform === 'linux';
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ code: null, signal: 'SIGKILL', stdout, stderr, error: new Error('Timed out') });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => finish({ code: null, signal: null, stdout, stderr, error }));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr, error: null }));
  });
}

export function createProcReader(procRoot = '/proc', fileSystem = fsp) {
  const readText = async (relative) => {
    try {
      return await fileSystem.readFile(path.join(procRoot, relative), 'utf8');
    } catch {
      return null;
    }
  };

  return {
    async pids() {
      const entries = await fileSystem.readdir(procRoot);
      return entries.filter(name => /^\d+$/.test(name));
    },
    comm: (pid) => readText(`${pid}/comm`),
    stat: (pid) => readText(`${pid}/stat`),
    cmdline: (pid) => readText(`${pid}/cmdline`),
    environ: (pid) => readText(`${pid}/environ`),
    async cwd(pid) {
      try {
        return await fileSystem.readlink(path.join(procRoot, String(pid), 'cwd'));
      } catch {
        return null;
      }
    },
    async bootTimeMs() {
      return parseBootTimeMs(await readText('stat'));
    },
  };
}

// One process per line: a flag and the path it carries have to stay on the same line
const nulSeparated = (text) => String(text ?? '').replace(/\0/g, ' ');
const nulTokens = (text) => String(text ?? '').split('\0').filter(Boolean);

let sharedReader = null;

// One reader instance, so the scan cache can key on it
export function defaultProcReader() {
  sharedReader ??= createProcReader();
  return sharedReader;
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

    const ticks = parseStatStartTicks(await reader.stat(pid));
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
  if (config.isAgentInstance) {
    // Without the launcher's root there is no work directory to compare against, and answering
    // "not ours" for every process would read as an instance with no game running
    if (!config.workDir) throw new Error(`Instance ${config.id} has no known root yet`);
    return isUnder(proc.cwd, config.workDir);
  }
  // An unreadable cwd belongs to a process of another user, which is never an agent instance
  return proc.cwd === null ? true : !isUnder(proc.cwd, config.instancesRoot);
}

export async function ownedGameProcesses(config = instanceConfig(), reader = defaultProcReader()) {
  return (await scanGameProcesses(reader)).filter(proc => ownsProcess(proc, config));
}

export async function isGameRunning(config = instanceConfig(), reader = defaultProcReader()) {
  if (isWindows()) return isGameRunningWindows();

  if (isLinux()) {
    try {
      return (await ownedGameProcesses(config, reader)).length > 0;
    } catch {
      return null;
    }
  }

  const { code, error } = await runChild('sh', ['-c', POSIX_GAME_CHECK_CMD], { capture: false });
  if (error) return null;
  if (code === 0) return true;
  if (code === 1) return false;
  return null; // 127 = pgrep missing, 2/3 = pgrep failure
}

async function isGameRunningWindows() {
  let sawUsableAnswer = false;

  for (const image of WINDOWS_IMAGE_NAMES) {
    const { code, stdout, error } = await runChild('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH']);
    // tasklist exits 0 even when the filter matches nothing, so inspect output.
    if (error || code !== 0) continue;
    sawUsableAnswer = true;
    if (stdout.toLowerCase().includes(image.toLowerCase())) return true;
  }

  return sawUsableAnswer ? false : null;
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

export async function gameStartTime(config = instanceConfig(), reader = defaultProcReader()) {
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

  if (isWindows()) {
    const starts = [];
    for (const image of WINDOWS_IMAGE_NAMES) {
      const { code, stdout, error } = await runChild('wmic', [
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

const realKill = (pid, signal) => process.kill(pid, signal);
let killSignaller = realKill;

// The tests drive the stop path that runs without an injected kill
export function setKillSignaller(kill = realKill) {
  killSignaller = kill;
}

let instanceModeVerdict = null;
let instanceModeProbe = null;

// null means the lazy probe has not run yet, which is not the same as a launcher without the mode
export function instanceModeChecked() {
  return instanceModeVerdict;
}

export function resetInstanceModeProbe(verdict = null) {
  instanceModeVerdict = verdict;
  instanceModeProbe = null;
  helpCaptures.clear();
}

// A launcher without an instance mode takes `instance` for a profile name and launches the game.
// One verdict per process — every path asks the same configured launcher the same question — but
// only from a `--help` that answered: one that could not run, timed out or exited non-zero settles
// nothing, and leaves the verdict unset for the caller to ask again
export function probeLauncherHelp(command, args, { runProbe = instanceCommandRunner, timeoutMs = INSTANCE_PROBE_TIMEOUT_MS } = {}) {
  if (instanceModeVerdict !== null) return Promise.resolve(instanceModeVerdict);

  instanceModeProbe ??= (async () => {
    const { text, code, error } = await captureCommandHelp(command, args, { run: runProbe, timeoutMs });
    if (!error && code === 0) instanceModeVerdict = INSTANCE_HELP_RE.test(text);
    // The capture is memoized per command line, and a failed one must not be replayed to the retry
    else forgetCommandHelp(command, args);
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

// The launcher's own view of which instances are running, as JSON Lines: a header object carrying
// instancesRoot — the directory holding one directory per instance, which is the only place the
// server learns it, and not the launcher's own `root`, which this server has no use for —
// and cap from a launcher that caps running instances — one without a cap leaves it out or
// reports it null, and both read as no cap. Then one object per instance directory. A line that does
// not parse is one line, not the answer, so it is skipped
export function summarizeInstanceList(text) {
  const objects = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objects.push(parsed);
    } catch {}
  }
  if (objects.length === 0) return null;

  // The header is the object that names no instance; instancesRoot is where they live
  const header = objects.find(entry => entry.id === undefined) ?? null;
  const cap = Number(header?.cap);
  const headerPath = (key) => (typeof header?.[key] === 'string' && header[key] !== '' ? header[key] : null);
  const running = objects
    .filter(entry => entry.id !== undefined && entry.id !== null && String(entry.id) !== '')
    .filter(entry => entry.running === true || entry.running === 1 || entry.running === 'true')
    .map(entry => ({
      id: String(entry.id),
      port: entry.port ?? null,
      last_launch: entry.last_launch ?? null,
      stale: entry.stale ?? null,
    }));

  return {
    instancesRoot: headerPath('instancesRoot'),
    stageRoot: headerPath('stageRoot'),
    cap: Number.isFinite(cap) && cap > 0 ? cap : null,
    running,
    ids: running.map(entry => entry.id),
    count: running.length,
  };
}

export async function listInstances(config, { run = instanceCommandRunner, timeoutMs = LIST_COMMAND_TIMEOUT_MS } = {}) {
  const { code, stdout, error } = await run(config.launchCommand, config.listArgs, { timeoutMs });
  if (error || code !== 0) return null;
  return summarizeInstanceList(stdout);
}

export async function removeInstance(config, { run = instanceCommandRunner, timeoutMs = REMOVE_COMMAND_TIMEOUT_MS } = {}) {
  const display = [config.launchCommand, ...config.removeArgs].join(' ');
  const { code, error, stderr } = await run(config.launchCommand, config.removeArgs, { timeoutMs });
  if (error) return { removed: false, detail: `\`${display}\` could not run (${error.message})` };
  if (code !== 0) {
    return { removed: false, detail: `\`${display}\` exited ${code}${stderr?.trim() ? ` (${stderr.trim()})` : ''}` };
  }
  return { removed: true, detail: `Removed instance ${config.id} with \`${display}\`` };
}

// A stop that left nothing running stopped the game, and its exit status is a note on how
const stopNote = (attempt) => (attempt.failure ? `, though ${attempt.failure}` : '');

// Run the launcher's own stop and let /proc, not the command, say whether it worked
async function stopThroughLauncher(config, { command, args, runStop, timeoutMs, reader }) {
  const display = [command, ...args].join(' ');
  const { code, error, stderr } = await runStop(command, args, { timeoutMs });
  invalidateGameProcessScan();

  let failure = null;
  if (error) failure = `\`${display}\` could not run (${error.message})`;
  else if (code !== 0) failure = `\`${display}\` exited ${code}${stderr?.trim() ? ` (${stderr.trim()})` : ''}`;

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
      detail: `Could not stop ${label} (pid ${survivors.join(', ')})`
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
  if (isLinux()) return killGameLinux(options);

  if (isWindows()) {
    const killedImages = [];
    const failures = [];
    for (const image of WINDOWS_IMAGE_NAMES) {
      const { code, error, stderr } = await runChild('taskkill', ['/F', '/IM', image]);
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
  const probe = await runChild('sh', ['-c', 'command -v pkill >/dev/null 2>&1'], { capture: false });
  if (probe.error || probe.code !== 0) {
    return {
      killed: false,
      unknown: true,
      detail: 'pkill is not available on this system, so the game could not be stopped',
    };
  }

  const { code, error, stderr } = await runChild('sh', ['-c', POSIX_GAME_KILL_CMD]);
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

// The bracketed "[B]roforce" keeps the pattern from matching the `sh -c` wrapper that carries it
export const POSIX_PROFILE_SCAN_CMD =
  "pgrep -fa 'r2modmanPlus-local/[B]roforce/profiles/'";

// A profile name containing a space must not truncate into a match on a different profile
const PROFILE_PATH_RE = /r2modmanPlus-local[\/\\]Broforce[\/\\]profiles[\/\\]([^\/\\\s"']+)(?=[\/\\])/g;

// A second distinct profile name in the scan must make detection return null, not pick one
const LAUNCHER_LINE_RE = /run_umm\.sh|doorstop/i;

export function extractProfileName(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    if (!LAUNCHER_LINE_RE.test(line)) continue;
    for (const match of line.matchAll(PROFILE_PATH_RE)) {
      names.add(match[1]);
    }
  }
  return names.size === 1 ? [...names][0] : null;
}

// run_umm.sh turns --doorstop-target-assembly into an env var and the wrapper eats --r2profile,
// so the profile path is on the game's environment or on one of the shells that started it
export async function profileOfProcess(reader, pid, depth = PROFILE_ANCESTOR_DEPTH) {
  const own = extractProfileName(nulSeparated(await reader.cmdline(pid)));
  if (own) return own;

  const fromEnviron = extractProfileName(nulSeparated(await reader.environ?.(pid)));
  if (fromEnviron) return fromEnviron;

  let ancestor = parseStatPpid(await reader.stat(pid));
  for (let step = 0; step < depth && ancestor !== null && ancestor > 1; step++) {
    const stat = await reader.stat(ancestor);
    const name = extractProfileName(nulSeparated(await reader.cmdline(ancestor)));
    if (name) return name;
    ancestor = parseStatPpid(stat);
  }
  return null;
}

export async function detectActiveProfile(config = instanceConfig(), reader = defaultProcReader()) {
  if (isLinux()) {
    let procs;
    try {
      procs = await ownedGameProcesses(config, reader);
    } catch {
      return null;
    }
    const names = new Set();
    for (const proc of procs) {
      const profile = await profileOfProcess(reader, proc.pid);
      if (profile) names.add(profile);
    }
    return names.size === 1 ? [...names][0] : null;
  }

  if ((await isGameRunning()) !== true) return null;

  if (isWindows()) {
    const { code, stdout, error } = await runChild('wmic', [
      'process', 'where', "CommandLine like '%r2modmanPlus-local%Broforce%profiles%'", 'get', 'CommandLine',
    ]);
    if (error || code !== 0) return null;
    // wmic emits UTF-16LE when redirected; dropping the NULs recovers the paths
    return extractProfileName(stdout.replace(/\0/g, ''));
  }

  const { code, stdout, error } = await runChild('sh', ['-c', POSIX_PROFILE_SCAN_CMD]);
  if (error || code !== 0) return null;
  return extractProfileName(stdout);
}

export function composeExtraLaunchArgs({ vanilla, launchArgs } = {}) {
  const extra = vanilla ? ['--vanilla'] : [];
  if (launchArgs != null) {
    if (typeof launchArgs !== 'string') {
      throw new Error(`launchArgs must be a string, got ${typeof launchArgs}`);
    }
    extra.push(...tokenizeCommand(launchArgs));
  }
  return extra;
}

// The target decides: an instance always goes through the launcher's instance mode, and the
// BROFORCE_LAUNCH_CMD override belongs to the user's game alone
export function resolveLaunchCommand(extraArgs = [], env = process.env, platform = process.platform, config = null) {
  const target = config ?? instanceConfig(env);

  if (target.isAgentInstance) {
    const args = [...target.launchArgs, ...extraArgs];
    return {
      source: 'instance',
      command: target.launchCommand,
      args,
      display: [target.launchCommand, ...args].join(' '),
      ignoredArgs: [],
    };
  }

  const custom = (env.BROFORCE_LAUNCH_CMD || '').trim();
  if (custom) {
    const tokens = tokenizeCommand(custom);
    if (tokens.length === 0) {
      throw new Error('BROFORCE_LAUNCH_CMD is set but contains no command');
    }
    const args = [...tokens.slice(1), ...extraArgs];
    return {
      source: 'BROFORCE_LAUNCH_CMD',
      command: tokens[0],
      args,
      display: [tokens[0], ...args].join(' '),
      ignoredArgs: [],
    };
  }

  // The tests' second fence: the Steam protocol launch starts the user's real game, and no test may
  // reach it however it got here. Resolving one for its shape passes its own env and never this
  if (env.UNITY_INSPECTOR_TEST) {
    throw new Error(
      'Refusing the Steam protocol launch while UNITY_INSPECTOR_TEST is set: it would start the ' +
      "user's real game. Point BROFORCE_LAUNCH_CMD at a command of your own."
    );
  }

  const steam = {
    source: 'steam',
    ignoredArgs: extraArgs,
  };

  if (platform === 'win32') {
    return {
      ...steam,
      command: 'cmd',
      args: ['/c', 'start', '', STEAM_LAUNCH_URL],
      display: `cmd /c start "" ${STEAM_LAUNCH_URL}`,
    };
  }
  if (platform === 'darwin') {
    return {
      ...steam,
      command: 'open',
      args: [STEAM_LAUNCH_URL],
      display: `open ${STEAM_LAUNCH_URL}`,
    };
  }
  return {
    ...steam,
    command: 'sh',
    args: [
      '-c',
      'if command -v steam >/dev/null 2>&1; then exec steam "$1"; else exec xdg-open "$1"; fi',
      'sh',
      STEAM_LAUNCH_URL,
    ],
    display: `steam ${STEAM_LAUNCH_URL} (falling back to xdg-open)`,
  };
}

let lastSpawn = null;

// What the last spawnDetached asked for, so a test can hold the stdio contract to account
export function lastSpawnOptions() {
  return lastSpawn;
}

// stdout stays closed whatever happens: it carries the MCP protocol on this process's own handle
export function spawnDetached(command, args, { captureStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const stdio = captureStderr ? ['ignore', 'ignore', 'pipe'] : 'ignore';
    lastSpawn = { command, args, stdio };
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    child.on('error', (err) => {
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
