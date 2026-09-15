import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = path.join(__dirname, '..', '..', 'wrapper.js');
const STUB_CHILD_PATH = path.join(__dirname, 'stub-child.js');

export function startWrapper(env = {}) {
  const logDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-wrapper-test-'));
  const logFile = path.join(logDir, 'wrapper.log');
  // Where the server records the owner.pid it wrote, and the only place the wrapper looks for it
  const claimFile = path.join(logDir, 'wrapper.claim');

  const proc = spawn(process.execPath, [WRAPPER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      UNITY_INSPECTOR_MCP_CHILD: STUB_CHILD_PATH,
      UNITY_INSPECTOR_MCP_WRAPPER_LOG: logFile,
      UNITY_INSPECTOR_MCP_CLAIM_FILE: claimFile,
      ...env,
    },
  });

  const messages = [];
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      messages.push(JSON.parse(line));
    }
  });
  proc.stderr.resume();

  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const waitFor = async (predicate, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = messages.find(predicate);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  };

  const childPids = () =>
    execSync(`pgrep -P ${proc.pid} || true`).toString().trim().split('\n').filter(Boolean);

  return {
    proc,
    messages,
    send,
    sleep,
    waitFor,
    logFile,
    claimFile,
    childPids,
    async initialize(id = 0) {
      send({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      });
      const reply = await waitFor((m) => m.id === id);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return reply;
    },
    stop() {
      proc.kill('SIGKILL');
      try { rmSync(logDir, { recursive: true, force: true }); } catch {}
    },
  };
}
