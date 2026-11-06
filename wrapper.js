#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { appendFileSync, chmodSync, openSync, closeSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

import { INSTANCE_STOP_TIMEOUT_MS, instanceConfig } from './lib/instance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = process.env.UNITY_INSPECTOR_MCP_CHILD || path.join(__dirname, 'index.js');
const NODE_PATH = process.execPath;
function defaultLogDir() {
  if (process.platform === 'win32') return os.tmpdir();
  // nix-shell points TMPDIR at a directory it deletes when its command exits
  const stateHome = process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
    ? process.env.XDG_STATE_HOME
    : path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'unity-inspector-mcp');
}
const LOG_OVERRIDE = process.env.UNITY_INSPECTOR_MCP_WRAPPER_LOG || '';
const LOG_FILE = LOG_OVERRIDE || path.join(defaultLogDir(), `mcp-wrapper-${process.pid}.log`);
const LOG_MODE = 0o600;
const OLD_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OLD_LOG_DIRS = process.platform === 'win32' ? [path.dirname(LOG_FILE)] : [path.dirname(LOG_FILE), '/tmp'];
// Where instances live is the launcher's to report and the server's to ask for; this wrapper is
// told the path of the owner.pid the server wrote rather than deriving one of its own
const CLAIM_FILE = process.env.UNITY_INSPECTOR_MCP_CLAIM_FILE || path.join(path.dirname(LOG_FILE), `mcp-wrapper-${process.pid}.claim`);

const MAX_RAPID_DEATHS = 3;
const DEATH_WINDOW_MS = 30000;
const START_TIMEOUT_MS = 10000;
const CHILD_STOP_GRACE_MS = 3000;
// On Windows kill() is abrupt, so the child's own stdin-end shutdown is the only graceful one it has
const WINDOWS_STDIN_GRACE_MS = 2500;

// An empty setting is an unset one, not the zero Number('') would make of it
const configuredStopWait = String(process.env.UNITY_INSPECTOR_MCP_STOP_WAIT_MS ?? '').trim();
const stopWait = configuredStopWait === '' ? NaN : Number(configuredStopWait);
const STOP_WAIT_MS = Number.isFinite(stopWait) && stopWait >= 0 ? stopWait : 15000;
const STOP_POLL_MS = 500;
const REAP_FLAG = '--reap';

const SERVER_INFO = { name: 'unity-inspector-mcp', version: '1.0.0' };

const RESTART_TOOL = {
  name: "restart_server",
  description: "Restart the Unity Inspector MCP server to pick up code changes in index.js. Use after modifying the MCP server source.",
  inputSchema: { type: "object", properties: {} },
};

let child = null;
let initMessage = null;
let pendingRequests = new Map();
let outstandingRequests = new Map();
let restarting = false;
let shuttingDown = false;
let serverDown = false;
let wrapperRequests = 0;
const deathTimestamps = [];

let stderrBroken = false;
let stdoutBroken = false;

// A write to a pipe the parent took with it fails asynchronously, and unheard it is an uncaught exception
process.stderr.on('error', (err) => {
  if (stderrBroken) return;
  stderrBroken = true;
  log(`Parent's stderr is gone (${err.code ?? err.message}) — logging to the file alone`);
});

process.stdout.on('error', (err) => {
  if (stdoutBroken) return;
  stdoutBroken = true;
  log(`Parent's stdout is gone (${err.code ?? err.message}) — dropping everything bound for the client`);
});

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (!stderrBroken) {
    try { process.stderr.write(`[wrapper] ${line}\n`); } catch { stderrBroken = true; }
  }
  try { appendFileSync(LOG_FILE, line + '\n', { mode: LOG_MODE }); } catch {}
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function setUpLogFile() {
  if (!LOG_OVERRIDE) {
    try {
      mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
      chmodSync(path.dirname(LOG_FILE), 0o700);
    } catch {}
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const isOld = (file) => {
    try {
      const stat = statSync(file);
      return (uid === null || stat.uid === uid) && Date.now() - stat.mtimeMs > OLD_LOG_AGE_MS;
    } catch (err) {
      return err.code === 'ENOENT';
    }
  };
  for (const dir of [...new Set(OLD_LOG_DIRS)]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      const match = /^mcp-wrapper-(\d+)\.(log|claim)$/.exec(name);
      if (!match || file === LOG_FILE || file === CLAIM_FILE || pidAlive(Number(match[1]))) continue;
      if (match[2] === 'claim' && !isOld(path.join(dir, `mcp-wrapper-${match[1]}.log`))) continue;
      if (isOld(file)) {
        try { unlinkSync(file); } catch {}
      }
    }
  }
  try { chmodSync(LOG_FILE, LOG_MODE); } catch {}
}

