import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { mkdtempSync, readFileSync, rmSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = path.join(__dirname, '..', '..', 'wrapper.js');
const STUB_CHILD_PATH = path.join(__dirname, 'stub-child.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function startWrapper(env = {}, { detached = false } = {}) {
  const logDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-wrapper-test-'));
  const logFile = path.join(logDir, 'wrapper.log');
  // Where the server records the owner.pid it wrote, and the only place the wrapper looks for it
  const claimFile = path.join(logDir, 'wrapper.claim');

  const proc = spawn(process.execPath, [WRAPPER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached,
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
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      messages.push(JSON.parse(line));
    }
  });
  proc.stderr.resume();

  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');

  const waitFor = async (predicate, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = messages.find(predicate);
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  };

  const readLog = () => {
    try {
      return readFileSync(logFile, 'utf8');
    } catch {
      return '';
    }
  };

  const waitForLog = async (pattern, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = readLog().match(pattern);
      if (match) return match;
      await sleep(25);
    }
    return null;
  };

  const reaperPid = () => {
    const match = readLog().match(/to reaper (\d+)/);
    return match ? Number(match[1]) : null;
  };

  const waitForReaper = async (timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pid = reaperPid();
      if (pid !== null && !alive(pid)) return true;
      await sleep(25);
    }
    return false;
  };

  const childPids = () =>
    execSync(`pgrep -P ${proc.pid} || true`).toString().trim().split('\n').filter(Boolean);

  return {
    proc,
    messages,
    send,
    sleep,
    waitFor,
    waitForLog,
    readLog,
    reaperPid,
    waitForReaper,
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
      try { proc.kill('SIGKILL'); } catch {}
      const reaper = reaperPid();
      if (reaper !== null) {
        try { process.kill(reaper, 'SIGKILL'); } catch {}
      }
      try { rmSync(logDir, { recursive: true, force: true }); } catch {}
    },
  };
}

export async function claudeCodeClose(proc) {
  const pid = proc.pid;
  process.kill(pid, 'SIGINT');
  await sleep(100);
  if (!alive(pid)) return;
  process.kill(pid, 'SIGTERM');
  await sleep(400);
  if (!alive(pid)) return;
  process.kill(pid, 'SIGKILL');
}

export async function sdkClientClose(proc) {
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once('exit', resolve);
  });
  const within = (ms) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);

  proc.stdin.end();
  if (await within(2000)) return;
  proc.kill('SIGTERM');
  if (await within(2000)) return;
  proc.kill('SIGKILL');
}

export { alive };
