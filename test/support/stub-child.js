#!/usr/bin/env node

import { spawn } from 'child_process';

if (process.env.STUB_CHILD_DIE_ON_START === '1') {
  process.exit(7);
}

const ignoresStop = process.env.STUB_CHILD_IGNORE_STOP === '1';
if (ignoresStop) {
  process.on('SIGTERM', () => {});
  // Closed stdin leaves nothing else to keep it alive
  setInterval(() => {}, 1000);
}

const slowStopMs = Number(process.env.STUB_CHILD_SLOW_STOP_MS) || 0;
let stopRequested = false;
const stopSlowly = () => {
  if (stopRequested) return;
  stopRequested = true;
  setTimeout(() => process.exit(0), slowStopMs);
};
if (slowStopMs > 0) {
  process.on('SIGTERM', stopSlowly);
  process.on('SIGHUP', stopSlowly);
}

let initDelayMs = 0;
let answersInit = true;
let listFails = false;
if (process.env.STUB_CHILD_START_COUNTER) {
  const { readFileSync, writeFileSync } = await import('fs');
  let started = 0;
  try { started = Number(readFileSync(process.env.STUB_CHILD_START_COUNTER, 'utf8')) || 0; } catch {}
  writeFileSync(process.env.STUB_CHILD_START_COUNTER, String(started + 1));
  if (String(started + 1) === process.env.STUB_CHILD_SLOW_INIT_ON) initDelayMs = 1500;
  if (String(started + 1) === process.env.STUB_CHILD_NO_INIT_ON) answersInit = false;
  if (String(started + 1) === process.env.STUB_CHILD_EXIT_ON) setTimeout(() => process.exit(5), 600);
  if (String(started + 1) === process.env.STUB_CHILD_LIST_FAILS_ON) listFails = true;
  if (started + 1 <= Number(process.env.STUB_CHILD_DIE_UNTIL ?? 0)) process.exit(6);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    const { id, method } = request;

    if (method === 'initialize') {
      if (!answersInit) continue;
      setTimeout(() => send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-child', version: '1.0.0' },
        },
      }), initDelayMs);
    } else if (method === 'tools/list') {
      if (listFails) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'toolDefinitions is not a function' } });
        continue;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: [{ name: 'stub_tool', description: 'stub', inputSchema: { type: 'object', properties: {} } }] },
      });
    } else if (method === 'test/echo') {
      send({ jsonrpc: '2.0', id, result: { echo: request.params ?? null } });
    } else if (method === 'test/notify') {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'test/die') {
      process.exit(9);
    } else if (method === 'test/big') {
      send({ jsonrpc: '2.0', id, result: { text: '—'.repeat(request.params?.count ?? 100000) } });
    } else if (method === 'test/answer-after-exit') {
      const answer = JSON.stringify({ jsonrpc: '2.0', id, result: { answered: true } });
      spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(answer + '\n')}), 300)`], {
        stdio: ['ignore', 'inherit', 'ignore'],
      });
      process.exit(9);
    } else if (method === 'test/late') {
      setTimeout(() => send({ jsonrpc: '2.0', id, result: { late: true } }), request.params?.ms ?? 300);
    } else if (method === 'test/hang') {
      // deliberately no reply
    } else if (id !== undefined && id !== null) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  }
});

process.stdin.on('end', () => {
  if (ignoresStop) return;
  if (slowStopMs > 0) stopSlowly();
  else process.exit(0);
});
