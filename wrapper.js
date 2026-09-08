#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { appendFileSync, openSync, closeSync, readFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { instanceConfig } from './lib/instance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = process.env.UNITY_INSPECTOR_MCP_CHILD || path.join(__dirname, 'index.js');
const NODE_PATH = process.execPath;
const LOG_FILE = process.env.UNITY_INSPECTOR_MCP_WRAPPER_LOG || `/tmp/mcp-wrapper-${process.pid}.log`;
// Where instances live is the launcher's to report and the server's to ask for; this wrapper is
// told the path of the owner.pid the server wrote rather than deriving one of its own
const CLAIM_FILE = process.env.UNITY_INSPECTOR_MCP_CLAIM_FILE || `/tmp/mcp-wrapper-${process.pid}.claim`;

const MAX_RAPID_DEATHS = 3;
const DEATH_WINDOW_MS = 30000;

// This process is co-terminal with the session, and the child is only what restart_server replaces,
// so the instance's game is stopped here or not at all
// An empty setting is an unset one, not the zero Number('') would make of it
const configuredStopWait = String(process.env.UNITY_INSPECTOR_MCP_STOP_WAIT_MS ?? '').trim();
const stopWait = configuredStopWait === '' ? NaN : Number(configuredStopWait);
const STOP_WAIT_MS = Number.isFinite(stopWait) && stopWait >= 0 ? stopWait : 15000;
const STOP_POLL_MS = 500;
const STOP_COMMAND_TIMEOUT_MS = 20000;

const RESTART_TOOL = {
  name: "restart_server",
  description: "Restart the Unity Inspector MCP server to pick up code changes in index.js. Use after modifying the MCP server source.",
  inputSchema: { type: "object", properties: {} },
};

let child = null;
let initMessage = null;
let childBuffer = '';
let pendingRequests = new Map();
let outstandingRequests = new Set();
let restarting = false;
let shuttingDown = false;
let serverDown = false;
const deathTimestamps = [];

// A parent that has gone takes its end of these pipes with it, and a write to a dead pipe fails
// asynchronously: with no listener that failure is an uncaught exception, and one raised from
// inside the logger would be reported by writing again. Both streams are dropped once broken, and
// the loss is recorded in the log file, which is all a mute wrapper leaves behind.
let stderrBroken = false;
let stdoutBroken = false;

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
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function spawnChild() {
  const stderrFd = openSync(LOG_FILE, 'a');
  const proc = spawn(NODE_PATH, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', stderrFd],
    cwd: __dirname,
    env: { ...process.env, UNITY_INSPECTOR_MCP_CLAIM_FILE: CLAIM_FILE },
  });
  closeSync(stderrFd);
  child = proc;

  proc.stdout.on('data', (data) => {
    childBuffer += data.toString();
    let lines = childBuffer.split('\n');
    childBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      handleChildMessage(line);
    }
  });

  proc.on('exit', (code, signal) => {
    log(`Child exited (code=${code}, signal=${signal})`);
    if (child === proc) child = null;
    if (restarting || shuttingDown) return;

    failOutstanding(`The Unity Inspector MCP server process exited before answering this request. ${serverDownMessage()}`);
    autoRespawn();
  });

  proc.on('error', (err) => {
    log(`Child error: ${err.message}`);
    if (child === proc) child = null;
  });

  return proc;
}

async function stopChild() {
  const proc = child;
  if (!proc) return;

  failOutstanding('The Unity Inspector MCP server was restarted before answering this request. Retry the call.');

  try { proc.stdin.end(); } catch {}
  proc.kill('SIGTERM');

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (child === proc) child = null;
}

async function startChild() {
  childBuffer = '';
  pendingRequests.clear();
  spawnChild();

  if (!initMessage) return;

  const initParsed = JSON.parse(initMessage);
  const initId = initParsed.id;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(initId);
      reject(new Error('Init timeout'));
    }, 10000);
    pendingRequests.set(initId, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    if (!sendToChild(initMessage)) {
      clearTimeout(timeout);
      pendingRequests.delete(initId);
      reject(new Error('Child is not accepting input'));
    }
  });

  // Send initialized notification (required by MCP protocol)
  sendToChild(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
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

  try {
    await startChild();
    serverDown = false;
    log('Auto-respawn complete');
    sendToParent(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    }));
  } catch (err) {
    log(`Auto-respawn failed: ${err.message}`);
    serverDown = true;
    await stopChild();
  }
}

