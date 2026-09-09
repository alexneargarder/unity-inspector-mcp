import '../test-support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import {
  parseScriptMetadata,
  readScriptSource,
  listTestScripts,
  resolveTestScriptPath,
  runTestScript,
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

async function writeTestScript(t, steps) {
  const { mkdtemp, writeFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');

  const dir = await mkdtemp(path.join(tmpdir(), 'test-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const scriptPath = path.join(dir, 'expectations.json');
  await writeFile(scriptPath, JSON.stringify({ name: 'Expectations', steps }), 'utf-8');
  return scriptPath;
}

function stubClient(replies) {
  const sent = [];
  return {
    sent,
    translateScreenshotPath: (p) => p,
    async sendCommand(command, params) {
      sent.push({ command, params });
      const reply = replies[sent.length - 1];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test('an expected failure passes the step and the script keeps going', async (t) => {
  const scriptPath = await writeTestScript(t, [
    {
      command: 'execute_code',
      params: { code: 'nope' },
      expect: { success: false, contains: ['CS0122'], notContains: ['stackTrace": "at'] },
    },
    { command: 'ping', params: {} },
  ]);

  const client = stubClient([
    { success: false, error: 'error CS0122: inaccessible', stackTrace: null },
    { success: true },
  ]);

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.completedSteps, 2, 'the expected failure must not stop the script');
  assert.equal(run.failedSteps, 0);
  assert.equal(run.results[0].success, true);
  assert.deepEqual(run.results[0].expect, {
    success: false,
    contains: ['CS0122'],
    notContains: ['stackTrace": "at'],
  });
  assert.deepEqual(run.results[0].expectations.unmet, []);
  assert.equal(run.results[0].expectations.met.length, 3);
  assert.equal(run.results[0].error, undefined);
});

test('an unmet expectation fails the step and stops the script', async (t) => {
  const scriptPath = await writeTestScript(t, [
    { command: 'execute_code', params: { code: 'ok' }, expect: { success: false, contains: ['CS0122'] } },
    { command: 'ping', params: {} },
  ]);

  const client = stubClient([{ success: true, resultSet: true, result: 7 }, { success: true }]);

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.completedSteps, 1, 'the script must stop at the unmet expectation');
  assert.equal(client.sent.length, 1);
  assert.equal(run.failedSteps, 1);

  const failed = run.results[0];
  assert.equal(failed.success, false);
  assert.match(failed.error, /expected success=false, got true/);
  assert.match(failed.error, /expected result to contain "CS0122"/);
  assert.deepEqual(failed.expectations.unmet, [
    'expected success=false, got true',
    'expected result to contain "CS0122"',
  ]);
});

test('a thrown command satisfies an expectation of failure', async (t) => {
  const scriptPath = await writeTestScript(t, [
    {
      command: 'execute_code',
      params: { code: 'boom' },
      expect: { success: false, contains: ['Command timeout'] },
    },
    { command: 'ping', params: {} },
  ]);

  const client = stubClient([new Error('Command timeout after 10000ms'), { success: true }]);

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.completedSteps, 2);
  assert.equal(run.failedSteps, 0);
  assert.equal(run.results[0].success, true);
  assert.equal(run.results[0].commandError, 'Command timeout after 10000ms');
  assert.deepEqual(run.results[0].expectations.unmet, []);
});

test('contains is matched against the result as the tools print it', async (t) => {
  const scriptPath = await writeTestScript(t, [
    {
      command: 'execute_code',
      params: { code: 'throws' },
      expect: { success: false, contains: ['"line": 3', '"statement": "return o.ToString();"'] },
    },
  ]);

  const client = stubClient([
    {
      success: false,
      error: 'NullReferenceException',
      position: { line: 3, column: 1 },
      statement: 'return o.ToString();',
    },
  ]);

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.results[0].success, true, JSON.stringify(run.results[0].expectations));
});

test('a step without expect keeps the old pass/fail behaviour', async (t) => {
  const scriptPath = await writeTestScript(t, [
    { command: 'execute_code', params: { code: 'nope' } },
    { command: 'ping', params: {} },
  ]);

  const client = stubClient([{ success: false, error: 'error CS0122: inaccessible' }, { success: true }]);

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.completedSteps, 1);
  assert.equal(run.results[0].success, false);
  assert.equal(run.results[0].error, 'error CS0122: inaccessible');
  assert.equal(run.results[0].expectations, undefined);
});

test('test scripts reject a malformed expect', () => {
  const problems = validateTestScriptSteps([
    { command: 'ping', expect: { success: false, contains: ['a'], notContains: ['b'] } },
    { command: 'ping', expect: 'success' },
    { command: 'ping', expect: { success: 'false' } },
    { command: 'ping', expect: { contains: 'CS0122' } },
    { command: 'ping', expect: { notContains: [1] } },
    { command: 'ping', expect: { success: true, succes: true } },
  ]);

  assert.equal(problems.length, 5);
  assert.match(problems[0], /step 2: "expect" must be an object/);
  assert.match(problems[1], /step 3: "expect.success" must be a boolean/);
  assert.match(problems[2], /step 4: "expect.contains" must be an array of strings/);
  assert.match(problems[3], /step 5: "expect.notContains" must be an array of strings/);
  assert.match(problems[4], /step 6: unknown "expect" key "succes"/);
});

test('test scripts reject an expect that checks nothing', () => {
  const problems = validateTestScriptSteps([
    { command: 'ping', expect: {} },
    { command: 'ping', expect: { contains: [] } },
    { command: 'ping', expect: { success: true, notContains: [] } },
  ]);

  assert.equal(problems.length, 3);
  assert.match(problems[0], /step 1: "expect" must check at least one of success, contains, notContains/);
  assert.match(problems[1], /step 2: "expect.contains" must not be empty/);
  assert.match(problems[2], /step 3: "expect.notContains" must not be empty/);
});

test('the shipped test scripts are well formed', async () => {
  const { readFile } = await import('fs/promises');
  const listing = await listTestScripts();
  for (const entry of listing.scripts) {
    const script = JSON.parse(await readFile(entry.path, 'utf-8'));
    assert.deepEqual(validateTestScriptSteps(script.steps), [], `${entry.name} has unsupported steps`);
  }
});
