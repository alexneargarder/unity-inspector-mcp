import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import {
  parseScriptMetadata,
  readScriptSource,
  listTestScripts,
  resolveTestScriptPath,
  validateTestScriptSteps,
  EXAMPLE_SCRIPTS_DIR,
} from '../lib/script-library.js';

test('parseScriptMetadata reads a header preceded by blank lines and a banner', () => {
  const content = [
    '',
    '// ============================',
    '',
    '// #name Blank Led',
    '// #description Has a blank line first',
    '// #tags a, b',
    '// #args first: one',
    '// #args second: two',
    '',
    'public class Foo {}',
  ].join('\n');

  const metadata = parseScriptMetadata(content);
  assert.equal(metadata.name, 'Blank Led');
  assert.equal(metadata.description, 'Has a blank line first');
  assert.equal(metadata.tags, 'a, b');
  assert.deepEqual(metadata.args, ['first: one', 'second: two']);
});

test('parseScriptMetadata stops at the first code line', () => {
  const content = 'public class Foo {}\n// #name Too Late\n';
  assert.deepEqual(parseScriptMetadata(content), {});
});

test('readScriptSource refuses relative paths that escape the library', async () => {
  await assert.rejects(readScriptSource('../../etc/passwd'), /escapes the script library/);
  await assert.rejects(readScriptSource('../wrapper.js'), /escapes the script library/);
});

test('readScriptSource loads a library script by bare name', async () => {
  const script = await readScriptSource('watch-field');
  assert.equal(script.name, 'watch-field');
  assert.match(script.source, /WatchField/);
});

test('list_test_scripts finds the shipped examples', async () => {
  const listing = await listTestScripts();
  const names = listing.scripts.map((s) => s.name);

  for (const example of [
    'example-combat-test.json',
    'example-level-sequence.json',
    'example-movement-test.json',
  ]) {
    assert.ok(names.includes(example), `expected ${example} in ${JSON.stringify(names)}`);
  }
  assert.ok(listing.count >= 3);
});

test('run_test_script resolves a shipped example by name', async () => {
  const resolved = await resolveTestScriptPath('example-combat-test');
  assert.equal(resolved, path.join(EXAMPLE_SCRIPTS_DIR, 'example-combat-test.json'));

  const withExtension = await resolveTestScriptPath('example-movement-test.json');
  assert.equal(withExtension, path.join(EXAMPLE_SCRIPTS_DIR, 'example-movement-test.json'));

  await assert.rejects(resolveTestScriptPath('no-such-script'), /Test script not found/);
});

test('test scripts reject steps that only the MCP server can run', () => {
  const problems = validateTestScriptSteps([
    { command: 'ping' },
    { command: 'read_log' },
    { command: 'launch_game' },
    { command: 'execute_script', params: { path: 'watch-field' } },
    { command: 'execute_script', params: { source: 'class X {}' } },
    {},
  ]);

  assert.equal(problems.length, 4);
  assert.match(problems[0], /step 2: "read_log"/);
  assert.match(problems[1], /step 3: "launch_game"/);
  assert.match(problems[2], /step 4: "execute_script" needs params\.source/);
  assert.match(problems[3], /step 6: missing "command"/);
});

test('the shipped examples only use game-side commands', async () => {
  const { readFile } = await import('fs/promises');
  for (const name of [
    'example-combat-test.json',
    'example-level-sequence.json',
    'example-movement-test.json',
  ]) {
    const script = JSON.parse(await readFile(path.join(EXAMPLE_SCRIPTS_DIR, name), 'utf-8'));
    assert.deepEqual(validateTestScriptSteps(script.steps), [], `${name} has unsupported steps`);
  }
});
