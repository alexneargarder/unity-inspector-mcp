import '../test-support/session.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { startStubServer, reply } from '../test-support/stub-server.js';

const requests = [];
const stub = await startStubServer((request, socket) => {
  requests.push(request);
  reply(socket, request.id, { success: true, method: request.method });
});

// The module-level client reads the port once at import, so the stub has to be listening before index.js loads
process.env.UNITY_INSPECTOR_PORT = String(stub.port);

const { handleToolCall } = await import('../index.js');

after(() => stub.close());

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

function lastRequest(method) {
  const sent = requests.filter((r) => r.method === method);
  assert.ok(sent.length > 0, `no ${method} request reached the game`);
  return sent[sent.length - 1];
}

test('tool calls with no "arguments" member do not throw', { timeout: 20000 }, async () => {
  for (const name of ['list_test_scripts', 'list_scripts', 'watch_log', 'list_gameobjects', 'query_gameobjects']) {
    const response = await handleToolCall({ params: { name } });
    const text = textOf(response);
    assert.doesNotMatch(
      text,
      /Cannot read propert(y|ies)|of undefined|is not a function/,
      `${name} blew up on missing arguments: ${text}`,
    );
  }
});

test('a Node-only tool works without arguments', async () => {
  const response = await handleToolCall({ params: { name: 'list_test_scripts' } });
  assert.ok(!response.isError, textOf(response));
  const payload = JSON.parse(textOf(response));
  assert.ok(payload.count >= 3);
});

test('an unknown tool reports an error rather than throwing', async () => {
  const response = await handleToolCall({ params: { name: 'no_such_tool' } });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /Unknown tool/);
});

test('simulate_input forwards a sequence to the game untouched', async () => {
  const sequence = [{ action: 'special', duration: 150 }, { wait: 800 }, { action: 'special', duration: 150 }];
  const response = await handleToolCall({
    params: { name: 'simulate_input', arguments: { sequence, player: 1 } },
  });

  assert.ok(!response.isError, textOf(response));
  const sent = lastRequest('simulate_input');
  assert.deepEqual(sent.params.sequence, sequence);
  assert.equal(sent.params.player, 1);
  assert.equal(sent.params.action, undefined, 'no action is invented for a sequence call');
});

test('simulate_input needs exactly one of action and sequence', async () => {
  const neither = await handleToolCall({ params: { name: 'simulate_input', arguments: {} } });
  assert.equal(neither.isError, true);
  assert.match(textOf(neither), /action/);
  assert.match(textOf(neither), /sequence/);

  const both = await handleToolCall({
    params: { name: 'simulate_input', arguments: { action: 'fire', sequence: [{ action: 'jump' }] } },
  });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /action/);
  assert.match(textOf(both), /sequence/);

  const empty = await handleToolCall({ params: { name: 'simulate_input', arguments: { sequence: [] } } });
  assert.equal(empty.isError, true, 'an empty sequence is not a sequence');
});
