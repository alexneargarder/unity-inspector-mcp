import test from 'node:test';
import assert from 'node:assert/strict';

import { handleToolCall } from '../index.js';

function textOf(response) {
  return response.content.map((c) => c.text).join('\n');
}

test('tool calls with no "arguments" member do not throw', { timeout: 20000 }, async () => {
  // `arguments` is optional in the MCP schema; these handlers all read args
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
