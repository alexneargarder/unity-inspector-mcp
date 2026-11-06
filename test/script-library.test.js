import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  buildScriptCatalog,
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

test('every shipped library script declares one argument per #args line, and the catalog names each', async () => {
  const { scripts } = await listCSharpScripts();
  for (const script of scripts) {
    for (const entry of script.args) {
      assert.match(entry, /^\w+: \S/, `${script.file}: "${entry}" names an argument and describes it`);
      assert.doesNotMatch(entry.slice(entry.indexOf(':') + 1), /,\s*\w+\s*:\s/, `${script.file}: "${entry}" carries a second argument`);
    }
  }
  const catalog = await buildScriptCatalog();
  assert.match(catalog, /- Menu Tweaker: .*\[args: elementName, type, Width, Height, FontSize, Text, Padding, Spacing, WidthMode, HeightMode, Visible\]/);
  assert.match(catalog, /- Rogueforce Runner: .*\[args: action\]/);
});

test('a shipped library script that keeps a GameObject across scene loads tags it Unpausable', async () => {
  const { scripts } = await listCSharpScripts();
  for (const script of scripts) {
    const source = await fs.readFile(script.path, 'utf-8');
    const kept = (source.match(/DontDestroyOnLoad\(/g) || []).length;
    const tagged = (source.match(/\.tag = "Unpausable";/g) || []).length;
    assert.ok(tagged >= kept, `${script.file} keeps ${kept} GameObject(s) across loads and tags ${tagged} Unpausable`);
  }
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
  'bros.json',
  'example-combat-test.json',
  'example-level-sequence.json',
  'example-movement-test.json',
  'execute-code-errors.json',
  'execute-code-shapes.json',
  'game-states.json',
  'input-sequence.json',
  'input.json',
  'inspection.json',
  'levels.json',
  'library-scripts.json',
  'param-types.json',
  'player-states.json',
  'scenario-bro-swap.json',
  'scenario-level-run-wedged.json',
  'scenario-level-run.json',
  'scenario-menus.json',
  'scenario-player-join.json',
  'script-constants.json',
  'scripts-lifecycle.json',
  'spawning.json',
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

  assert.equal(problems.length, 5);
  assert.match(problems[0], /step 2: "read_log"/);
  assert.match(problems[1], /step 3: "launch_game"/);
  assert.match(problems[2], /step 4: "execute_script" needs params\.path \(a library script\) or params\.source/);
  assert.match(problems[3], /step 5: "execute_script" with params\.source needs params\.name/);
  assert.match(problems[4], /step 6: missing "command"/);
});

test('a script step names a library script or inlines source, never both', () => {
  const problems = validateTestScriptSteps([
    { command: 'execute_script', params: { path: 'watch-field' } },
    { command: 'execute_script', params: { path: 'watch-field.cs', compileOnly: true } },
    { command: 'execute_script', params: { path: 'watch-field', source: 'class X {}' } },
    { command: 'execute_script', params: { compileOnly: true } },
    { command: 'execute_script', params: { path: 'watch-field', source: 'class X {}', compileOnly: true } },
  ]);

  assert.equal(problems.length, 3);
  assert.match(problems[0], /step 3: "execute_script" takes params\.path or params\.source, not both/);
  assert.match(problems[1], /step 4: "execute_script" needs params\.path/);
  assert.match(problems[2], /step 5: "execute_script" takes params\.path or params\.source, not both/);
});

test('a step gets the same refusals as the tool', () => {
  const problems = validateTestScriptSteps([
    { command: 'swap_bro', params: { broName: 'Rambro', nextSpawn: true } },
    { command: 'swap_bro', params: { broName: 'Rambro', nextSpawn: true, ignoreUnlocks: true } },
    { command: 'execute_script', params: { path: 'watch-field', compileOnly: true, args: { a: 1 } } },
  ], { label: 'cleanup step' });

  assert.equal(problems.length, 2);
  assert.match(problems[0], /cleanup step 2: .*nextSpawn cannot take ignoreUnlocks/);
  assert.match(problems[1], /cleanup step 3: .*compileOnly cannot take args/);
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
  ], { label: 'cleanup step' });

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
    assert.deepEqual(validateTestScriptSteps(script.cleanup || [], { label: 'cleanup step' }), [], `${name} has unsupported cleanup steps`);
  }
});

