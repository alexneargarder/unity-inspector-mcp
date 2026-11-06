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
  assert.match(stranded.error.message, /restarted before answering/);
  assert.match(stranded.error.message, /may already have run in the game/);
  assert.doesNotMatch(stranded.error.message, /Retry the call/);

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
  assert.match(answered.error.message, /exited before answering/);
  assert.match(answered.error.message, /may already have run in the game/);
  assert.match(answered.error.message, /check the log before retrying/);
  assert.ok(answered.error.message.includes(w.logFile), 'the message does not name the log');
  assert.match(answered.error.message, /is restarting/);
  assert.doesNotMatch(answered.error.message, /Retry the call/);
  assert.doesNotMatch(answered.error.message, /restart_server/);
});

test('a request sent while restart_server is stopping the old child is told to retry, not to restart', { timeout: 20000, skip: !posix }, async (t) => {
  const { readFileSync } = await import('fs');
  const w = startWrapper({ STUB_CHILD_SLOW_STOP_MS: '1500' });
  t.after(() => w.stop());
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 80, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !readFileSync(w.logFile, 'utf8').includes('Restart requested')) await w.sleep(25);
  assert.match(readFileSync(w.logFile, 'utf8'), /Restart requested/);

  w.send({ jsonrpc: '2.0', id: 81, method: 'test/echo', params: {} });
  const during = await w.waitFor((m) => m.id === 81, 1000);
  assert.ok(during, 'the request sent during the stop was not answered at once');
  assert.equal(during.error?.code, -32000);
  assert.match(during.error.message, /is restarting/);
  assert.match(during.error.message, /Retry the call/);
  assert.doesNotMatch(during.error.message, /not running/);
  assert.equal(w.messages.some((m) => m.id === 80), false, 'the restart finished before the request was sent');

  const restarted = await w.waitFor((m) => m.id === 80, 15000);
  assert.match(restarted?.result?.content?.[0]?.text ?? '', /"success":true/);
  w.send({ jsonrpc: '2.0', id: 82, method: 'tools/list', params: {} });
  assert.equal((await w.waitFor((m) => m.id === 82))?.result?.tools?.length, 2);
});

test('the crash-loop guard stops respawning, and restart_server recovers', { timeout: 30000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  for (let i = 0; i < 3; i++) {
    w.send({ jsonrpc: '2.0', id: 100 + i, method: 'test/die', params: {} });
    await w.sleep(600);
  }

  for (const id of [100, 101]) {
    const died = w.messages.find((m) => m.id === id);
    assert.match(died?.error?.message ?? '', /exited before answering.*is restarting/, `request ${id}`);
  }
  const lockoutDeath = w.messages.find((m) => m.id === 102);
  assert.match(lockoutDeath?.error?.message ?? '', /exited before answering.*could not be respawned/);
  assert.doesNotMatch(lockoutDeath.error.message, /is restarting/);

  w.send({ jsonrpc: '2.0', id: 200, method: 'test/echo', params: {} });
  const lockedOut = await w.waitFor((m) => m.id === 200, 10000);
  assert.ok(lockedOut?.error, 'expected a JSON-RPC error while locked out');
  assert.equal(lockedOut.error.code, -32000);
  assert.match(lockedOut.error.message, /could not be respawned/);
  w.send({ jsonrpc: '2.0', id: 203, method: 'tools/list', params: {} });
  assert.deepEqual((await w.waitFor((m) => m.id === 203))?.result?.tools?.map((tool) => tool.name), ['restart_server']);

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

test('restart_server kills a child that ignores SIGTERM after its grace', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper({ STUB_CHILD_IGNORE_STOP: '1' });
  t.after(() => {
    for (const pid of w.childPids()) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch {}
    }
    w.stop();
  });
  await w.initialize(0);

  const [hung] = w.childPids();
  assert.ok(hung, 'no child was running');

  const started = Date.now();
  w.send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const restarted = await w.waitFor((m) => m.id === 30, 15000);
  const elapsed = Date.now() - started;

  assert.ok(restarted?.result, 'restart_server did not answer');
  assert.match(restarted.result.content[0].text, /"success":true/);
  assert.ok(elapsed >= 2900, `the hung child was not given its 3s grace (${elapsed}ms)`);
  assert.throws(() => process.kill(Number(hung), 0), { code: 'ESRCH' }, 'the hung child survived the restart');

  const children = w.childPids();
  assert.equal(children.length, 1, `children: ${children.join(', ')}`);
  assert.notEqual(children[0], hung);

  w.send({ jsonrpc: '2.0', id: 31, method: 'tools/list', params: {} });
  const listed = await w.waitFor((m) => m.id === 31);
  assert.equal(listed.result.tools.length, 2);
});

