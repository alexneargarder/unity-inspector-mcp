import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildToolList, handleToolCall, resolvePollBudget } = await import('../index.js');
const { isGameRunning } = await import('../lib/game-process.js');
const { NODE_ONLY_TOOLS, validateTestScriptSteps } = await import('../lib/script-library.js');

// The tool list ships to clients on every session start; these limits keep growth deliberate.
const MAX_TOOL_CHARS = 2800;
const MAX_TOTAL_CHARS = 26000;

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

test('execute_code advertises statements, return, and the result contract', async () => {
  const { description } = await toolNamed('execute_code');
  assert.match(description, /statements/i);
  assert.match(description, /return expr;/);
  assert.match(description, /local/i);
  assert.match(description, /do not persist/i);
  assert.match(description, /success/);
  assert.match(description, /resultSet:true/);
  assert.match(description, /resultSet:false/);
  assert.match(description, /stackTrace/);
  assert.match(description, /position/);
  assert.match(description, /statement/);
  assert.doesNotMatch(description, /envelope/i, 'the tool result is the mod object, not a wrapper around it');
});

test('simulate_input advertises the sequence form and what the actions do', async () => {
  const tool = await toolNamed('simulate_input');

  const sequence = tool.inputSchema.properties.sequence;
  assert.equal(sequence?.type, 'array');
  assert.equal(sequence.items.type, 'object');
  assert.equal(sequence.items.properties.action.type, 'string');
  assert.equal(sequence.items.properties.duration.type, 'number');
  assert.equal(sequence.items.properties.wait.type, 'number');
  assert.deepEqual(tool.inputSchema.required, [], 'action-or-sequence is enforced by the handler, not the schema');

  assert.match(tool.description, /exactly one of/i);
  assert.match(tool.description, /'sequence'/);
  assert.match(tool.description, /highFive/);
  assert.match(tool.description, /interact button/);
  assert.match(tool.description, /switch/);
  assert.match(tool.description, /count/);
  assert.match(tool.description, /duration/);
});

test('query_gameobjects advertises base-type matching and the scan fields', async () => {
  const { description } = await toolNamed('query_gameobjects');
  assert.match(description, /base types/i);
  assert.match(description, /interfaces/i);
  assert.match(description, /subclass/i);
  assert.match(description, /resolvedType/);
  assert.match(description, /scanTruncated/);
});

test('game_state advertises the level fields and the single gameplay scene', async () => {
  const { description } = await toolNamed('game_state');
  assert.match(description, /levelName/);
  assert.match(description, /levelNumber/);
  assert.match(description, /campaignName/);
  assert.match(description, /campaignDisplay/);
  assert.match(description, /isCampaignScene/);
  assert.match(description, /one gameplay scene/);
});

test('list_enemies advertises the classification and the suppression answer', async () => {
  const { description } = await toolNamed('list_enemies');
  assert.ok(description.length < 500, `list_enemies description is ${description.length} characters`);
  assert.match(description, /the game's own classification/i);
  assert.match(description, /unitType/);
  assert.match(description, /category/);
  assert.match(description, /isMook/);
  assert.match(description, /mapLoaded/);
  assert.match(description, /enemySpawnSuppressed/);
  assert.match(description, /enemySpawnPrefixOwners/);
  assert.match(description, /suppressedBy/);
});

test('go_to_level advertises the index-range behaviour', async () => {
  const { description } = await toolNamed('go_to_level');
  assert.match(description, /out-of-range campaignIndex/i);
  assert.match(description, /Victory/);
});

test('modify_component advertises the failure reasons and the success rule', async () => {
  const tool = await toolNamed('modify_component');
  const { description } = tool;
  assert.match(description, /'not-found'/);
  assert.match(description, /'read-only'/);
  assert.match(description, /'error'/);
  assert.match(description, /static/i);
  assert.match(description, /'success' is false when nothing was written/);
  assert.match(description, /dotted paths into nested members/);
  assert.match(description, /'suggestions'/);
  assert.equal(tool.inputSchema.properties.properties.minProperties, 1, 'an empty properties object is rejected by the schema');
  assert.match(tool.inputSchema.properties.properties.description, /dotted path/);
});

test('inspect_component advertises static members, dotted paths and suggestions', async () => {
  const tool = await toolNamed('inspect_component');
  const { description } = tool;
  assert.match(description, /static/i);
  assert.match(description, /'memberPath'/);
  assert.match(description, /dotted path/);
  assert.match(description, /'suggestions'/);
  assert.equal(tool.inputSchema.properties.memberPath?.type, 'string');
  assert.match(tool.inputSchema.properties.memberPath.description, /instead of the whole component/);
  assert.deepEqual(tool.inputSchema.required, ['path', 'componentType'], 'memberPath stays optional');
});

test('the bro tools advertise the Swap Bros Mod gate and the rosters a miss answers with', async () => {
  for (const name of ['swap_bro', 'set_bro']) {
    const { description } = await toolNamed(name);
    assert.match(description, /availableBros/, name);
    assert.match(description, /allNormal/, name);
    assert.match(description, /allExpendabros/, name);
    assert.match(description, /allUnfinished/, name);
  }

  // set_bro and list_bros are gated on the mod exactly as swap_bro is
  for (const name of ['swap_bro', 'set_bro', 'list_bros']) {
    const { description } = await toolNamed(name);
    assert.match(description, /Requires Swap Bros Mod/, name);
    assert.match(description, /refused when it is not active/, name);
    assert.doesNotMatch(
      description,
      /falls back/i,
      'there is no fallback — the call is refused when Swap Bros Mod is not active',
    );
  }
});

test('take_screenshot advertises the highlight argument and what it reports', async () => {
  const tool = await toolNamed('take_screenshot');
  assert.match(tool.description, /highlighted/);
  assert.match(tool.description, /highlightError/);
  assert.match(tool.description, /succeeds either way/);

  const { highlight } = tool.inputSchema.properties;
  assert.deepEqual(highlight?.type, ['string', 'object'], 'highlight takes a path or a rectangle');
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.equal(highlight.properties[key]?.type, 'number', `highlight.${key}`);
  }
  assert.match(highlight.description, /world units/);
  assert.match(highlight.description, /inactive/, 'an inactive target is a highlightError, not an outline');
  assert.match(highlight.description, /camera/, 'an off-screen target is a highlightError, not an outline');
  assert.ok(!tool.inputSchema.required, 'highlight stays optional');
});

