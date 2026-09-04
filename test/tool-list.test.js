import test from 'node:test';
import assert from 'node:assert/strict';

// Port 1 has no listener: a live game would leave the module-level client's socket open and hang the run
process.env.UNITY_INSPECTOR_PORT = '1';

const { buildToolList, handleToolCall, resolvePollBudget } = await import('../index.js');
const { isGameRunning } = await import('../lib/game-process.js');

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

async function toolNamed(name) {
  const tools = await buildToolList();
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `no ${name} tool in the tool list`);
  return tool;
}

test('every tool has a name, description and input schema', async () => {
  const tools = await buildToolList();
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string', `unnamed tool: ${JSON.stringify(tool)}`);
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, 'string', `${tool.name} has no description`);
    assert.ok(tool.description.length > 0, `${tool.name} has an empty description`);
    assert.equal(typeof tool.inputSchema, 'object', `${tool.name} has no inputSchema`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema is not an object schema`);
  }
});

test('execute_code advertises statements, return, and the inner success field', async () => {
  const { description } = await toolNamed('execute_code');
  assert.match(description, /statements/i);
  assert.match(description, /return expr;/);
  assert.match(description, /local/i);
  assert.match(description, /do not persist/i);
  assert.match(description, /success/);
  assert.match(description, /resultSet:true/);
  assert.match(description, /resultSet:false/);
  assert.match(description, /stackTrace/);
});

test('query_gameobjects advertises base-type matching and the scan fields', async () => {
  const { description } = await toolNamed('query_gameobjects');
  assert.match(description, /base types/i);
  assert.match(description, /interfaces/i);
  assert.match(description, /subclass/i);
  assert.match(description, /resolvedType/);
  assert.match(description, /scanTruncated/);
});

test('spawn_entity advertises the type roster and the velocity arguments', async () => {
  const tool = await toolNamed('spawn_entity');
  assert.match(tool.description, /availableTypes/);
  assert.match(tool.description, /theme/i);
  assert.equal(tool.inputSchema.properties.xI?.type, 'number');
  assert.equal(tool.inputSchema.properties.yI?.type, 'number');
  assert.deepEqual(tool.inputSchema.required, ['type', 'x', 'y'], 'velocities stay optional');
});

test('wait_for_game reports which failure mode a timeout hit', { timeout: 30000 }, async () => {
  const running = await isGameRunning();
  const expected = { true: 'connection-refused', false: 'no-process', null: 'unknown' }[String(running)];

  const started = Date.now();
  const response = await handleToolCall({
    params: { name: 'wait_for_game', arguments: { timeout: 0.3, interval: 0.05 } },
  });
  const elapsed = Date.now() - started;

  const payload = JSON.parse(textOf(response));
  assert.equal(payload.success, false);
  assert.ok(payload.attempts >= 1, `expected at least one attempt, got ${payload.attempts}`);
  assert.equal(payload.state, expected, payload.message);

  const messageForState = {
    'no-process': /No Broforce process is running/,
    'connection-refused': /nothing accepted a connection/,
    'unknown': /process detection is unavailable/,
  };
  assert.match(payload.message, messageForState[expected]);
  // A host that black-holes the SYN burns the client's 5s connect timeout on the single attempt
  assert.ok(elapsed < 8000, `wait_for_game took ${elapsed}ms`);
});

test('wait_for_game still makes one attempt with a non-positive budget', { timeout: 30000 }, async () => {
  const response = await handleToolCall({
    params: { name: 'wait_for_game', arguments: { timeout: 0, interval: 0.05 } },
  });

  const payload = JSON.parse(textOf(response));
  assert.equal(payload.success, false);
  assert.equal(payload.attempts, 1);
  assert.ok(payload.lastError, 'a verdict with no attempt behind it has no lastError');
});

test('a non-numeric interval does not turn the poll into a spin', { timeout: 30000 }, async () => {
  const started = Date.now();
  const response = await handleToolCall({
    params: { name: 'wait_for_game', arguments: { timeout: 0, interval: '3 seconds' } },
  });
  const elapsed = Date.now() - started;

  const payload = JSON.parse(textOf(response));
  assert.equal(payload.success, false);
  assert.equal(payload.attempts, 1);
  assert.ok(elapsed < 8000, `wait_for_game took ${elapsed}ms`);
});

test('unusable poll budgets fall back instead of producing NaN deadlines', () => {
  const defaults = { budgetMs: 60000, intervalMs: 3000 };
  for (const bad of [NaN, undefined, null, '60s', {}, [], -1]) {
    assert.deepEqual(resolvePollBudget(bad, bad), defaults, `budget ${JSON.stringify(bad)} did not fall back`);
  }

  assert.deepEqual(resolvePollBudget(0, 10), { budgetMs: 0, intervalMs: 250 }, 'the interval has a floor');
  assert.deepEqual(resolvePollBudget(1500, 500), { budgetMs: 1500, intervalMs: 500 });
});