function openChildStderr() {
  try {
    return openSync(LOG_FILE, 'a', LOG_MODE);
  } catch (err) {
    log(`Cannot open ${LOG_FILE} (${err.code ?? err.message}) — the server's stderr goes nowhere`);
    return null;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnChild() {
  if (shuttingDown) throw new Error('The wrapper is shutting down');
  const stderrFd = openChildStderr();
  const proc = spawn(NODE_PATH, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', stderrFd ?? 'ignore'],
    cwd: __dirname,
    env: { ...process.env, UNITY_INSPECTOR_MCP_CLAIM_FILE: CLAIM_FILE },
  });
  if (stderrFd !== null) closeSync(stderrFd);
  child = proc;
  proc.closed = new Promise((resolve) => proc.once('close', resolve));

  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (data) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      handleChildMessage(line, proc);
    }
  });

  proc.on('exit', (code, signal) => {
    log(`Child exited (code=${code}, signal=${signal})`);
  });

  // 'close' comes once the child's stdout is drained, so every answer it wrote is in by then
  proc.on('close', () => {
    if (child === proc) child = null;
    if (proc.stopping) return;
    if (!restarting && !shuttingDown) autoRespawn();
    failOutstanding(exitedMessage(), proc);
  });

  proc.on('error', (err) => {
    log(`Child error: ${err.message}`);
    if (child === proc) child = null;
  });

  return proc;
}

async function closedWithin(proc, ms) {
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  const closed = await Promise.race([proc.closed.then(() => true), expired]);
  clearTimeout(timer);
  return closed;
}

async function stopChild(proc = child) {
  if (!proc) return;
  proc.stopping = true;

  try { proc.stdin.end(); } catch {}
  let closed = process.platform === 'win32' && await closedWithin(proc, WINDOWS_STDIN_GRACE_MS);
  if (!closed) {
    try { proc.kill('SIGTERM'); } catch {}
    closed = await closedWithin(proc, CHILD_STOP_GRACE_MS);
  }
  if (!closed) {
    try { proc.kill('SIGKILL'); } catch {}
    await closedWithin(proc, CHILD_STOP_GRACE_MS);
  }

  if (child === proc) child = null;
  failOutstanding(
    'The Unity Inspector MCP server was restarted before answering this request, and the command may ' +
    "already have run in the game. Check the game's state before retrying.",
    proc,
  );
}

function writeTo(proc, msg) {
  if (proc && proc.stdin && proc.stdin.writable) {
    proc.stdin.write(msg + '\n');
    return true;
  }
  return false;
}

function askChild(proc, id, line, { timeoutMessage, exitMessage }) {
  return new Promise((resolve, reject) => {
    const settle = (fn) => {
      clearTimeout(timeout);
      proc.off('close', closed);
      if (pendingRequests.get(id)?.callback === answered) pendingRequests.delete(id);
      fn();
    };
    const answered = (response) => settle(() => resolve(response));
    const closed = () => settle(() => reject(new Error(exitMessage)));
    const timeout = setTimeout(() => settle(() => reject(new Error(timeoutMessage))), START_TIMEOUT_MS);

    proc.once('close', closed);
    pendingRequests.set(id, { proc, callback: answered });
    if (!writeTo(proc, line)) settle(() => reject(new Error('Child is not accepting input')));
  });
}

async function startChild() {
  pendingRequests.clear();
  const proc = spawnChild();

  if (!initMessage) return null;

  const initId = JSON.parse(initMessage).id;
  const listId = `wrapper-tools-list-${++wrapperRequests}`;

  try {
    await askChild(proc, initId, initMessage, {
      timeoutMessage: 'Init timeout',
      exitMessage: 'Child exited during initialize',
    });
    // Send initialized notification (required by MCP protocol)
    writeTo(proc, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

    const listing = await askChild(proc, listId, JSON.stringify({ jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} }), {
      timeoutMessage: 'The new server did not list its tools in time',
      exitMessage: 'Child exited while listing its tools',
    });
    if (listing.error) throw new Error(`The new server could not list its tools: ${listing.error.message}`);
    const tools = listing.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) throw new Error('The new server listed no tools');
    return tools.length;
  } catch (err) {
    await stopChild(proc);
    throw err;
  }
}

let transition = Promise.resolve();
let pendingTransitions = 0;

