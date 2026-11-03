import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import {
  parseScriptMetadata,
  readScriptSource,
  listTestScripts,
  prepareTestScript,
  resolveTestScriptPath,
  runTestScript,
  validateTestScriptSteps,
  TEST_SCRIPTS_DIR,
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

const SHIPPED_TEST_SCRIPTS = [
  'example-combat-test.json',
  'example-level-sequence.json',
  'example-movement-test.json',
  'execute-code-errors.json',
  'input-sequence.json',
  'scenario-bro-swap.json',
  'scenario-level-run.json',
  'scenario-menus.json',
  'scenario-player-join.json',
];

test('list_test_scripts finds every script shipped in scripts/tests', async () => {
  const listing = await listTestScripts();
  const names = listing.scripts.map((s) => s.name).sort();

  assert.deepEqual(names, SHIPPED_TEST_SCRIPTS);
  assert.equal(listing.count, SHIPPED_TEST_SCRIPTS.length);
  assert.equal(listing.scriptsDirectory, TEST_SCRIPTS_DIR);
});

test('run_test_script resolves a shipped script by name', async () => {
  const resolved = await resolveTestScriptPath('example-combat-test');
  assert.equal(resolved, path.join(TEST_SCRIPTS_DIR, 'example-combat-test.json'));

  const withExtension = await resolveTestScriptPath('example-movement-test.json');
  assert.equal(withExtension, path.join(TEST_SCRIPTS_DIR, 'example-movement-test.json'));

  const relative = await resolveTestScriptPath('./input-sequence.json');
  assert.equal(relative, path.join(TEST_SCRIPTS_DIR, 'input-sequence.json'));

  const absolute = path.join(TEST_SCRIPTS_DIR, 'execute-code-errors.json');
  assert.equal(await resolveTestScriptPath(absolute), absolute);

  await assert.rejects(resolveTestScriptPath('no-such-script'), /Test script not found/);
});

test('run_test_script refuses a relative name that escapes scripts/tests', async () => {
  await assert.rejects(
    resolveTestScriptPath('../csharp/watch-field.json'),
    /escapes the script library/
  );
});

test('test scripts reject steps that only the MCP server can run', () => {
  const problems = validateTestScriptSteps([
    { command: 'ping' },
    { command: 'read_log' },
    { command: 'launch_game' },
    { command: 'execute_script', params: { args: {} } },
    { command: 'execute_script', params: { source: 'class X {}' } },
    {},
  ]);

  assert.equal(problems.length, 4);
  assert.match(problems[0], /step 2: "read_log"/);
  assert.match(problems[1], /step 3: "launch_game"/);
  assert.match(problems[2], /step 4: "execute_script" needs params\.path \(a library script\) or params\.source/);
  assert.match(problems[3], /step 6: missing "command"/);
});

test('a script step names a library script or inlines source, never both', () => {
  const problems = validateTestScriptSteps([
    { command: 'execute_script', params: { path: 'watch-field' } },
    { command: 'compile_script', params: { path: 'watch-field.cs' } },
    { command: 'execute_script', params: { path: 'watch-field', source: 'class X {}' } },
    { command: 'compile_script', params: {} },
  ]);

  assert.equal(problems.length, 2);
  assert.match(problems[0], /step 3: "execute_script" takes params\.path or params\.source, not both/);
  assert.match(problems[1], /step 4: "compile_script" needs params\.path/);
});

test('until needs an expect and a timeout in seconds; report is a boolean', () => {
  const problems = validateTestScriptSteps([
    { command: 'ping', until: { timeout: 5 }, expect: { success: true } },
    { command: 'ping', until: { timeout: 5, interval: 0.5 }, expect: { contains: ['x'] }, report: true },
    { command: 'ping', until: { timeout: 5 } },
    { command: 'ping', until: { interval: 1 }, expect: { success: true } },
    { command: 'ping', until: { timeout: -1, interval: 0 }, expect: { success: true } },
    { command: 'ping', until: { timeoutMs: 5000, timeout: 5 }, expect: { success: true } },
    { command: 'ping', until: 30, expect: { success: true } },
    { command: 'ping', report: 'yes' },
  ], 'cleanup step');

  assert.deepEqual(problems, [
    'cleanup step 3: "until" needs an "expect" to poll for',
    'cleanup step 4: "until.timeout" must be a number of seconds, 0 or more',
    'cleanup step 5: "until.timeout" must be a number of seconds, 0 or more',
    'cleanup step 5: "until.interval" must be a positive number of seconds',
    'cleanup step 6: unknown "until" key "timeoutMs" (allowed: timeout, interval)',
    'cleanup step 7: "until" must be an object',
    'cleanup step 8: "report" must be a boolean',
  ]);
});

test('readScriptSource resolves a catalog display name to its file', async () => {
  const byDisplay = await readScriptSource('Watch Field');
  const byName = await readScriptSource('watch-field');
  assert.equal(byDisplay.name, 'watch-field');
  assert.equal(byDisplay.source, byName.source);
  await assert.rejects(readScriptSource('No Such Display Name'), { code: 'ENOENT' });
});

test('prepareTestScript checks the declared args and the cleanup array', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const dir = await mkdtemp(path.join(tmpdir(), 'test-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const declared = path.join(dir, 'declared.json');
  await writeFile(declared, JSON.stringify({
    args: { level: 3, bro: { default: 'Rambro', hint: 'x' }, speed: { description: 2 } },
    steps: [{ command: 'ping' }],
  }));
  await assert.rejects(prepareTestScript(declared), (err) => {
    assert.match(err.message, /args\.level: must be an object with "default" and\/or "description"/);
    assert.match(err.message, /args\.bro: unknown key "hint"/);
    assert.match(err.message, /args\.speed: "description" must be a string/);
    return true;
  });

  const badCleanup = path.join(dir, 'cleanup.json');
  await writeFile(badCleanup, JSON.stringify({ steps: [], cleanup: { command: 'ping' } }));
  await assert.rejects(prepareTestScript(badCleanup), /"cleanup" must be an array of steps/);

  const nodeOnlyCleanup = path.join(dir, 'node-only.json');
  await writeFile(nodeOnlyCleanup, JSON.stringify({ steps: [], cleanup: [{ command: 'stop_game' }] }));
  await assert.rejects(prepareTestScript(nodeOnlyCleanup), /cleanup step 1: "stop_game" is implemented by the MCP server/);
});

test('list_test_scripts shows the args a script declares', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const dir = await mkdtemp(path.join(tmpdir(), 'test-scripts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const args = { level: { default: 0, description: 'level index' } };
  await writeFile(path.join(dir, 'with-args.json'), JSON.stringify({ name: 'With', args, steps: [] }));
  await writeFile(path.join(dir, 'without.json'), JSON.stringify({ name: 'Without', steps: [] }));

  const listing = await listTestScripts(dir);
  const byName = Object.fromEntries(listing.scripts.map((s) => [s.name, s]));
  assert.deepEqual(byName['with-args.json'].args, args);
  assert.equal(byName['without.json'].args, undefined);
});

test('the shipped test scripts only use game-side commands', async () => {
  const { readFile } = await import('fs/promises');
  for (const name of SHIPPED_TEST_SCRIPTS) {
    const script = JSON.parse(await readFile(path.join(TEST_SCRIPTS_DIR, name), 'utf-8'));
    assert.deepEqual(validateTestScriptSteps(script.steps), [], `${name} has unsupported steps`);
    assert.deepEqual(validateTestScriptSteps(script.cleanup || [], 'cleanup step'), [], `${name} has unsupported cleanup steps`);
  }
});

test('every shipped test script prepares with its declared defaults, library paths included', async () => {
  for (const name of SHIPPED_TEST_SCRIPTS) {
    await assert.doesNotReject(prepareTestScript(name), `${name} does not prepare`);
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
    await prepareTestScript(entry.path);
  }
});