test('spawn_entity advertises the type roster and the velocity arguments', async () => {
  const tool = await toolNamed('spawn_entity');
  assert.match(tool.description, /availableTypes/);
  assert.match(tool.description, /RocketLib `UnitType`/);
  assert.match(tool.description, /display name/i);
  assert.match(tool.inputSchema.properties.type.description, /UnitType/);
  assert.equal(tool.inputSchema.properties.xI?.type, 'number');
  assert.equal(tool.inputSchema.properties.yI?.type, 'number');
  assert.deepEqual(tool.inputSchema.required, ['type', 'x', 'y'], 'velocities stay optional');
});

test('spawn_entity says where the prefab comes from and how it fails', async () => {
  const tool = await toolNamed('spawn_entity');

  assert.ok(
    tool.description.length < 650,
    `spawn_entity's description is at its ceiling at ${tool.description.length} characters - anything new has to be paid for by a trim elsewhere in it`
  );
  assert.match(tool.description, /theme or the shared assets/, 'the prefab is the theme\'s or the shared assets\'');
  assert.match(tool.description, /no prefab for fails/, 'a theme without the prefab is a failure, not a promise');
  assert.match(tool.description, /try a level whose theme has it/);
  assert.match(tool.description, /`Baneling` is the theme's mosquito and `Screecher` its baneling/);
  assert.match(tool.description, /`Bro` is refused/, 'bros come from the roster, not spawn_entity');
  assert.match(tool.description, /a failure returns `error`, with `availableTypes` on an unknown name/);
  assert.doesNotMatch(tool.description, /stackTrace/, 'the failure shape no longer promises a stack trace');
  assert.doesNotMatch(tool.description, /every level/, 'not every unit works on every level');
});

test('capture_animations is listed, and is server-side orchestration rather than a game command', async () => {
  const tool = await toolNamed('capture_animations');
  assert.deepEqual(tool.inputSchema.required, ['out']);
  assert.match(tool.description, /animation/i);
  assert.match(tool.description, /report\.md/);

  assert.ok(NODE_ONLY_TOOLS.has('capture_animations'));
  assert.deepEqual(
    validateTestScriptSteps([{ command: 'capture_animations', params: { out: '/tmp/x' } }]),
    ['step 1: "capture_animations" is implemented by the MCP server, not the game'],
    'a test script cannot dispatch it at the game',
  );
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

test('the tool list stays within its size limits', async () => {
  const tools = await buildToolList();
  const sizes = tools.map((tool) => ({ name: tool.name, size: JSON.stringify(tool).length }));

  for (const { name, size } of sizes) {
    assert.ok(size <= MAX_TOOL_CHARS, `${name} is ${size} chars, over the ${MAX_TOOL_CHARS}-char limit`);
  }

  const total = sizes.reduce((sum, { size }) => sum + size, 0);
  const largest = [...sizes]
    .sort((a, b) => b.size - a.size)
    .slice(0, 3)
    .map(({ name, size }) => `${name} (${size})`)
    .join(', ');
  assert.ok(
    total <= MAX_TOTAL_CHARS,
    `tool list is ${total} chars, over the ${MAX_TOTAL_CHARS}-char limit; largest tools: ${largest}`,
  );
});
