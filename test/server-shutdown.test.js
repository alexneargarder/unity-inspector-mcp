import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const SERVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const { shutdownOnce } = await import('../index.js');
const posix = process.platform !== 'win32';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(t) {
  const proc = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  proc.stdout.resume();
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { try { proc.kill('SIGKILL'); } catch {} });

  const deadline = Date.now() + 30000;
  while (!stderr.includes('running on stdio') && Date.now() < deadline) await sleep(25);
  assert.match(stderr, /running on stdio/, `the server never started: ${stderr}`);

  return { proc, exited, stderr: () => stderr };
}

const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => null)]);
const shutdownLines = (text) => text.split('\n').filter((line) => line.includes('Shutting down'));

test('the server shuts down when its stdin closes', { timeout: 20000, skip: !posix }, async (t) => {
  const server = await startServer(t);

  server.proc.stdin.end();
  const ended = await within(server.exited, 5000);

  assert.deepEqual(ended, { code: 0, signal: null }, `the server ended ${JSON.stringify(ended)}: ${server.stderr()}`);
  assert.deepEqual(shutdownLines(server.stderr()), ['Shutting down Unity Inspector MCP server (stdin end)...']);
});

test('a shutdown trigger that lands while a shutdown is in progress starts no second shutdown', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const exits = [];
  let exited;
  const firstExit = new Promise((resolve) => { exited = resolve; });
  const exit = (code) => {
    exits.push(code);
    exited();
  };

  shutdownOnce('stdin end', { exit });
  shutdownOnce('SIGTERM', { exit });
  assert.deepEqual(exits, [], 'the first shutdown had already exited when the second trigger landed');
  await firstExit;

  assert.deepEqual(exits, [0]);
  const lines = logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('Shutting down'));
  assert.deepEqual(lines, ['Shutting down Unity Inspector MCP server (stdin end)...']);
});

test('the server shuts down on a hangup', { timeout: 20000, skip: !posix }, async (t) => {
  const server = await startServer(t);

  server.proc.kill('SIGHUP');
  const ended = await within(server.exited, 5000);

  assert.deepEqual(ended, { code: 0, signal: null });
  assert.deepEqual(shutdownLines(server.stderr()), ['Shutting down Unity Inspector MCP server (SIGHUP)...']);
});

test('a server whose stdout nobody reads any more shuts down instead of crashing', { timeout: 20000, skip: !posix }, async (t) => {
  const server = await startServer(t);

  server.proc.stdout.destroy();
  server.proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  }) + '\n');
  const ended = await within(server.exited, 5000);

  assert.deepEqual(ended, { code: 0, signal: null }, `the server ended ${JSON.stringify(ended)}: ${server.stderr()}`);
  assert.deepEqual(shutdownLines(server.stderr()), ['Shutting down Unity Inspector MCP server (stdout EPIPE)...']);
});