function exclusively(step) {
  pendingTransitions++;
  const run = transition.then(step, step).finally(() => { pendingTransitions--; });
  transition = run.catch(() => {});
  return run;
}

async function autoRespawn() {
  const now = Date.now();
  while (deathTimestamps.length > 0 && now - deathTimestamps[0] > DEATH_WINDOW_MS) {
    deathTimestamps.shift();
  }
  deathTimestamps.push(now);

  if (deathTimestamps.length >= MAX_RAPID_DEATHS) {
    serverDown = true;
    log(`Child died ${deathTimestamps.length} times within ${DEATH_WINDOW_MS / 1000}s — not respawning. Use restart_server to try again.`);
    return;
  }

  log(`Child died unexpectedly — respawning (death ${deathTimestamps.length} of ${MAX_RAPID_DEATHS})`);
  await exclusively(respawnChild);
}

async function respawnChild() {
  if (shuttingDown) return;
  if (child) {
    log('Auto-respawn skipped — a child is already running');
    return;
  }

  try {
    await startChild();
    serverDown = false;
    log('Auto-respawn complete');
    if (initMessage) {
      sendToParent(JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      }));
    }
  } catch (err) {
    log(`Auto-respawn failed: ${err.message}`);
    serverDown = true;
  }
}

function sendToChild(msg) {
  return writeTo(child, msg);
}

function sendToParent(msg) {
  if (stdoutBroken) return;
  try { process.stdout.write(msg + '\n'); } catch { stdoutBroken = true; }
}

function serverDownMessage() {
  if (pendingTransitions > 0) {
    return 'The Unity Inspector MCP server (index.js) is restarting. Retry the call in a few seconds.';
  }
  return `The Unity Inspector MCP server (index.js) is not running${serverDown ? ' and could not be respawned' : ''}. ` +
    `See ${LOG_FILE} for the child's output, fix the problem, then call restart_server.`;
}

function exitedMessage() {
  const state = pendingTransitions > 0
    ? 'The server is restarting.'
    : `The server is not running${serverDown ? ' and could not be respawned' : ''}; fix the problem, then call restart_server.`;
  return `The Unity Inspector MCP server process exited before answering this request (see ${LOG_FILE}). ` +
    'The command may already have run in the game, and repeating it may crash the server again: ' +
    `check the log before retrying. ${state}`;
}

function replyError(id, message) {
  sendToParent(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
}

function replyWithoutChild(id, request, message) {
  if (request.method === 'initialize') {
    sendToParent(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: request.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
      },
    }));
    return;
  }
  if (request.method === 'tools/list') {
    sendToParent(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [RESTART_TOOL] } }));
    return;
  }
  replyError(id, message);
}

function respondServerDown(parsed) {
  if (parsed.id === undefined || parsed.id === null) return;
  outstandingRequests.delete(parsed.id);
  replyWithoutChild(parsed.id, { method: parsed.method, protocolVersion: parsed.params?.protocolVersion }, serverDownMessage());
}

function failOutstanding(message, proc) {
  for (const [id, request] of [...outstandingRequests]) {
    if (request.proc !== proc) continue;
    outstandingRequests.delete(id);
    replyWithoutChild(id, request, message);
  }
}

function handleChildMessage(line, proc) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    sendToParent(line);
    return;
  }

  const id = parsed.id;
  const isResponse = id !== undefined && id !== null && parsed.method === undefined;

  if (isResponse && pendingRequests.get(id)?.proc === proc) {
    const { callback } = pendingRequests.get(id);
    pendingRequests.delete(id);
    callback(parsed);
    return;
  }

  if (isResponse) {
    if (outstandingRequests.get(id)?.proc !== proc) {
      log(`Dropped a response to request ${JSON.stringify(id)}, which was already answered or cancelled`);
      return;
    }
    outstandingRequests.delete(id);
  }

  if (parsed.result && parsed.result.tools && Array.isArray(parsed.result.tools)) {
    parsed.result.tools.push(RESTART_TOOL);
    sendToParent(JSON.stringify(parsed));
    return;
  }

  sendToParent(line);
}

