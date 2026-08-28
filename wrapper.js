#!/usr/bin/env node

// MCP hot-reload wrapper
// Spawns index.js as a child, proxies stdio, handles restart_server tool calls,
// and respawns the child if it dies unexpectedly.

import { spawn } from 'child_process';
import { appendFileSync, openSync, closeSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// UNITY_INSPECTOR_MCP_CHILD lets the test suite drive the wrapper against a
// stub child; production always runs index.js.
const SERVER_PATH = process.env.UNITY_INSPECTOR_MCP_CHILD || path.join(__dirname, 'index.js');
const NODE_PATH = process.execPath;
const LOG_FILE = process.env.UNITY_INSPECTOR_MCP_WRAPPER_LOG || `/tmp/mcp-wrapper-${process.pid}.log`;

// Crash-loop guard: this many child deaths inside the window means the child
// cannot stay up, so stop restarting and answer requests with an error.
const MAX_RAPID_DEATHS = 3;
const DEATH_WINDOW_MS = 30000;

const RESTART_TOOL = {
  name: "restart_server",
  description: "Restart the Unity Inspector MCP server to pick up code changes in index.js. Use after modifying the MCP server source.",
  inputSchema: { type: "object", properties: {} },
};

let child = null;
let initMessage = null;
let childBuffer = '';
let pendingRequests = new Map(); // id -> callback for intercepted responses
let outstandingRequests = new Set(); // ids forwarded to the child, awaiting a reply
let restarting = false;    // a deliberate restart is in progress
let shuttingDown = false;
let serverDown = false;    // child is gone and will not be respawned
const deathTimestamps = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(`[wrapper] ${line}\n`);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function spawnChild() {
  const stderrFd = openSync(LOG_FILE, 'a');
  const proc = spawn(NODE_PATH, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', stderrFd],
    cwd: __dirname,
  });
  closeSync(stderrFd);
  child = proc;

  proc.stdout.on('data', (data) => {
    childBuffer += data.toString();
    let lines = childBuffer.split('\n');
    // Keep incomplete last line in buffer
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

/** Kill the current child and wait for it to exit. */
async function stopChild() {
  const proc = child;
  if (!proc) return;

  // Whatever the child was working on dies with it, including during a
  // deliberate restart — answer those requests instead of stranding them.
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

/** Spawn a fresh child and replay the MCP handshake so the client never notices. */
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
  process.stdout.write(msg + '\n');
}

function serverDownMessage() {
  return `The Unity Inspector MCP server (index.js) is not running${serverDown ? ' and could not be respawned' : ''}. ` +
    `See ${LOG_FILE} for the child's output, fix the problem, then call restart_server.`;
}

/** Answer a request the child can no longer handle with a JSON-RPC error. */
function respondServerDown(parsed) {
  if (parsed.id === undefined || parsed.id === null) return; // notification, nothing to answer
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
    // Not JSON, forward as-is
    sendToParent(line);
    return;
  }

  if (parsed.id !== undefined && parsed.id !== null) {
    outstandingRequests.delete(parsed.id);
  }

  // Check if this is a response to an intercepted request
  if (parsed.id !== undefined && parsed.id !== null && pendingRequests.has(parsed.id)) {
    const callback = pendingRequests.get(parsed.id);
    pendingRequests.delete(parsed.id);
    callback(parsed);
    return;
  }

  // Intercept tools/list response to inject restart_server tool
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

  // Save initialize request for replay after restart
  if (parsed.method === 'initialize') {
    initMessage = line;
  }

  // Intercept restart_server tool call
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

    // An explicit restart clears the crash-loop lockout
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

    // Notify client that tools may have changed so it re-fetches the tool list
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

// Read from parent (MCP client) stdin
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

function shutdown() {
  shuttingDown = true;
  if (child) child.kill('SIGTERM');
  process.exit(0);
}

process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}\n${err.stack}`);
});

// Start
spawnChild();
log('Wrapper started');