function sendToChild(msg) {
  if (child && child.stdin && child.stdin.writable) {
    child.stdin.write(msg + '\n');
    return true;
  }
  return false;
}

function sendToParent(msg) {
  if (stdoutBroken) return;
  try { process.stdout.write(msg + '\n'); } catch { stdoutBroken = true; }
}

function serverDownMessage() {
  return `The Unity Inspector MCP server (index.js) is not running${serverDown ? ' and could not be respawned' : ''}. ` +
    `See ${LOG_FILE} for the child's output, fix the problem, then call restart_server.`;
}

function respondServerDown(parsed) {
  if (parsed.id === undefined || parsed.id === null) return;
  outstandingRequests.delete(parsed.id);
  sendToParent(JSON.stringify({
    jsonrpc: "2.0",
    id: parsed.id,
    error: { code: -32000, message: serverDownMessage() },
  }));
}

function failOutstanding(message) {
  if (outstandingRequests.size === 0) return;
  for (const id of outstandingRequests) {
    sendToParent(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message },
    }));
  }
  outstandingRequests.clear();
}

function handleChildMessage(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    sendToParent(line);
    return;
  }

  if (parsed.id !== undefined && parsed.id !== null) {
    outstandingRequests.delete(parsed.id);
  }

  if (parsed.id !== undefined && parsed.id !== null && pendingRequests.has(parsed.id)) {
    const callback = pendingRequests.get(parsed.id);
    pendingRequests.delete(parsed.id);
    callback(parsed);
    return;
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

  if (parsed.method === 'tools/call' && parsed.params?.name === 'restart_server') {
    handleRestart(parsed);
    return;
  }

  if (parsed.method !== undefined && parsed.id !== undefined && parsed.id !== null) {
    outstandingRequests.add(parsed.id);
  }

  if (!sendToChild(line)) {
    log(`Child is not running; rejecting ${parsed.method ?? 'message'}`);
    respondServerDown(parsed);
  }
}

async function handleRestart(request) {
  log('Restart requested');
  restarting = true;

  try {
    await stopChild();

    deathTimestamps.length = 0;
    serverDown = false;

    await startChild();

    log('Restart complete');

    sendToParent(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, message: "MCP server restarted successfully" }),
        }],
      },
    }));

    sendToParent(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    }));
  } catch (err) {
    log(`Restart failed: ${err.message}`);
    serverDown = true;
    sendToParent(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({ success: false, error: err.message }),
        }],
        isError: true,
      },
    }));
  } finally {
    restarting = false;
  }
}

let parentBuffer = '';
process.stdin.on('data', (data) => {
  parentBuffer += data.toString();
  let lines = parentBuffer.split('\n');
  parentBuffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    handleParentMessage(line);
  }
});

// The line the server writes into owner.pid: a pid and field 22 of /proc/<pid>/stat
function ownIdentity() {
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: String(process.pid), startTime: afterComm[19] ?? null };
  } catch {
    return { pid: String(process.pid), startTime: null };
  }
}

// The owner.pid the server wrote, as it recorded it here. A missing claim file is the ordinary
// absence of one; any other read failure is worth naming, and neither is ownership
function claimedOwnerFile() {
  let line;
  try {
    line = readFileSync(CLAIM_FILE, 'utf8').trim();
  } catch (err) {
    return { ownerFile: null, error: err.code === 'ENOENT' ? null : (err.code ?? err.message) };
  }
  return { ownerFile: line || null, error: null };
}

// A missing file is the ordinary absence of a claim; any other read failure is worth naming, and
// neither is ownership
function readOwnership(ownerFile) {
  let line;
  try {
    line = readFileSync(ownerFile, 'utf8').trim();
  } catch (err) {
    return { owned: false, error: err.code === 'ENOENT' ? null : (err.code ?? err.message) };
  }
  if (!line) return { owned: false, error: null };
  const [pid, startTime] = line.split(/\s+/);
  const own = ownIdentity();
  if (pid !== own.pid) return { owned: false, error: null };
  // A pid alone can be a recycled one; the start time is what settles it when both sides have it
  const owned = own.startTime === null || startTime === undefined || startTime === own.startTime;
  return { owned, error: null };
}