test('a restart_server sent during another shares it, leaving one child', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);
  const [original] = w.childPids();

  w.send({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  w.send({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const first = await w.waitFor((m) => m.id === 40, 15000);
  const second = await w.waitFor((m) => m.id === 41, 15000);

  for (const reply of [first, second]) {
    assert.ok(reply?.result, 'a restart went unanswered');
    assert.match(reply.result.content[0].text, /"success":true/);
  }

  const children = w.childPids();
  assert.equal(children.length, 1, `children: ${children.join(', ')}`);
  assert.notEqual(children[0], original);

  w.send({ jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} });
  assert.ok(await w.waitFor((m) => m.id === 42), 'the restarted child does not answer');
});

test('a restart_server during a respawn waits for it, and the respawn never stops the restarted child', { timeout: 30000, skip: !posix }, async (t) => {
  const { mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-overlap-'));
  const w = startWrapper({ STUB_CHILD_START_COUNTER: join(dir, 'starts'), STUB_CHILD_SLOW_INIT_ON: '2' });
  t.after(() => { w.stop(); rmSync(dir, { recursive: true, force: true }); });
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 50, method: 'test/die' });
  assert.ok(await w.waitFor((m) => m.id === 50), 'the request the child died under went unanswered');
  const diedAt = Date.now();
  await w.sleep(300);

  w.send({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const restarted = await w.waitFor((m) => m.id === 51, 15000);
  assert.match(restarted?.result?.content?.[0]?.text ?? '', /"success":true/);
  const restartedChild = w.childPids();
  assert.equal(restartedChild.length, 1, `children: ${restartedChild.join(', ')}`);

  await w.sleep(Math.max(0, diedAt + 11500 - Date.now()));
  assert.deepEqual(w.childPids(), restartedChild, 'the restarted child was replaced');
  w.send({ jsonrpc: '2.0', id: 52, method: 'test/echo', params: { alive: true } });
  const echoed = await w.waitFor((m) => m.id === 52, 3000);
  assert.deepEqual(echoed?.result, { echo: { alive: true } }, `the restarted child is gone: ${JSON.stringify(echoed)}`);
});

test('a request sent to a child that dies during a restart is answered, not left waiting', { timeout: 30000, skip: !posix }, async (t) => {
  const { mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-dies-in-init-'));
  const w = startWrapper({
    STUB_CHILD_START_COUNTER: join(dir, 'starts'),
    STUB_CHILD_SLOW_INIT_ON: '2',
    STUB_CHILD_EXIT_ON: '2',
  });
  t.after(() => { w.stop(); rmSync(dir, { recursive: true, force: true }); });
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  await w.sleep(250);
  w.send({ jsonrpc: '2.0', id: 61, method: 'test/hang' });

  const restart = await w.waitFor((m) => m.id === 60, 15000);
  assert.match(restart?.result?.content?.[0]?.text ?? '', /"success":false/);
  const stranded = await w.waitFor((m) => m.id === 61, 3000);
  assert.ok(stranded, 'the request the dead child was sent was never answered');
  assert.match(stranded.error?.message ?? '', /exited before answering/);

  w.send({ jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  assert.match((await w.waitFor((m) => m.id === 62, 15000))?.result?.content?.[0]?.text ?? '', /"success":true/);
  assert.equal(w.messages.filter((m) => m.id === 61).length, 1, 'answered exactly once');
});

test('a restart whose child never answers initialize fails after its 10s wait and stops that child', { timeout: 40000, skip: !posix }, async (t) => {
  const { mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-no-init-'));
  const w = startWrapper({ STUB_CHILD_START_COUNTER: join(dir, 'starts'), STUB_CHILD_NO_INIT_ON: '2' });
  t.after(() => { w.stop(); rmSync(dir, { recursive: true, force: true }); });
  await w.initialize(0);

  const started = Date.now();
  w.send({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  await w.sleep(500);
  const [silent] = w.childPids();
  assert.ok(silent, 'the restart started no child');

  const restart = await w.waitFor((m) => m.id === 70, 15000);
  const elapsed = Date.now() - started;
  assert.ok(restart?.result, 'restart_server did not answer');
  assert.equal(restart.result.isError, true);
  assert.match(restart.result.content[0].text, /"success":false/);
  assert.match(restart.result.content[0].text, /Init timeout/);
  assert.ok(elapsed >= 9500, `the restart gave up before its 10s init wait (${elapsed}ms)`);
  await w.sleep(300);
  assert.throws(() => process.kill(Number(silent), 0), { code: 'ESRCH' }, 'the child that never initialized was left running');
  assert.deepEqual(w.childPids(), []);

  w.send({ jsonrpc: '2.0', id: 71, method: 'test/echo', params: {} });
  const down = await w.waitFor((m) => m.id === 71);
  assert.equal(down?.error?.code, -32000);
  assert.match(down.error.message, /could not be respawned/);

  w.send({ jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  assert.match((await w.waitFor((m) => m.id === 72, 15000))?.result?.content?.[0]?.text ?? '', /"success":true/);
  w.send({ jsonrpc: '2.0', id: 73, method: 'tools/list', params: {} });
  assert.equal((await w.waitFor((m) => m.id === 73))?.result?.tools?.length, 2);
});

test('restart_server refuses an argument it does not take and restarts nothing', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);
  const [original] = w.childPids();

  w.send({ jsonrpc: '2.0', id: 300, method: 'tools/call', params: { name: 'restart_server', arguments: { bogus: 1 } } });
  const refused = await w.waitFor((m) => m.id === 300);
  assert.equal(refused?.result?.isError, true);
  assert.equal(refused.result.content[0].text, 'Error: restart_server has no argument "bogus"; it takes no arguments');
  await w.sleep(200);
  assert.deepEqual(w.childPids(), [original], 'the server was restarted anyway');
  assert.doesNotMatch(w.readLog(), /Restart requested/);
});

test('restart_server succeeds only once the new server has listed its tools, and says how many', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 310, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const restarted = await w.waitFor((m) => m.id === 310, 15000);
  assert.deepEqual(JSON.parse(restarted.result.content[0].text), {
    success: true,
    message: 'MCP server restarted successfully, listing 1 tools',
  });
  assert.equal(w.messages.filter((m) => m.result?.tools).length, 0);
});

test('a restart whose server cannot list its tools fails, naming the error and the log, and stops it', { timeout: 20000, skip: !posix }, async (t) => {
  const { mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-list-fails-'));
  const w = startWrapper({ STUB_CHILD_START_COUNTER: join(dir, 'starts'), STUB_CHILD_LIST_FAILS_ON: '2' });
  t.after(() => { w.stop(); rmSync(dir, { recursive: true, force: true }); });
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 320, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  const restart = await w.waitFor((m) => m.id === 320, 15000);
  assert.equal(restart?.result?.isError, true);
  const outcome = JSON.parse(restart.result.content[0].text);
  assert.equal(outcome.success, false);
  assert.match(outcome.error, /could not list its tools: toolDefinitions is not a function/);
  assert.ok(outcome.error.includes(w.logFile), 'the failure does not name the log');
  assert.equal(w.messages.some((m) => m.method === 'notifications/tools/list_changed'), false);
  await w.sleep(300);
  assert.deepEqual(w.childPids(), [], 'the server that could not list its tools was left running');

  w.send({ jsonrpc: '2.0', id: 321, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  assert.match((await w.waitFor((m) => m.id === 321, 15000))?.result?.content?.[0]?.text ?? '', /"success":true/);
});

test('a server that cannot start still leaves the client a session in which restart_server works', { timeout: 30000, skip: !posix }, async (t) => {
  const { mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-dead-at-start-'));
  const w = startWrapper({ STUB_CHILD_START_COUNTER: join(dir, 'starts'), STUB_CHILD_DIE_UNTIL: '3' });
  t.after(() => { w.stop(); rmSync(dir, { recursive: true, force: true }); });
  assert.ok(await w.waitForLog(/not respawning/), 'the server never reached the lockout');

  const init = await w.initialize(0);
  assert.deepEqual(init?.result, {
    protocolVersion: '2024-11-05',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'unity-inspector-mcp', version: '1.0.0' },
  });
  w.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.deepEqual((await w.waitFor((m) => m.id === 1))?.result?.tools?.map((tool) => tool.name), ['restart_server']);

  w.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  assert.match((await w.waitFor((m) => m.id === 2, 15000))?.result?.content?.[0]?.text ?? '', /"success":true/);
  assert.ok(await w.waitFor((m) => m.method === 'notifications/tools/list_changed'), 'the client was not told to list again');
  w.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.equal((await w.waitFor((m) => m.id === 3))?.result?.tools?.length, 2);
});

test('an initialize the server dies under is answered by the wrapper rather than failed', { timeout: 30000, skip: !posix }, async (t) => {
  const { mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-dies-in-handshake-'));
  const w = startWrapper({ STUB_CHILD_START_COUNTER: join(dir, 'starts'), STUB_CHILD_NO_INIT_ON: '1', STUB_CHILD_EXIT_ON: '1' });
  t.after(() => { w.stop(); rmSync(dir, { recursive: true, force: true }); });

  const init = await w.initialize(0);
  assert.equal(init?.error, undefined, `the handshake failed: ${JSON.stringify(init?.error)}`);
  assert.equal(init.result.serverInfo.name, 'unity-inspector-mcp');
  assert.ok(await w.waitFor((m) => m.method === 'notifications/tools/list_changed', 15000), 'the respawn never told the client');
  w.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal((await w.waitFor((m) => m.id === 1))?.result?.tools?.length, 2);
});

test('text split across pipe reads reaches either side intact', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 400, method: 'test/big', params: { count: 100000 } });
  const big = await w.waitFor((m) => m.id === 400);
  assert.equal(big?.result?.text, '—'.repeat(100000));

  const text = '›'.repeat(100000);
  w.send({ jsonrpc: '2.0', id: 401, method: 'test/echo', params: { text } });
  const echoed = await w.waitFor((m) => m.id === 401);
  assert.equal(echoed?.result?.echo?.text, text);
});

test('an answer the server wrote before it died reaches the client, and only once', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 500, method: 'test/answer-after-exit', params: {} });
  await w.waitFor((m) => m.id === 500);
  await w.sleep(1000);
  const replies = w.messages.filter((m) => m.id === 500);
  assert.equal(replies.length, 1, `answered ${replies.length} times`);
  assert.deepEqual(replies[0].result, { answered: true }, `answered ${JSON.stringify(replies[0].error)}`);
});

test('a cancelled request is forgotten: its late answer is dropped and a later restart fails nothing for it', { timeout: 20000, skip: !posix }, async (t) => {
  const w = startWrapper();
  t.after(() => w.stop());
  await w.initialize(0);

  w.send({ jsonrpc: '2.0', id: 600, method: 'test/late', params: { ms: 300 } });
  w.send({ jsonrpc: '2.0', id: 601, method: 'test/hang', params: {} });
  w.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 600 } });
  w.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 601 } });
  assert.ok(await w.waitForLog(/Dropped a response to request 600/), 'the late answer was not dropped');

  w.send({ jsonrpc: '2.0', id: 602, method: 'tools/call', params: { name: 'restart_server', arguments: {} } });
  assert.ok(await w.waitFor((m) => m.id === 602, 15000), 'restart_server did not answer');
  assert.equal(w.messages.some((m) => m.id === 600 || m.id === 601), false, 'a cancelled request was answered');
});