test('every shipped test script prepares with its declared defaults, library paths included', async () => {
  for (const name of SHIPPED_TEST_SCRIPTS) {
    await assert.doesNotReject(prepareTestScript(name, {}, { toolArguments: toolArguments() }), `${name} does not prepare`);
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

import { CSHARP_SCRIPTS_DIR, NODE_ONLY_TOOLS, listCSharpScripts } from '../lib/script-library.js';
import { toolArguments } from '../index.js';

async function scratchDir(t, files = {}) {
  const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const dir = await mkdtemp(path.join(tmpdir(), 'script-library-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    if (content === null) await mkdir(path.join(dir, name));
    else await writeFile(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

const header = (name, description = 'Does a thing') => `// #name ${name}\n// #description ${description}\nclass X {}\n`;

test('readScriptSource takes a library name with its .cs as well as without', async () => {
  const script = await readScriptSource('watch-field.cs');
  assert.equal(script.name, 'watch-field');
  assert.match(script.source, /WatchField/);
});

test('readScriptSource reads an absolute path as given, named after its file', async (t) => {
  const dir = await scratchDir(t, { 'scratch-probe.cs': 'class Probe {}\n' });
  const script = await readScriptSource(path.join(dir, 'scratch-probe.cs'));
  assert.deepEqual(script, { source: 'class Probe {}\n', name: 'scratch-probe', origin: path.join(dir, 'scratch-probe.cs') });

  await assert.rejects(readScriptSource(path.join(dir, 'gone.cs')), (err) => {
    assert.equal(err.code, 'ENOENT');
    assert.match(err.message, /gone\.cs/);
    return true;
  });
});

test('a catalog display name resolves to the file carrying it, in any case', async (t) => {
  const dir = await scratchDir(t, { 'spawn-capture.cs': header('Spawn Capture'), 'other.cs': header('Other Thing') });

  for (const asked of ['Spawn Capture', 'spawn capture', 'SPAWN CAPTURE']) {
    const script = await readScriptSource(asked, { dir });
    assert.equal(script.name, 'spawn-capture', asked);
    assert.match(script.source, /#name Spawn Capture/);
  }

  const shipped = await readScriptSource('Spawn Capture');
  assert.equal(shipped.name, 'spawn-capture', 'the shipped library resolves its own catalog names');
});

test('a display name several scripts carry is refused, naming each of them', async (t) => {
  const dir = await scratchDir(t, { 'first.cs': header('Twin'), 'second.cs': header('Twin'), 'third.cs': header('Single') });
  await assert.rejects(readScriptSource('twin', { dir }), (err) => {
    assert.match(err.message, /Several library scripts are named "twin"/);
    assert.match(err.message, /first\.cs \("Twin"\)/);
    assert.match(err.message, /second\.cs \("Twin"\)/);
    assert.doesNotMatch(err.message, /third\.cs/);
    return true;
  });
});

test('a name matching neither a file nor a catalog name says where it looked and what is closest', async (t) => {
  const dir = await scratchDir(t, {
    'spawn-capture.cs': header('Spawn Capture'),
    'watch-field.cs': header('Watch Field'),
    'dump-harmony-patches.cs': header('Dump Harmony Patches'),
    'menu-tweaker.cs': header('Menu Tweaker'),
  });
  await assert.rejects(readScriptSource('Spawn Captur', { dir }), (err) => {
    assert.match(err.message, /Script not found: "Spawn Captur"/);
    assert.ok(err.message.includes(path.join(dir, 'Spawn Captur.cs')), err.message);
    assert.match(err.message, /Closest: spawn-capture\.cs \("Spawn Capture"\)/, 'the nearest name comes first');
    assert.equal(err.message.match(/\.cs \("/g).length, 3, 'three suggestions');
    return true;
  });

  await assert.rejects(readScriptSource('no-such-script'), /Script not found: "no-such-script"/);
});

test('a display name never lifts the path rules', async (t) => {
  const dir = await scratchDir(t, { 'escape.cs': header('../outside') });
  await assert.rejects(readScriptSource('../outside', { dir }), /escapes the script library/);
});

test('list_scripts reports each script with its metadata, and a file name for one without', async (t) => {
  const dir = await scratchDir(t, {
    'full.cs': '// #name Full Script\n// #description Every header\n// #tags a, b\n// #args target: what to watch\n// #args count: how many\nclass F {}\n',
    'bare.cs': 'class Bare {}\n',
    'notes.txt': 'not a script',
  });
  const listing = await listCSharpScripts(dir);
  assert.equal(listing.count, 2);
  assert.equal(listing.scriptsDirectory, dir);

  const byFile = Object.fromEntries(listing.scripts.map((s) => [s.file, s]));
  assert.deepEqual(byFile['full.cs'], {
    file: 'full.cs',
    name: 'Full Script',
    description: 'Every header',
    tags: 'a, b',
    args: ['target: what to watch', 'count: how many'],
    path: path.join(dir, 'full.cs'),
  });
  assert.deepEqual(byFile['bare.cs'], {
    file: 'bare.cs',
    name: 'bare',
    description: 'No description',
    tags: '',
    args: [],
    path: path.join(dir, 'bare.cs'),
  });

  const shipped = await listCSharpScripts();
  assert.equal(shipped.scriptsDirectory, CSHARP_SCRIPTS_DIR);
  assert.ok(shipped.scripts.some((s) => s.file === 'spawn-capture.cs' && s.name === 'Spawn Capture'));
});

test('list_scripts lists a script it cannot read under errors and reports a directory it cannot open', async (t) => {
  const dir = await scratchDir(t, { 'good.cs': header('Good'), 'broken.cs': null, 'plain-file': 'x' });
  const listing = await listCSharpScripts(dir);
  assert.deepEqual(listing.scripts.map((s) => s.file), ['good.cs'], 'a .cs that cannot be read is skipped');
  assert.equal(listing.errors.length, 1);
  assert.match(listing.errors[0], /^broken\.cs: /);

  const unusable = await listCSharpScripts(path.join(dir, 'plain-file', 'csharp'));
  assert.equal(unusable.count, 0);
  assert.deepEqual(unusable.scripts, []);
  assert.match(unusable.error, /ENOTDIR|EEXIST/);
});

test('list_test_scripts lists a file that is not JSON under errors and reports a directory it cannot read', async (t) => {
  const dir = await scratchDir(t, {
    'good.json': JSON.stringify({ name: 'Good', steps: [{ command: 'ping' }] }),
    'broken.json': '{ not json',
    'plain-file': 'x',
  });
  const listing = await listTestScripts(dir);
  assert.deepEqual(listing.scripts.map((s) => s.name), ['good.json']);
  assert.equal(listing.scripts[0].steps, 1);
  assert.equal(listing.errors.length, 1);
  assert.match(listing.errors[0], /^broken\.json: /);

  const missing = await listTestScripts(path.join(dir, 'absent'));
  assert.deepEqual(missing.scripts, []);
  assert.equal(missing.errors, undefined, 'a missing directory is an empty list, not an error');

  const unreadable = await listTestScripts(path.join(dir, 'plain-file'));
  assert.deepEqual(unreadable.scripts, []);
  assert.equal(unreadable.errors.length, 1);
  assert.match(unreadable.errors[0], /ENOTDIR/);
});

test('run_test_script answers an unknown or malformed script with an error, sending nothing', async (t) => {
  const client = stubClient([]);

  const missing = await runTestScript('no-such-script', client);
  assert.match(missing.error, /Test script not found/);
  assert.equal(missing.scriptPath, 'no-such-script');

  const dir = await scratchDir(t, {
    'not-json.json': '{ steps: ',
    'no-steps.json': JSON.stringify({ name: 'No steps' }),
  });
  assert.match((await runTestScript(path.join(dir, 'not-json.json'), client)).error, /JSON/);
  assert.match((await runTestScript(path.join(dir, 'no-steps.json'), client)).error, /must have a "steps" array/);
  assert.equal(client.sent.length, 0);
});

test('test scripts refuse every server-side tool as a step', () => {
  const problems = validateTestScriptSteps([...NODE_ONLY_TOOLS].map((command) => ({ command })));
  assert.equal(problems.length, NODE_ONLY_TOOLS.size);
  [...NODE_ONLY_TOOLS].forEach((command, i) => {
    assert.match(problems[i], new RegExp(`step ${i + 1}: "${command}" is implemented by the MCP server`));
  });
});

test('a step whose command throws without an expect fails and stops the script', async (t) => {
  const scriptPath = await writeTestScript(t, [
    { command: 'ping' },
    { command: 'ping' },
  ]);
  const client = stubClient([new Error('Connection closed — game likely crashed'), { success: true }]);

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.completedSteps, 1);
  assert.equal(client.sent.length, 1);
  assert.equal(run.results[0].success, false);
  assert.equal(run.results[0].error, 'Connection closed — game likely crashed');
  assert.equal(run.results[0].result, undefined);
});

test('a step waits its wait before the next, and a step with no params sends {}', async (t) => {
  const scriptPath = await writeTestScript(t, [
    { command: 'ping', wait: 300 },
    { command: 'inspect_player' },
  ]);
  const client = stubClient([{ success: true }, { success: true }]);
  const stamps = [];
  const send = client.sendCommand.bind(client);
  client.sendCommand = async (command, params) => {
    stamps.push(Date.now());
    return send(command, params);
  };

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.successfulSteps, 2);
  assert.ok(stamps[1] - stamps[0] >= 290, `the second step came ${stamps[1] - stamps[0]}ms after the first`);
  assert.deepEqual(client.sent.map((s) => s.params), [{}, {}]);
});

test('a take_screenshot step reports the path as this machine sees it', async (t) => {
  const scriptPath = await writeTestScript(t, [{ command: 'take_screenshot', params: {} }]);
  const client = stubClient([{ path: 'Z:/tmp/shot.png' }]);
  client.translateScreenshotPath = (p) => p.replace(/^Z:/, '');

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.results[0].result.path, '/tmp/shot.png');
});

test('a step whose params carry a key its tool does not declare is refused', () => {
  const problems = validateTestScriptSteps([
    { command: 'set_player_health', params: { health: 1, player: 1 } },
    { command: 'execute_script', params: { source: 'class X {}', name: 'x', args: { a: '1' } } },
    { command: 'execute_script', params: { source: 'class X {}', name: 'x', compileOnly: true, compile: true } },
    { command: 'ping', params: { verbose: true } },
    { command: 'some_mod_method', params: { anything: 1 } },
    { command: 'read_log', params: { lines: 5, bogus: 1 } },
    { command: 'set_player_health', params: { health: 1, playerNum: 1 } },
  ], { toolArguments: toolArguments() });

  assert.deepEqual(problems, [
    'step 1: set_player_health has no argument "player"; its arguments are health, playerNum',
    'step 3: execute_script has no argument "compile"; its arguments are path, args, compileOnly, source, name, origin',
    'step 4: ping has no argument "verbose"; it takes no arguments',
    problems[3],
    'step 6: "read_log" is implemented by the MCP server, not the game',
  ]);
  assert.match(problems[3], /^step 5: "some_mod_method" is not a tool; the game-side tools are ping, /);
  assert.doesNotMatch(problems[3], /read_log|run_test_script/);
});

test('a step\'s params are checked against its tool\'s types, a null passing as absent', () => {
  const problems = validateTestScriptSteps([
    { command: 'swap_bro', params: { broName: 'Rambro', nextSpawn: 'false' } },
    { command: 'go_to_level', params: { campaignIndex: 1.5, levelIndex: 0 } },
    { command: 'execute_script', params: { source: 5, name: 'x' } },
    { command: 'teleport_player', params: { x: 1, y: 2, z: null } },
    { command: 'simulate_input', params: { sequence: [{ action: 'jump', wait: 'soon' }] } },
  ], { toolArguments: toolArguments() });

  assert.deepEqual(problems, [
    'step 1: swap_bro: nextSpawn must be a boolean, got "false"',
    'step 2: go_to_level: campaignIndex must be an integer, got 1.5',
    'step 3: execute_script: source must be a string, got 5',
    'step 5: simulate_input: sequence[0].wait must be an integer, got "soon"',
  ]);

  assert.deepEqual(validateTestScriptSteps([{ command: 'list_bros', params: { playerNum: '1' } }], {
    label: 'cleanup step',
    toolArguments: toolArguments(),
  }), ['cleanup step 1: list_bros: playerNum must be an integer, got "1"']);
});

test('run_test_script refuses a stray step key before it sends anything', async (t) => {
  const scriptPath = await writeTestScript(t, [
    { command: 'ping' },
    { command: 'query_gameobjects', params: { name: 'Mook' } },
  ]);
  const client = stubClient([{ success: true }, { success: true }]);

  const run = await runTestScript(scriptPath, client, { toolArguments: toolArguments() });
  assert.match(run.error, /step 2: query_gameobjects has no argument "name"; its arguments are namePattern/);
  assert.equal(client.sent.length, 0);
});

test('the shipped test scripts only use the arguments their tools declare, cleanup steps included', async () => {
  const listing = await listTestScripts();
  for (const entry of listing.scripts) {
    await assert.doesNotReject(prepareTestScript(entry.path, {}, { toolArguments: toolArguments() }), `${entry.name} has undeclared keys`);
  }
});

test('a step may carry every key the engine reads beside params its tool declares', () => {
  const steps = [
    { command: 'execute_script', params: { path: 'watch-field', args: {} }, wait: 10, report: true },
    { command: 'execute_script', params: { path: 'watch-field', origin: '/elsewhere/watch-field.cs' } },
    { command: 'execute_script', params: { path: 'watch-field.cs', compileOnly: true } },
    { command: 'execute_code', params: { code: 'return 1;' }, expect: { success: true }, until: { timeout: 5, interval: 0.5 } },
  ];
  assert.deepEqual(validateTestScriptSteps(steps, { toolArguments: toolArguments() }), []);
  assert.deepEqual(validateTestScriptSteps(steps, { label: 'cleanup step', toolArguments: toolArguments() }), []);
});

async function writeScriptFile(t, script) {
  const { mkdtemp, writeFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const dir = await mkdtemp(path.join(tmpdir(), 'test-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'script.json');
  await writeFile(scriptPath, JSON.stringify(script), 'utf-8');
  return scriptPath;
}

test('a script using args, until, report, cleanup and continueOnFailure prepares against the tools\' schemas', async (t) => {
  const scriptPath = await writeScriptFile(t, {
    args: { hp: { default: 3, description: 'health' } },
    continueOnFailure: true,
    steps: [
      { command: 'execute_script', params: { path: 'Watch Field' } },
      { command: 'set_player_health', params: { health: '{{hp}}', playerNum: 0 }, expect: { success: true }, until: { timeout: 2 } },
      { command: 'execute_code', params: { code: 'return "{}";' }, report: true },
    ],
    cleanup: [{ command: 'set_player_health', params: { health: '{{hp}}', playerNum: 0 } }],
  });
  await assert.doesNotReject(prepareTestScript(scriptPath, {}, { toolArguments: toolArguments() }));
});

test('a misspelled params key is refused in steps and cleanup steps alike, placeholders filled first', async (t) => {
  const scriptPath = await writeScriptFile(t, {
    args: { hp: { default: 3 } },
    steps: [
      { command: 'execute_script', params: { pth: 'watch-field' } },
      { command: 'set_player_health', params: { health: '{{hp}}', playerNum: 0 }, expect: { success: true }, until: { timeout: 2 } },
    ],
    cleanup: [{ command: 'set_player_health', params: { helth: '{{hp}}', playerNum: 0 } }],
  });
  await assert.rejects(prepareTestScript(scriptPath, {}, { toolArguments: toolArguments() }), (err) => {
    assert.match(err.message, /step 1: execute_script has no argument "pth"; its arguments are path, args, compileOnly, source, name, origin/);
    assert.match(err.message, /cleanup step 1: set_player_health has no argument "helth"; its arguments are health, playerNum/);
    assert.doesNotMatch(err.message, /step 2:/);
    return true;
  });
});

test('a misspelled step key is refused, in steps and cleanup steps alike', () => {
  const steps = [
    { command: 'ping', untl: { timeout: 1 }, expect: { success: true } },
    { command: 'ping', reprot: true },
    { command: 'ping', expct: { success: false } },
    { command: 'ping', waits: 10 },
    { command: 'ping', param: {} },
  ];
  const allowed = '(allowed: command, params, wait, expect, until, report)';
  const expected = (label) => ['untl', 'reprot', 'expct', 'waits', 'param']
    .map((key, i) => `${label} ${i + 1}: unknown step key "${key}" ${allowed}`);

  assert.deepEqual(validateTestScriptSteps(steps), expected('step'));
  assert.deepEqual(validateTestScriptSteps(steps, { label: 'cleanup step' }), expected('cleanup step'));
});

test('a misspelled script key is refused before anything is sent', async (t) => {
  const scriptPath = await writeScriptFile(t, {
    name: 'Misspelled',
    continueOnFailur: true,
    cleanp: [{ command: 'ping' }],
    steps: [{ command: 'ping' }],
  });
  const client = stubClient([{ success: true }]);

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.passed, false);
  assert.match(run.error, /unknown script key "continueOnFailur" \(allowed: name, description, args, steps, cleanup, continueOnFailure\)/);
  assert.match(run.error, /unknown script key "cleanp"/);
  assert.equal(client.sent.length, 0);
});

test('an execute_script step sends its origin: the one it names, else the file its path read, and a compileOnly step none', async (t) => {
  const { CSHARP_SCRIPTS_DIR } = await import('../lib/script-library.js');
  const scriptPath = await writeTestScript(t, [
    { command: 'execute_script', params: { path: 'Watch Field' } },
    { command: 'execute_script', params: { path: 'watch-field', compileOnly: true } },
    { command: 'execute_script', params: { source: 'class X {}', name: 'x', origin: '/elsewhere/x.cs' } },
  ]);
  const client = stubClient([{ success: true }, { success: true }, { success: true }]);

  const run = await runTestScript(scriptPath, client, { toolArguments: toolArguments() });
  assert.equal(run.passed, true, JSON.stringify(run));
  assert.equal(client.sent[0].params.origin, path.join(CSHARP_SCRIPTS_DIR, 'watch-field.cs'));
  assert.equal(client.sent[1].command, 'compile_script');
  assert.equal('origin' in client.sent[1].params, false);
  assert.equal(client.sent[2].params.origin, '/elsewhere/x.cs');
});

test('readScriptSource sends one origin and name for a file reached through a symlinked directory', async (t) => {
  const dir = await scratchDir(t, { real: null });
  await fs.writeFile(path.join(dir, 'real', 'Probe.cs'), 'public static class Probe {}', 'utf-8');
  await fs.symlink(path.join(dir, 'real'), path.join(dir, 'link'));

  const direct = await readScriptSource(path.join(dir, 'real', 'Probe.cs'));
  const linked = await readScriptSource(path.join(dir, 'link', 'Probe.cs'));
  assert.equal(linked.origin, direct.origin);
  assert.equal(direct.origin, await fs.realpath(path.join(dir, 'real', 'Probe.cs')));
  assert.equal(linked.name, 'Probe');
});

test('readScriptSource words a missing file by how it took the path', async () => {
  const missing = path.join(os.tmpdir(), 'no-such-dir-for-unity-inspector', 'probe.cs');
  await assert.rejects(readScriptSource(missing), (err) => {
    assert.equal(err.code, 'ENOENT');
    assert.equal(err.message, `Script not found: ${missing}, taken as an absolute path: no file exists there.`);
    return true;
  });
  await assert.rejects(readScriptSource('no-such-library-script'), /"no-such-library-script", taken as a library name, is neither/);
});

test('a step wait that is not a usable number of milliseconds is refused', () => {
  const problems = validateTestScriptSteps([
    { command: 'ping', wait: '2s' },
    { command: 'ping', wait: 3e9 },
    { command: 'ping', wait: -1 },
    { command: 'ping', wait: Number.NaN },
    { command: 'ping', wait: 0 },
    { command: 'ping', wait: 1500 },
  ]);
  assert.deepEqual(problems.map((problem) => problem.split(':')[0]), ['step 1', 'step 2', 'step 3', 'step 4']);
  assert.match(problems[0], /"wait" must be a number of milliseconds from 0 to 2147483647/);
});

test('a cancelled run stops between steps, runs its cleanup and says it was cancelled', async (t) => {
  const dir = await scratchDir(t, {
    'cancel.json': JSON.stringify({
      name: 'Cancel',
      steps: [{ command: 'ping' }, { command: 'game_state' }, { command: 'list_bros' }],
      cleanup: [{ command: 'list_campaigns' }],
    }),
  });
  const controller = new AbortController();
  const client = stubClient([{ success: true }, { success: true }, { success: true }]);
  const sendCommand = client.sendCommand;
  client.sendCommand = async (command, params) => {
    const reply = await sendCommand(command, params);
    if (command === 'ping') controller.abort();
    return reply;
  };

  const run = await runTestScript(path.join(dir, 'cancel.json'), client, {
    signal: controller.signal,
    isRunning: async () => true,
  });
  assert.deepEqual(client.sent.map((s) => s.command), ['ping', 'list_campaigns']);
  assert.equal(run.passed, false);
  assert.equal(run.cancelled, 'the run was cancelled after 1 of 3 steps');
  assert.equal(run.cleanup.length, 1);

  const uncancelled = await runTestScript(path.join(dir, 'cancel.json'), stubClient([{}, {}, {}, {}]), {
    isRunning: async () => true,
  });
  assert.equal(uncancelled.cancelled, undefined);
  assert.equal(uncancelled.passed, true);
});

test('a cancel during an until sleep sends no further attempt, and cleanup polls unsignalled', async (t) => {
  const dir = await scratchDir(t, {
    'cancel-until.json': JSON.stringify({
      name: 'Cancel until',
      steps: [{ command: 'ping', until: { timeout: 10, interval: 1 }, expect: { contains: ['ready'] } }],
      cleanup: [{ command: 'game_state', until: { timeout: 10, interval: 1 }, expect: { contains: ['clean'] } }],
    }),
  });
  const controller = new AbortController();
  const replies = { ping: [{ state: 'busy' }, { state: 'ready' }], game_state: [{ state: 'dirty' }, { state: 'clean' }] };
  const sent = [];
  const client = {
    translateScreenshotPath: (p) => p,
    async sendCommand(command) {
      sent.push(command);
      return replies[command].shift();
    },
  };
  let clock = 0;
  const run = await runTestScript(path.join(dir, 'cancel-until.json'), client, {
    signal: controller.signal,
    isRunning: async () => true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (sent.length === 1) controller.abort();
    },
  });

  assert.deepEqual(sent, ['ping', 'game_state', 'game_state'], 'no ping after the cancel; cleanup polls until clean');
  assert.equal(run.results[0].attempts, 1);
  assert.equal(run.cleanup[0].success, true);
  assert.equal(run.cleanup[0].attempts, 2);
  assert.match(run.cancelled, /cancelled after 1 of 1 steps/);
});

test('a step whose command the cancel cut short never passes, an expected failure included', async (t) => {
  const { cancelledError } = await import('../lib/unity-client.js');
  const dir = await scratchDir(t, {
    'cancel-expect.json': JSON.stringify({
      name: 'Cancel expect',
      steps: [{ command: 'ping', expect: { success: false } }, { command: 'game_state' }],
      cleanup: [{ command: 'list_campaigns' }],
    }),
  });
  const controller = new AbortController();
  const sent = [];
  const client = {
    translateScreenshotPath: (p) => p,
    async sendCommand(command) {
      sent.push(command);
      if (command === 'ping') {
        controller.abort();
        throw cancelledError('ping');
      }
      return {};
    },
  };

  const run = await runTestScript(path.join(dir, 'cancel-expect.json'), client, {
    signal: controller.signal,
    isRunning: async () => true,
  });
  assert.equal(run.results[0].success, false, 'the cancelled step met its expect only by being cut short');
  assert.equal(run.results[0].cancelled, true);
  assert.match(run.results[0].error, /cancelled before the step's command answered/);
  assert.equal(run.successfulSteps, 0);
  assert.equal(run.passed, false);
  assert.equal(run.cancelled, 'the run was cancelled during step 1 of 2, before its command answered');
  assert.deepEqual(sent, ['ping', 'list_campaigns'], 'no later step; the cleanup still ran');
  assert.equal(run.cleanup[0].success, true);
});

test('a continueOnFailure script stops at a cancel, neither waiting its wait nor sending the next step', async (t) => {
  const dir = await scratchDir(t, {
    'cancel-continue.json': JSON.stringify({
      name: 'Cancel continue',
      continueOnFailure: true,
      steps: [
        { command: 'ping', expect: { success: true }, wait: 5000 },
        { command: 'game_state' },
      ],
      cleanup: [{ command: 'list_campaigns' }],
    }),
  });
  const controller = new AbortController();
  const sent = [];
  const sleeps = [];
  const client = {
    translateScreenshotPath: (p) => p,
    async sendCommand(command) {
      sent.push(command);
      if (command === 'ping') {
        controller.abort();
        return { success: false, error: 'busy' };
      }
      return {};
    },
  };

  const run = await runTestScript(path.join(dir, 'cancel-continue.json'), client, {
    signal: controller.signal,
    isRunning: async () => true,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sent, ['ping', 'list_campaigns'], 'no later step; the cleanup still ran');
  assert.deepEqual(sleeps, [], 'the step\'s wait was not slept after the cancel');
  assert.equal(run.passed, false);
  assert.equal(run.cancelled, 'the run was cancelled after 1 of 2 steps');
  assert.deepEqual(run.failures.map((f) => f.step), [1]);
  assert.equal(run.cleanup[0].success, true);
});

test('a cancel wakes an until step from its sleep between attempts', { timeout: 20000 }, async (t) => {
  const dir = await scratchDir(t, {
    'cancel-until-sleep.json': JSON.stringify({
      name: 'Cancel until sleep',
      steps: [{ command: 'ping', until: { timeout: 60, interval: 30 }, expect: { contains: ['ready'] } }],
    }),
  });
  const controller = new AbortController();
  const sent = [];
  const client = {
    translateScreenshotPath: (p) => p,
    async sendCommand(command) {
      sent.push(command);
      setTimeout(() => controller.abort(), 50);
      return { state: 'busy' };
    },
  };

  const started = Date.now();
  const run = await runTestScript(path.join(dir, 'cancel-until-sleep.json'), client, {
    signal: controller.signal,
    isRunning: async () => true,
  });
  assert.ok(Date.now() - started < 5000, `the run slept ${Date.now() - started}ms of a 30s interval`);
  assert.deepEqual(sent, ['ping']);
  assert.equal(run.results[0].attempts, 1);
  assert.equal(run.passed, false);
});