const ownsInstance = (ownerFile) => readOwnership(ownerFile).owned;

let wakePoll = null;

// A signal recorded mid-poll has to be acted on when it arrives, not when the current tick runs out
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakePoll = null;
      resolve();
    }, ms);
    wakePoll = () => {
      clearTimeout(timer);
      wakePoll = null;
      resolve();
    };
  });
}

const STDIN_END = 'stdin end';

// Only positive evidence that this wrapper owns the instance justifies handing the configured
// launcher an `instance <id> stop`: a launcher without instance mode could read the first word as
// something else entirely and launch the user's game
async function stopOwnedInstance(state) {
  const config = instanceConfig();
  if (!config.isAgentInstance) return;

  const claim = claimedOwnerFile();
  if (claim.error) {
    log(`Could not read the owner claim for instance ${config.id}: ${claim.error} — leaving it alone`);
    return;
  }
  const ownerFile = claim.ownerFile;

  const ownership = ownerFile === null ? { owned: false, error: null } : readOwnership(ownerFile);
  if (!ownership.owned) {
    log(ownership.error
      ? `Could not read owner.pid for instance ${config.id}: ${ownership.error} — leaving it alone`
      : `Instance ${config.id} is not owned by this wrapper — leaving it alone`);
    return;
  }

  // A signal-terminated wrapper is killed uncatchably in well under a second, so only stdin end
  // can afford the wait; a newer server adopting the id rewrites owner.pid and wins the wait
  if (state.trigger === STDIN_END) {
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline && pendingSignal === null) {
      await sleep(Math.min(STOP_POLL_MS, Math.max(0, deadline - Date.now())));
      if (!ownsInstance(ownerFile)) {
        log(`Instance ${config.id} was taken over after ${Date.now() - state.startedAt}ms — leaving it running`);
        return;
      }
    }

    if (pendingSignal !== null) {
      state.trigger = pendingSignal.trigger;
      state.startedAt = pendingSignal.at;
      if (!ownsInstance(ownerFile)) {
        log(`Instance ${config.id} was taken over after ${Date.now() - state.startedAt}ms — leaving it running`);
        return;
      }
    }
  }

  // stdout carries the MCP stream, so the launcher is given none of this process's streams
  const result = spawnSync(config.launchCommand, config.stopArgs, {
    stdio: 'ignore',
    timeout: STOP_COMMAND_TIMEOUT_MS,
  });
  const elapsed = `${Date.now() - state.startedAt}ms after ${state.trigger}`;
  if (result.error) {
    log(`Could not run the configured launcher to stop instance ${config.id}: ${result.error.message}, ${elapsed}`);
  } else if (result.status !== 0) {
    const ending = result.status === null ? `signal ${result.signal}` : `status ${result.status}`;
    log(`Stopping instance ${config.id} exited with ${ending}, ${elapsed}`);
  } else {
    log(`Stopped instance ${config.id}, ${elapsed}`);
  }
}

let shutdownStarted = false;
let pendingSignal = null;

async function shutdown(trigger) {
  if (shutdownStarted) {
    // Not swallowed: a signal cuts a stdin-end wait short rather than starting a second shutdown
    if (trigger !== STDIN_END && pendingSignal === null) {
      pendingSignal = { trigger, at: Date.now() };
      wakePoll?.();
    }
    return;
  }
  shutdownStarted = true;
  shuttingDown = true;
  const state = { trigger, startedAt: Date.now() };

  try {
    await stopOwnedInstance(state);
  } catch (err) {
    log(`Instance stop failed: ${err.message}`);
  }

  if (child) child.kill('SIGTERM');
  // The claim is this wrapper's own record and outlives nothing
  try { unlinkSync(CLAIM_FILE); } catch {}
  log(`Wrapper exiting, ${Date.now() - state.startedAt}ms after ${state.trigger}`);
  process.exit(0);
}

process.stdin.on('end', () => shutdown(STDIN_END));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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
    process.exit(1);
  }

  log(what);
}

process.on('unhandledRejection', (reason) => {
  reportFatal(`Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  reportFatal(`Uncaught exception: ${err.message}\n${err.stack}`);
});

// Start
spawnChild();
log('Wrapper started');
