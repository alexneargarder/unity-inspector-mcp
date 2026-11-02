import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { startWrapper } from './support/wrapper-harness.js';

const posix = process.platform !== 'win32';

test('the wrapper replays initialize after the child dies unexpectedly', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());

  // id 0 is a real MCP id and must not be treated as falsy anywhere
  const initReply = await w.initialize(0);
  assert.ok(initReply, 'initialize was not answered');

  const first = await (async () => {
    w.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    return w.waitFor((m) => m.id === 1);
  })();
  assert.equal(first.result.tools.length, 2, 'stub tool + injected restart_server');

  const pids = w.childPids();
  assert.equal(pids.length, 1);
  process.kill(Number(pids[0]), 'SIGKILL');
  await w.sleep(1000);

  w.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const afterRespawn = await w.waitFor((m) => m.id === 2);
  assert.ok(afterRespawn, 'the wrapper went silent after the child died');
  assert.ok(!afterRespawn.error, `expected a live server, got ${JSON.stringify(afterRespawn.error)}`);
  assert.equal(afterRespawn.result.tools.length, 2);
});

test('restart_server fails requests that were still in flight', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 4, method: 'test/hang', params: {} });
  await w.sleep(200);

  w.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });

  const stranded = await w.waitFor((m) => m.id === 4, 10000);
  assert.ok(stranded, 'the in-flight request was never answered');
  assert.equal(stranded.error.code, -32000);
  assert.match(stranded.error.message, /restarted/);

  const restarted = await w.waitFor((m) => m.id === 5, 10000);
  assert.ok(restarted?.result, 'restart_server did not answer');

  w.send({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} });
  const afterRestart = await w.waitFor((m) => m.id === 6);
  assert.equal(afterRestart.result.tools.length, 2);
});

test('a request in flight when the child crashes gets an error, not silence', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 7, method: 'test/hang', params: {} });
  await w.sleep(200);
  w.send({ jsonrpc: '2.0', id: 8, method: 'test/die', params: {} });

  const answered = await w.waitFor((m) => m.id === 7, 10000);
  assert.ok(answered, 'the in-flight request was stranded by the crash');
  assert.equal(answered.error.code, -32000);
});

test('the crash-loop guard stops respawning, and restart_server recovers', { timeout: 30000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  for (let i = 0; i < 3; i++) {
    w.send({ jsonrpc: '2.0', id: 100 + i, method: 'test/die', params: {} });
    await w.sleep(600);
  }

  w.send({ jsonrpc: '2.0', id: 200, method: 'tools/list', params: {} });
  const lockedOut = await w.waitFor((m) => m.id === 200, 10000);
  assert.ok(lockedOut?.error, 'expected a JSON-RPC error while locked out');
  assert.equal(lockedOut.error.code, -32000);
  assert.match(lockedOut.error.message, /could not be respawned/);

  w.send({ jsonrpc: '2.0', id: 201, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const restarted = await w.waitFor((m) => m.id === 201, 15000);
  assert.ok(restarted?.result, 'restart_server did not answer');
  assert.match(restarted.result.content[0].text, /"success":true/);

  w.send({ jsonrpc: '2.0', id: 202, method: 'tools/list', params: {} });
  const recovered = await w.waitFor((m) => m.id === 202, 10000);
  assert.ok(!recovered.error, 'the wrapper did not recover after restart_server');
  assert.equal(recovered.result.tools.length, 2);
});

test("a notification from the child reaches the parent as the child sent it", { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 9, method: 'test/notify', params: {} });
  const notification = await w.waitFor((m) => m.method === 'notifications/tools/list_changed');

  assert.ok(notification, 'the notification never reached the parent');
  assert.deepEqual(notification, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  assert.ok(await w.waitFor((m) => m.id === 9), 'the request the notification came with went unanswered');
});
