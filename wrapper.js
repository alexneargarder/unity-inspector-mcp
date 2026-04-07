#!/usr/bin/env node

// MCP hot-reload wrapper
// Spawns index.js as a child, proxies stdio, and handles restart_server tool calls.

import { spawn } from 'child_process';
import { appendFileSync, openSync, closeSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.join(__dirname, 'index.js');
const NODE_PATH = process.execPath;
const LOG_FILE = `/tmp/mcp-wrapper-${process.pid}.log`;

const RESTART_TOOL = {
  name: "restart_server",
  description: "Restart the Unity Inspector MCP server to pick up code changes in index.js. Use after modifying the MCP server source.",
  inputSchema: { type: "object", properties: {} },
};

let child = null;
let initMessage = null;
let childBuffer = '';
let pendingRequests = new Map(); // id -> callback for intercepted responses

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(`[wrapper] ${line}\n`);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function spawnChild() {
  const stderrFd = openSync(LOG_FILE, 'a');
  child = spawn(NODE_PATH, [SERVER_PATH], {
    stdio: ['pipe', 'pipe', stderrFd],
    cwd: __dirname,
  });
  closeSync(stderrFd);

  child.stdout.on('data', (data) => {
    childBuffer += data.toString();
    let lines = childBuffer.split('\n');
    // Keep incomplete last line in buffer
    childBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      handleChildMessage(line);
    }
  });

  child.on('exit', (code, signal) => {
    log(`Child exited (code=${code}, signal=${signal})`);
  });

  child.on('error', (err) => {
    log(`Child error: ${err.message}`);
  });
}

function sendToChild(msg) {
  if (child && child.stdin.writable) {
    child.stdin.write(msg + '\n');
  }
}

function sendToParent(msg) {
  process.stdout.write(msg + '\n');
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
    sendToChild(line);
    return;
  }

  // Save initialize request for replay after restart
  if (parsed.method === 'initialize') {
    initMessage = line;
    sendToChild(line);
    return;
  }

  // Intercept restart_server tool call
  if (parsed.method === 'tools/call' && parsed.params?.name === 'restart_server') {
    handleRestart(parsed);
    return;
  }

  sendToChild(line);
}

async function handleRestart(request) {
  log('Restart requested');

  try {
    // Kill the child
    if (child) {
      child.stdin.end();
      child.kill('SIGTERM');
      // Wait for exit with timeout
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    // Spawn new child
    childBuffer = '';
    pendingRequests.clear();
    spawnChild();

    // Replay initialize
    if (initMessage) {
      const initParsed = JSON.parse(initMessage);
      const initId = initParsed.id;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Init timeout')), 10000);
        pendingRequests.set(initId, (response) => {
          clearTimeout(timeout);
          resolve(response);
        });
        sendToChild(initMessage);
      });

      // Send initialized notification (required by MCP protocol)
      sendToChild(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    }

    log('Restart complete');

    // Respond to the restart request
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
  }
}

// Read from parent (Claude Code) stdin
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

process.stdin.on('end', () => {
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (child) child.kill('SIGTERM');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}\n${err.stack}`);
});

// Start
spawnChild();
log('Wrapper started');