function handleParentMessage(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    if (!sendToChild(line)) log('Dropped non-JSON message: child is not running');
    return;
  }

  if (parsed.method === 'initialize') {
    initMessage = line;
  }

  if (parsed.method === 'notifications/cancelled') {
    outstandingRequests.delete(parsed.params?.requestId);
  }

  if (parsed.method === 'tools/call' && parsed.params?.name === 'restart_server') {
    handleRestart(parsed);
    return;
  }

  if (parsed.method !== undefined && parsed.id !== undefined && parsed.id !== null) {
    outstandingRequests.set(parsed.id, {
      proc: child,
      method: parsed.method,
      protocolVersion: parsed.params?.protocolVersion,
    });
  }

  if (!sendToChild(line)) {
    log(`Child is not running; rejecting ${parsed.method ?? 'message'}`);
    respondServerDown(parsed);
  }
}

function replyToolResult(id, text, isError) {
  sendToParent(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    },
  }));
}

let restartInFlight = null;

async function handleRestart(request) {
  const args = request.params?.arguments;
  const unknown = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : [];
  if (unknown.length > 0) {
    const names = unknown.map((key) => `"${key}"`).join(', ');
    replyToolResult(request.id, `Error: restart_server has no argument${unknown.length > 1 ? 's' : ''} ${names}; it takes no arguments`, true);
    return;
  }

  const started = restartInFlight === null;
  restartInFlight ??= exclusively(performRestart).finally(() => { restartInFlight = null; });
  const outcome = await restartInFlight;

  replyToolResult(request.id, JSON.stringify(outcome), !outcome.success);

  if (started && outcome.success) {
    sendToParent(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    }));
  }
}

async function performRestart() {
  if (shuttingDown) return { success: false, error: 'The wrapper is shutting down' };
  log('Restart requested');
  restarting = true;

  try {
    await stopChild();

    deathTimestamps.length = 0;
    serverDown = false;

    const tools = await startChild();

    log('Restart complete');
    return {
      success: true,
      message: tools === null
        ? 'MCP server restarted successfully'
        : `MCP server restarted successfully, listing ${tools} tools`,
    };
  } catch (err) {
    log(`Restart failed: ${err.message}`);
    serverDown = true;
    return { success: false, error: `${err.message}. See ${LOG_FILE} for the server's output.` };
  } finally {
    restarting = false;
  }
}

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (afterComm[0] === 'Z') return null;
    return { pid: String(pid), startTime: afterComm[19] ?? null };
  } catch {
    return null;
  }
}

function ownIdentity() {
  return processIdentity(process.pid) ?? { pid: String(process.pid), startTime: null };
}

function claimedOwnerFile() {
  let line;
  try {
    line = readFileSync(CLAIM_FILE, 'utf8').trim();
  } catch (err) {
    return { ownerFile: null, error: err.code === 'ENOENT' ? null : (err.code ?? err.message) };
  }
  return { ownerFile: line || null, error: null };
}

function readOwnership(ownerFile, owner) {
  let line;
  try {
    line = readFileSync(ownerFile, 'utf8').trim();
  } catch (err) {
    return { owned: false, error: err.code === 'ENOENT' ? null : (err.code ?? err.message) };
  }
  if (!line) return { owned: false, error: null };
  const [pid, startTime] = line.split(/\s+/);
  if (pid !== owner.pid) return { owned: false, error: null };
  // A pid alone can be a recycled one; the start time is what settles it when both sides have it
  const owned = owner.startTime === null || startTime === undefined || startTime === owner.startTime;
  return { owned, error: null };
}

function handOffInstanceStop(proc, trigger, startedAt) {
  const config = instanceConfig();
  if (!config.isAgentInstance) return false;

  const job = {
    owner: ownIdentity(),
    child: proc && proc.exitCode === null && proc.signalCode === null ? processIdentity(proc.pid) : null,
    trigger,
    startedAt,
  };
  try {
    const reaper = spawn(NODE_PATH, [__filename, REAP_FLAG, JSON.stringify(job)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, UNITY_INSPECTOR_MCP_WRAPPER_LOG: LOG_FILE, UNITY_INSPECTOR_MCP_CLAIM_FILE: CLAIM_FILE },
    });
    reaper.on('error', (err) => log(`Could not start the stop of instance ${config.id}: ${err.message}`));
    reaper.unref();
    log(`Handed instance ${config.id} to reaper ${reaper.pid}, ${Date.now() - startedAt}ms after ${trigger}`);
    return true;
  } catch (err) {
    log(`Could not start the stop of instance ${config.id}: ${err.message}`);
    return false;
  }
}

function stillRunning(identity) {
  const now = processIdentity(identity.pid);
  return now !== null && now.startTime === identity.startTime;
}

async function waitForServerGone(identity, startedAt) {
  if (!identity) return;
  const graceEnds = startedAt + CHILD_STOP_GRACE_MS;
  while (stillRunning(identity) && Date.now() < graceEnds) await delay(100);
  if (!stillRunning(identity)) return;

  try { process.kill(Number(identity.pid), 'SIGKILL'); } catch {}
  log(`Killed server ${identity.pid}, still running ${Date.now() - startedAt}ms after the session ended`);
  const killEnds = Date.now() + CHILD_STOP_GRACE_MS;
  while (stillRunning(identity) && Date.now() < killEnds) await delay(100);
}

async function reap({ owner, child: server, trigger, startedAt }) {
  const config = instanceConfig();
  const since = () => `${Date.now() - startedAt}ms after ${trigger}`;

  await waitForServerGone(server, startedAt);

  const claim = claimedOwnerFile();
  if (claim.error) {
    log(`Could not read the owner claim for instance ${config.id}: ${claim.error} — leaving it alone`);
    return;
  }
  const ownerFile = claim.ownerFile;

  const ownership = ownerFile === null ? { owned: false, error: null } : readOwnership(ownerFile, owner);
  if (!ownership.owned) {
    log(ownership.error
      ? `Could not read owner.pid for instance ${config.id}: ${ownership.error} — leaving it alone`
      : `Instance ${config.id} is not owned by this wrapper — leaving it alone`);
    return;
  }

  const deadline = startedAt + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(Math.min(STOP_POLL_MS, Math.max(0, deadline - Date.now())));
    if (!readOwnership(ownerFile, owner).owned) {
      log(`Instance ${config.id} was taken over ${since()} — leaving it running`);
      return;
    }
  }

  const result = spawnSync(config.launchCommand, config.stopArgs, {
    stdio: 'ignore',
    timeout: INSTANCE_STOP_TIMEOUT_MS,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    log(`Stopping instance ${config.id} did not finish within ${INSTANCE_STOP_TIMEOUT_MS / 1000}s, ${since()}`);
  } else if (result.error) {
    log(`Could not run the configured launcher to stop instance ${config.id}: ${result.error.message}, ${since()}`);
  } else if (result.status !== 0) {
    const ending = result.status === null ? `signal ${result.signal}` : `status ${result.status}`;
    log(`Stopping instance ${config.id} exited with ${ending}, ${since()}`);
  } else {
    log(`Stopped instance ${config.id}, ${since()}`);
  }
}

let shutdownStarted = false;

async function shutdown(trigger, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  const startedAt = Date.now();
  const proc = child;

  const handedOff = handOffInstanceStop(proc, trigger, startedAt);
  try {
    await stopChild(proc);
  } catch (err) {
    log(`Stopping the server failed: ${err.message}`);
  }

  if (!handedOff) {
    try { unlinkSync(CLAIM_FILE); } catch {}
  }
  log(`Wrapper exiting, ${Date.now() - startedAt}ms after ${trigger}`);
  process.exit(exitCode);
}

const FATAL_BURST = 20;
const FATAL_WINDOW_MS = 5000;
const fatalReports = [];

// A failure that keeps being raised by whatever reports it would otherwise be reported forever,
// and a wrapper spending the session doing that never reaches its shutdown
function reportFatal(what) {
  const now = Date.now();
  while (fatalReports.length > 0 && now - fatalReports[0] > FATAL_WINDOW_MS) fatalReports.shift();
  fatalReports.push(now);

  if (fatalReports.length >= FATAL_BURST) {
    log(`${fatalReports.length} failures within ${FATAL_WINDOW_MS / 1000}s — exiting rather than reporting more. Last: ${what}`);
    if (shutdownStarted) process.exit(1);
    shutdown('repeated failures', 1);
    return;
  }

  log(what);
}

function runWrapper() {
  setUpLogFile();
  let parentBuffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    parentBuffer += data;
    const lines = parentBuffer.split('\n');
    parentBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      handleParentMessage(line);
    }
  });

  process.stdin.on('end', () => shutdown('stdin end'));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal));

  process.on('unhandledRejection', (reason) => {
    reportFatal(`Unhandled rejection: ${reason}`);
  });

  process.on('uncaughtException', (err) => {
    reportFatal(`Uncaught exception: ${err.message}\n${err.stack}`);
  });

  // Start
  spawnChild();
  log('Wrapper started');
}

if (process.argv[2] === REAP_FLAG) {
  reap(JSON.parse(process.argv[3]))
    .catch((err) => log(`The instance stop failed: ${err.message}`))
    .finally(() => {
      try { unlinkSync(CLAIM_FILE); } catch {}
      process.exit(0);
    });
} else {
  runWrapper();
}
