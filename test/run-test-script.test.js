import { TEST_RESULTS_SCRATCH } from './support/session.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile, readdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { startStubServer, reply } from './support/stub-server.js';
import { fakeProcReader } from './support/fake-proc.js';

let answer = (request, socket) => reply(socket, request.id, { success: true });
const requests = [];
const stub = await startStubServer((request, socket) => {
  requests.push(request);
  answer(request, socket);
});

process.env.UNITY_INSPECTOR_PORT = String(stub.port);

const { handleToolCall, targetLogPaths } = await import('../index.js');
const { UnityInspectorClient } = await import('../lib/unity-client.js');
const {
  runTestScript, compactTestScriptReply, testResultsDir, resultsSession, RESULTS_SESSION_IDLE_MS, CSHARP_SCRIPTS_DIR, UMM_FLUSH_WAIT_MS,
  STEP_PREVIEW_MAX_CHARS, TEST_REPLY_MAX_CHARS, TEST_RESULTS_KEEP, REPORT_FIELD_MAX_CHARS,
} = await import('../lib/script-library.js');

const { setProcReader } = await import('../lib/game-process.js');

setProcReader(fakeProcReader({}));

const client = new UnityInspectorClient({ host: '127.0.0.1', port: stub.port, connectTimeoutMs: 2000 });
after(async () => {
  setProcReader(null);
  client.disconnect();
  await stub.close();
});

function fail(socket, id, error) {
  socket.write(JSON.stringify({ id, success: false, error }) + '\n');
}

function fakeClock() {
  const clock = { time: 1000, sleeps: [] };
  clock.now = () => clock.time;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.time += ms;
  };
  return clock;
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'run-test-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeScript(t, script) {
  const dir = await tempDir(t);
  const scriptPath = path.join(dir, 'script.json');
  await writeFile(scriptPath, JSON.stringify({ name: 'Run', ...script }), 'utf-8');
  return scriptPath;
}

function startRecording() {
  requests.length = 0;
}

const sent = (method) => requests.filter((r) => r.method === method);

test('a library script step sends the file\'s source, by bare name, .cs name and catalog display name', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true });
  const scriptPath = await writeScript(t, {
    steps: [
      { command: 'execute_script', params: { path: 'watch-field', args: { field: 'health' } } },
      { command: 'execute_script', params: { path: 'watch-field.cs', compileOnly: true } },
      { command: 'execute_script', params: { path: 'Watch Field' } },
      { command: 'execute_script', params: { path: path.join(CSHARP_SCRIPTS_DIR, 'watch-field.cs') } },
    ],
  });

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.passed, true, JSON.stringify(run));

  const source = await readFile(path.join(CSHARP_SCRIPTS_DIR, 'watch-field.cs'), 'utf-8');
  const scripts = [...sent('execute_script'), ...sent('compile_script')];
  assert.equal(sent('compile_script').length, 1);
  assert.equal(scripts.length, 4);
  for (const request of scripts) {
    assert.equal(request.params.source, source);
    assert.equal(request.params.name, 'watch-field');
    assert.equal(request.params.path, undefined, 'the game is sent source, never a path');
  }
  assert.deepEqual(sent('execute_script')[0].params.args, { field: 'health' });
  assert.deepEqual(run.results[0].params, { path: 'watch-field', args: { field: 'health' } },
    'the record shows the step as written, not the whole source');
  assert.ok(!('compileOnly' in sent('compile_script')[0].params), 'the flag never reaches the mod');
});

test('a step reaches the mod the way the tool does, with the flag stripped and the record as written', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true });
  const scriptPath = await writeScript(t, {
    steps: [
      { command: 'swap_bro', params: { broName: 'Rambro', nextSpawn: true } },
      { command: 'swap_bro', params: { broName: 'Bronobi', ignoreUnlocks: true, nextSpawn: false } },
      { command: 'execute_script', params: { source: 'class X {}', name: 'inline', compileOnly: '{{check}}' } },
    ],
    args: { check: { default: true } },
  });

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.passed, true, JSON.stringify(run));

  assert.deepEqual(sent('set_bro').map((r) => r.params), [{ broName: 'Rambro' }]);
  assert.deepEqual(sent('swap_bro').map((r) => r.params), [{ broName: 'Bronobi', ignoreUnlocks: true }]);
  assert.deepEqual(sent('compile_script').map((r) => r.params), [{ source: 'class X {}', name: 'inline' }]);
  assert.equal(sent('execute_script').length, 0);

  assert.deepEqual(run.results.map((r) => r.command), ['swap_bro', 'swap_bro', 'execute_script']);
  assert.deepEqual(run.results[0].params, { broName: 'Rambro', nextSpawn: true });
});

test('a refused step fails the script before any command is sent', async (t) => {
  for (const [step, words] of [
    [{ command: 'swap_bro', params: { broName: 'Rambro', nextSpawn: true, ignoreUnlocks: true } }, /nextSpawn cannot take ignoreUnlocks/],
    [{ command: 'execute_script', params: { path: 'watch-field', compileOnly: true, args: { a: 1 } } }, /compileOnly cannot take args/],
    [{ command: 'read_log', params: { onlyNew: true } }, /implemented by the MCP server/],
  ]) {
    startRecording();
    const run = await runTestScript(await writeScript(t, { steps: [{ command: 'ping' }, step] }), client);
    assert.equal(run.passed, false, step.command);
    assert.match(run.error, words);
    assert.equal(requests.length, 0, `${step.command} let a command through`);
  }
});

test('a library script that does not exist fails the script before any command is sent', async (t) => {
  startRecording();
  const scriptPath = await writeScript(t, {
    steps: [
      { command: 'ping' },
      { command: 'execute_script', params: { path: 'no-such-script' } },
    ],
  });

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.passed, false);
  assert.match(run.error, /step 2: params\.path "no-such-script"/);
  assert.equal(requests.length, 0);
});

test('until re-sends the step every interval until its expect holds', async (t) => {
  startRecording();
  let polls = 0;
  answer = (request, socket) => {
    if (request.method !== 'execute_code') return reply(socket, request.id, { success: true });
    polls++;
    reply(socket, request.id, { success: true, resultSet: true, result: polls >= 4 ? 'done' : 'running' });
  };
  const scriptPath = await writeScript(t, {
    steps: [
      {
        command: 'execute_code',
        params: { code: 'return Phase;' },
        until: { timeout: 30, interval: 2 },
        expect: { contains: ['done'] },
      },
      { command: 'ping' },
    ],
  });

  const clock = fakeClock();
  const run = await runTestScript(scriptPath, client, { sleep: clock.sleep, now: clock.now });

  assert.equal(run.passed, true, JSON.stringify(run.results));
  assert.equal(sent('execute_code').length, 4);
  assert.deepEqual(clock.sleeps, [2000, 2000, 2000]);
  assert.equal(run.results[0].attempts, 4);
  assert.equal(run.results[0].duration, 6000, 'the record\'s duration covers every attempt');
  assert.equal(run.completedSteps, 2);
});

test('until gives up at its timeout, attempting once more at the deadline, and fails on the last attempt', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: 'running' });
  const scriptPath = await writeScript(t, {
    steps: [
      { command: 'execute_code', params: { code: 'return Phase;' }, until: { timeout: 5, interval: 2 }, expect: { contains: ['done'] } },
      { command: 'ping' },
    ],
  });

  const clock = fakeClock();
  const run = await runTestScript(scriptPath, client, { sleep: clock.sleep, now: clock.now });

  assert.equal(run.passed, false);
  assert.deepEqual(clock.sleeps, [2000, 2000, 1000]);
  assert.equal(run.results[0].attempts, 4);
  assert.equal(run.results[0].duration, 5000);
  assert.equal(run.results[0].success, false);
  assert.match(run.results[0].error, /expected result to contain "done"/);
  assert.equal(run.completedSteps, 1, 'a step that never met its expect stops the run');
  assert.equal(sent('ping').length, 0);
});

test('until defaults to a one-second interval', async (t) => {
  startRecording();
  let polls = 0;
  answer = (request, socket) => {
    polls++;
    reply(socket, request.id, { success: true, resultSet: true, result: polls >= 3 ? 'done' : 'running' });
  };
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'x' }, until: { timeout: 10 }, expect: { contains: ['done'] } }],
  });

  const clock = fakeClock();
  const run = await runTestScript(scriptPath, client, { sleep: clock.sleep, now: clock.now });
  assert.equal(run.passed, true);
  assert.deepEqual(clock.sleeps, [1000, 1000]);
});

test('until stops polling a game that went away', async (t) => {
  startRecording();
  answer = (request, socket) => socket.destroy();
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'x' }, until: { timeout: 60 }, expect: { contains: ['done'] } }],
  });

  const clock = fakeClock();
  const run = await runTestScript(scriptPath, client, { sleep: clock.sleep, now: clock.now, isRunning: async () => false });
  assert.equal(run.results[0].attempts, 1);
  assert.match(run.results[0].commandError, /game likely crashed/);
  assert.equal(run.passed, false);
});

test('cleanup runs after a failed step and every cleanup step runs even when one fails', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'execute_code') return reply(socket, request.id, { success: false, error: 'CS1002' });
    if (request.method === 'unload_script') return fail(socket, request.id, 'no such script');
    reply(socket, request.id, { success: true });
  };
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'x' } }, { command: 'ping' }],
    cleanup: [
      { command: 'unload_script', params: { name: 'a' } },
      { command: 'set_game_speed', params: { speed: 1 } },
    ],
  });

  const run = await runTestScript(scriptPath, client, { isRunning: async () => true });
  assert.equal(run.completedSteps, 1);
  assert.equal(sent('ping').length, 0);
  assert.equal(run.cleanup.length, 2, 'a failed cleanup step does not stop the rest');
  assert.equal(run.cleanup[0].success, false);
  assert.equal(run.cleanup[0].error, 'no such script');
  assert.equal(run.cleanup[1].success, true);
  assert.equal(sent('set_game_speed').length, 1);
  assert.equal(run.passed, false);
});

test('cleanup runs after a step whose command threw while the game is still up', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'go_to_level') return fail(socket, request.id, 'Main thread timeout');
    reply(socket, request.id, { success: true });
  };
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'go_to_level', params: { levelIndex: 0 } }],
    cleanup: [{ command: 'unload_script', params: { name: 'runner' } }],
  });

  const run = await runTestScript(scriptPath, client, { isRunning: async () => true });
  assert.equal(run.results[0].error, 'Main thread timeout');
  assert.equal(run.cleanup.length, 1);
  assert.equal(run.cleanup[0].success, true);
  assert.equal(run.cleanupSkipped, undefined);
  assert.equal(run.passed, false, 'a passing cleanup does not rescue a failed step');
});

test('cleanup is skipped when the game died under a step', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'execute_code') return socket.destroy();
    reply(socket, request.id, { success: true });
  };
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'crash()' } }, { command: 'ping' }],
    cleanup: [{ command: 'unload_script', params: { name: 'runner' } }],
  });

  const run = await runTestScript(scriptPath, client, { isRunning: async () => false });
  assert.match(run.results[0].error, /game likely crashed/);
  assert.deepEqual(run.cleanup, []);
  assert.match(run.cleanupSkipped, /the game is gone/);
  assert.equal(sent('unload_script').length, 0);
  assert.equal(run.passed, false);
});

test('a crash-like error with the game still running does not skip cleanup', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'execute_code') return socket.destroy();
    reply(socket, request.id, { success: true });
  };
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'x' } }],
    cleanup: [{ command: 'unload_script', params: { name: 'runner' } }],
  });

  const run = await runTestScript(scriptPath, client, { isRunning: async () => true });
  assert.equal(run.cleanup.length, 1);
  assert.equal(run.cleanup[0].success, true);
});

test('cleanup stops once the game dies under a cleanup step', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'unload_script') return socket.destroy();
    reply(socket, request.id, { success: true });
  };
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'ping' }],
    cleanup: [
      { command: 'unload_script', params: { name: 'a' } },
      { command: 'set_game_speed', params: { speed: 1 } },
    ],
  });

  const run = await runTestScript(scriptPath, client, { isRunning: async () => false });
  assert.equal(run.cleanup.length, 1);
  assert.match(run.cleanupSkipped, /1 cleanup step\(s\) did not run/);
  assert.equal(run.passed, false);
});

test('placeholders are filled from args and declared defaults, nested params included, keeping types', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true });
  const scriptPath = await writeScript(t, {
    args: {
      campaign: { default: 1, description: 'campaign index' },
      level: { default: 0 },
      bro: { description: 'bro to swap to' },
    },
    steps: [
      { command: 'go_to_level', params: { campaignIndex: '{{campaign}}', levelIndex: '{{level}}' } },
      {
        command: 'execute_script',
        params: { path: 'watch-field', args: { label: 'level {{campaign}}-{{level}} as {{bro}}', nested: ['{{bro}}', { deep: '{{level}}' }] } },
      },
    ],
    cleanup: [{ command: 'swap_bro', params: { broName: '{{bro}}' } }],
  });

  const run = await runTestScript(scriptPath, client, { args: { level: 3, bro: 'Rambro' }, isRunning: async () => true });
  assert.equal(run.passed, true, JSON.stringify(run));
  assert.deepEqual(sent('go_to_level')[0].params, { campaignIndex: 1, levelIndex: 3 });
  assert.deepEqual(sent('execute_script')[0].params.args, {
    label: 'level 1-3 as Rambro',
    nested: ['Rambro', { deep: 3 }],
  });
  assert.deepEqual(sent('swap_bro')[0].params, { broName: 'Rambro' });
  assert.deepEqual(run.args, { campaign: 1, level: 3, bro: 'Rambro' });
});

test('a placeholder with no value is a validation error naming it', async (t) => {
  startRecording();
  const scriptPath = await writeScript(t, {
    args: { bro: { description: 'no default' } },
    steps: [{ command: 'swap_bro', params: { broName: '{{bro}}', extra: { deeper: 'x {{missing}}' } } }],
    cleanup: [{ command: 'ping', params: { tag: '{{other}}' } }],
  });

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.passed, false);
  assert.match(run.error, /step 1: no value for \{\{bro\}\}/);
  assert.match(run.error, /step 1: no value for \{\{missing\}\}/);
  assert.match(run.error, /cleanup step 1: no value for \{\{other\}\}/);
  assert.equal(requests.length, 0);
});

test('a given arg neither declared nor named by a placeholder is refused before anything is sent', async (t) => {
  startRecording();
  const scriptPath = await writeScript(t, {
    args: { bro: { default: 'Rambro' } },
    steps: [{ command: 'swap_bro', params: { broName: '{{bro}}', playerNum: '{{slot}}' } }],
    cleanup: [{ command: 'swap_bro', params: { broName: '{{after}}' } }],
  });

  const run = await runTestScript(scriptPath, client, { args: { customBor: 'Cobro', slot: 0, after: 'Rambro' } });
  assert.equal(run.passed, false);
  assert.match(run.error, /unknown arg "customBor" \(allowed: bro, slot, after\)/);
  assert.equal(requests.length, 0);

  const bare = await writeScript(t, { steps: [{ command: 'ping' }] });
  const refused = await runTestScript(bare, client, { args: { anything: 1 } });
  assert.match(refused.error, /unknown arg "anything" \(allowed: none\)/);
  assert.equal(requests.length, 0);
});

test('an undeclared placeholder can be filled from args, in a step and in a cleanup step', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'swap_bro', params: { broName: '{{bro}}' } }],
    cleanup: [{ command: 'swap_bro', params: { broName: '{{after}}', nextSpawn: true } }],
  });

  const run = await runTestScript(scriptPath, client, { args: { bro: 'Cobro', after: 'Rambro' } });
  assert.equal(run.passed, true, JSON.stringify(run));
  assert.equal(sent('swap_bro')[0].params.broName, 'Cobro');
  assert.equal(sent('set_bro')[0].params.broName, 'Rambro');
});

test('a report step lifts its JSON string into the reply, and its passed counts', async (t) => {
  startRecording();
  const report = { scenario: 'level-run', passed: false, checks: [{ name: 'reachedExit', passed: false }] };
  answer = (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: JSON.stringify(report) });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'return Run.ReportJson;' }, report: true }],
  });

  const run = await runTestScript(scriptPath, client);
  assert.deepEqual(run.report, report);
  assert.equal(run.results[0].success, true);
  assert.equal(run.results[0].reportLifted, true);
  assert.equal(run.results[0].result, undefined, 'the report is not carried twice');
  assert.equal(run.passed, false, 'a report saying passed: false fails the run');
});

test('a report object is lifted as is, and a report without passed leaves the verdict to the steps', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: { joined: true } });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'x' }, report: true }],
  });

  const run = await runTestScript(scriptPath, client);
  assert.deepEqual(run.report, { joined: true });
  assert.equal(run.passed, true);
});

test('two report steps give an array of reports, each counting toward the verdict', async (t) => {
  startRecording();
  let n = 0;
  answer = (request, socket) => {
    n++;
    reply(socket, request.id, { success: true, resultSet: true, result: JSON.stringify({ n, passed: true }) });
  };
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'a' }, report: true }],
    cleanup: [{ command: 'execute_code', params: { code: 'b' }, report: true }],
  });

  const run = await runTestScript(scriptPath, client, { isRunning: async () => true });
  assert.deepEqual(run.report, [{ n: 1, passed: true }, { n: 2, passed: true }]);
  assert.equal(run.passed, true);
});

test('a report that does not parse fails its step, saying so', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: '{not json' });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'x' }, report: true }, { command: 'ping' }],
  });

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.results[0].success, false);
  assert.match(run.results[0].error, /report: the step's result is not JSON/);
  assert.equal(run.report, undefined);
  assert.equal(run.completedSteps, 1);
  assert.equal(run.passed, false);
});

test('a report that parses to something other than an object fails its step', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: '42' });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'x' }, report: true }],
  });

  const run = await runTestScript(scriptPath, client);
  assert.match(run.results[0].error, /not a JSON object/);
  assert.equal(run.passed, false);
});

test('passed needs every step and every cleanup step to pass', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'set_game_speed') return reply(socket, request.id, { success: false, error: 'bad speed' });
    reply(socket, request.id, { success: true });
  };

  const allGood = await writeScript(t, {
    steps: [{ command: 'ping' }, { command: 'ping' }],
    cleanup: [{ command: 'ping' }],
  });
  const good = await runTestScript(allGood, client, { isRunning: async () => true });
  assert.equal(good.passed, true);

  const badCleanup = await writeScript(t, {
    steps: [{ command: 'ping' }],
    cleanup: [{ command: 'set_game_speed', params: { speed: 0 } }],
  });
  const bad = await runTestScript(badCleanup, client, { isRunning: async () => true });
  assert.equal(bad.failedSteps, 0);
  assert.equal(bad.passed, false, 'a failed cleanup step fails the run');

  const expectedFailure = await writeScript(t, {
    steps: [{ command: 'set_game_speed', params: { speed: 0 }, expect: { success: false } }],
  });
  const expected = await runTestScript(expectedFailure, client);
  assert.equal(expected.passed, true, 'a step that fails as expected passes');
});

test('continueOnFailure runs past an unmet expectation and a thrown command, listing each failure', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'execute_code') return reply(socket, request.id, { success: true, resultSet: true, result: 'running' });
    if (request.method === 'go_to_level') return fail(socket, request.id, 'Main thread timeout\nat MainThreadDispatcher');
    reply(socket, request.id, { success: true });
  };
  const scriptPath = await writeScript(t, {
    continueOnFailure: true,
    steps: [
      { command: 'execute_code', params: { code: 'x' }, expect: { contains: ['done', 'ready'] } },
      { command: 'go_to_level', params: { levelIndex: 0 } },
      { command: 'ping' },
    ],
    cleanup: [{ command: 'unload_script', params: { name: 'runner' } }],
  });

  const run = await runTestScript(scriptPath, client, { isRunning: async () => true });
  assert.equal(run.completedSteps, 3, 'results carry every step');
  assert.equal(run.results.length, 3);
  assert.equal(run.failedSteps, 2);
  assert.equal(sent('ping').length, 1);
  assert.equal(run.cleanup.length, 1);
  assert.equal(run.passed, false);
  assert.deepEqual(run.failures, [
    { step: 1, command: 'execute_code', error: 'expected result to contain "done"' },
    { step: 2, command: 'go_to_level', error: 'Main thread timeout' },
  ]);
});

test('continueOnFailure stops at a step the game died under, and cleanup is skipped', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'execute_code') return socket.destroy();
    reply(socket, request.id, { success: true });
  };
  const scriptPath = await writeScript(t, {
    continueOnFailure: true,
    steps: [{ command: 'execute_code', params: { code: 'crash()' } }, { command: 'ping' }],
    cleanup: [{ command: 'unload_script', params: { name: 'runner' } }],
  });

  const run = await runTestScript(scriptPath, client, { isRunning: async () => false });
  assert.equal(run.completedSteps, 1);
  assert.equal(sent('ping').length, 0);
  assert.match(run.cleanupSkipped, /the game is gone/);
  assert.equal(run.failures.length, 1);
  assert.match(run.failures[0].error, /game likely crashed/);
  assert.equal(run.passed, false);
});

test('continueOnFailure lists failed cleanup steps too, and is empty on a clean run', async (t) => {
  startRecording();
  answer = (request, socket) => {
    if (request.method === 'unload_script') return fail(socket, request.id, 'no such script');
    reply(socket, request.id, { success: true });
  };
  const failing = await writeScript(t, {
    continueOnFailure: true,
    steps: [{ command: 'ping' }],
    cleanup: [{ command: 'unload_script', params: { name: 'a' } }],
  });
  const run = await runTestScript(failing, client, { isRunning: async () => true });
  assert.deepEqual(run.failures, [{ step: 1, command: 'unload_script', error: 'no such script', cleanup: true }]);
  assert.equal(run.passed, false);

  const clean = await writeScript(t, { continueOnFailure: true, steps: [{ command: 'ping' }] });
  const ok = await runTestScript(clean, client);
  assert.deepEqual(ok.failures, []);
  assert.equal(ok.passed, true);

  const without = await writeScript(t, { steps: [{ command: 'unload_script', params: { name: 'a' } }, { command: 'ping' }] });
  const stopped = await runTestScript(without, client);
  assert.equal(stopped.completedSteps, 1, 'without the flag the run still stops at the first failure');
  assert.equal(stopped.failures, undefined);
});

test('continueOnFailure must be a boolean', async (t) => {
  startRecording();
  const scriptPath = await writeScript(t, { continueOnFailure: 'yes', steps: [{ command: 'ping' }] });
  const run = await runTestScript(scriptPath, client);
  assert.match(run.error, /"continueOnFailure" must be a boolean/);
  assert.equal(requests.length, 0);
});

test('the run carries what the player log gained, also when a step failed', async (t) => {
  startRecording();
  const dir = await tempDir(t);
  const umm = path.join(dir, 'Log.txt');
  const player = path.join(dir, 'Player.log');
  await writeFile(umm, '[Manager] Loading mods.\n');
  await writeFile(player, 'Initialize engine version\n');

  answer = (request, socket) => {
    appendFile(player, '[Swap Bros Mod] [Error] Swap failed\n')
      .then(() => appendFile(umm, '[Swap Bros Mod] [Error] Swap failed\n'))
      .then(() => appendFile(player, 'NullReferenceException: boom\n   at void LevelEventAction.Start()\n \n(Filename:  Line: -1)\n\n'))
      .then(() => fail(socket, request.id, 'step failed'));
  };
  const scriptPath = await writeScript(t, { steps: [{ command: 'ping' }] });

  const clock = fakeClock();
  const run = await runTestScript(scriptPath, client, {
    logPaths: async () => ({ umm, player }),
    isRunning: async () => true,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(run.passed, false);
  assert.equal(run.logs.umm, undefined, 'the UMM log is not read beside a readable player log');
  assert.equal(run.logs.player.fromByte, 'Initialize engine version\n'.length);
  assert.deepEqual(clock.sleeps, [], 'the player log needs no wait for UMM\'s buffer');
  assert.equal(run.logs.summary.errors, 2);
  const sources = run.logs.bySource.map((s) => s.source).sort();
  assert.deepEqual(sources, ['Swap Bros Mod', 'Unity']);
  const unity = run.logs.bySource.find((s) => s.source === 'Unity');
  assert.equal(unity.origin, 'Broforce');
  assert.equal(unity.groups[0].message, 'NullReferenceException: boom');
});

test('the run carries the log delta after the game died, and when the baseline could not be taken', async (t) => {
  startRecording();
  const dir = await tempDir(t);
  const player = path.join(dir, 'Player.log');
  await writeFile(player, '');
  answer = (request, socket) => {
    appendFile(player, 'Crash!!!\n').then(() => socket.destroy());
  };
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'ping' }],
    cleanup: [{ command: 'ping' }],
  });

  const clock = fakeClock();
  const crashCalls = [];
  const run = await runTestScript(scriptPath, client, {
    isRunning: async () => false,
    logPaths: async () => ({ umm: path.join(dir, 'absent.txt'), player }),
    crashLog: async (since) => { crashCalls.push(since); return { path: 'launch.log', lines: ['Caught fatal signal - signo:11'] }; },
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.match(run.cleanupSkipped, /the game is gone/);
  assert.deepEqual(clock.sleeps, [], 'a game that is gone has no UMM buffer left to flush');
  assert.equal(run.logs.umm, undefined);
  assert.equal(run.logs.summary.lines, 1);
  assert.equal(run.logs.summary.errors, 1, 'the crash line is an error');
  assert.equal(run.logs.bySource[0].source, 'Unity (engine)');
  assert.deepEqual(run.logs.crashLog, { path: 'launch.log', lines: ['Caught fatal signal - signo:11'] });
  assert.equal(crashCalls.length, 1);
  assert.ok(Math.abs(crashCalls[0] - Date.now()) < 60000, 'the crash log is read from the run\'s start');

  const broken = await runTestScript(scriptPath, client, {
    isRunning: async () => true,
    logPaths: async () => { throw new Error('no target'); },
  });
  assert.match(broken.logs.error, /log baseline failed: no target/);
});

test('the final log read waits out UMM\'s write buffer while the game runs', async (t) => {
  startRecording();
  const dir = await tempDir(t);
  const umm = path.join(dir, 'Log.txt');
  await writeFile(umm, '');
  answer = (request, socket) => reply(socket, request.id, { success: true });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'ping' }],
    cleanup: [{ command: 'unload_script', params: { name: 'runner' } }],
  });

  const clock = fakeClock();
  const sleep = async (ms) => {
    await clock.sleep(ms);
    if (ms === UMM_FLUSH_WAIT_MS) await appendFile(umm, '[Runner] [Error] Unload failed\n');
  };
  const run = await runTestScript(scriptPath, client, {
    logPaths: async () => ({ umm, player: null }),
    isRunning: async () => true,
    sleep,
    now: clock.now,
  });

  assert.equal(UMM_FLUSH_WAIT_MS, 600);
  assert.deepEqual(clock.sleeps, [UMM_FLUSH_WAIT_MS]);
  assert.equal(run.logs.summary.errors, 1, JSON.stringify(run.logs));
  assert.equal(run.logs.bySource[0].source, 'Runner');
});

test('the final log read does not wait for a game that is gone, or with no UMM log to read', async (t) => {
  startRecording();
  const dir = await tempDir(t);
  const umm = path.join(dir, 'Log.txt');
  const player = path.join(dir, 'Player.log');
  answer = (request, socket) => reply(socket, request.id, { success: true });
  const scriptPath = await writeScript(t, { steps: [{ command: 'ping' }] });

  const stopped = fakeClock();
  await runTestScript(scriptPath, client, {
    logPaths: async () => ({ umm, player }),
    isRunning: async () => false,
    sleep: stopped.sleep,
    now: stopped.now,
  });
  assert.deepEqual(stopped.sleeps, []);

  const playerOnly = fakeClock();
  await runTestScript(scriptPath, client, {
    logPaths: async () => ({ umm: null, player }),
    isRunning: async () => true,
    sleep: playerOnly.sleep,
    now: playerOnly.now,
  });
  assert.deepEqual(playerOnly.sleeps, []);

  const unknown = fakeClock();
  await runTestScript(scriptPath, client, {
    logPaths: async () => ({ umm, player }),
    isRunning: async () => null,
    sleep: unknown.sleep,
    now: unknown.now,
  });
  assert.deepEqual(unknown.sleeps, [UMM_FLUSH_WAIT_MS], 'a game whose state is unknown may still be writing');

  await writeFile(player, '');
  answer = (request, socket) => appendFile(player, 'a line\n').then(() => reply(socket, request.id, { success: true }));
  const readablePlayer = fakeClock();
  await runTestScript(scriptPath, client, {
    logPaths: async () => ({ umm, player }),
    isRunning: async () => true,
    sleep: readablePlayer.sleep,
    now: readablePlayer.now,
  });
  assert.deepEqual(readablePlayer.sleeps, [], 'the UMM log is not read beside a player log the run wrote');
});

test('a player log the run never wrote gives way to the UMM log the game is writing', async (t) => {
  startRecording();
  const dir = await tempDir(t);
  const umm = path.join(dir, 'Log.txt');
  const player = path.join(dir, 'Player.log');
  await writeFile(umm, '');
  await writeFile(player, 'an earlier run of another install\n');
  answer = (request, socket) => appendFile(umm, '[Swap Bros Mod] [Error] Swap failed\n').then(() => reply(socket, request.id, { success: true }));
  const scriptPath = await writeScript(t, { steps: [{ command: 'ping' }] });

  const clock = fakeClock();
  const run = await runTestScript(scriptPath, client, {
    logPaths: async () => ({ umm, player }),
    isRunning: async () => true,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(run.logs.umm.path, umm);
  assert.equal(run.logs.summary.errors, 1, JSON.stringify(run.logs));
  assert.equal(run.logs.bySource[0].source, 'Swap Bros Mod');
  assert.deepEqual(clock.sleeps, [UMM_FLUSH_WAIT_MS], 'the UMM log read waits out its write buffer');
});

test('two runs on one server overlapping each say their logs may hold the other\'s lines', async (t) => {
  startRecording();
  const dir = await tempDir(t);
  const player = path.join(dir, 'Player.log');
  await writeFile(player, '');
  answer = (request, socket) => setTimeout(() => reply(socket, request.id, { success: true }), 50);
  const scriptPath = await writeScript(t, { steps: [{ command: 'ping' }] });
  const options = { logPaths: async () => ({ umm: null, player }), isRunning: async () => true };

  const [first, second] = await Promise.all([runTestScript(scriptPath, client, options), runTestScript(scriptPath, client, options)]);
  assert.equal(first.logs.overlappingRun, true);
  assert.equal(second.logs.overlappingRun, true);
  const alone = await runTestScript(scriptPath, client, options);
  assert.equal(alone.logs.overlappingRun, undefined);
});

test('UNITY_INSPECTOR_LOG is read as the player log or the UMM log by its file name', async (t) => {
  const dir = await tempDir(t);
  t.after(() => { delete process.env.UNITY_INSPECTOR_LOG; });

  for (const name of ['Player.log', 'Player-prev.log', 'output_log.txt']) {
    process.env.UNITY_INSPECTOR_LOG = path.join(dir, name);
    assert.deepEqual(await targetLogPaths(), { umm: null, player: path.join(dir, name) }, name);
  }
  process.env.UNITY_INSPECTOR_LOG = path.join(dir, 'Log.txt');
  const ummOverride = await targetLogPaths();
  assert.equal(ummOverride.umm, path.join(dir, 'Log.txt'));
  assert.notEqual(ummOverride.player, path.join(dir, 'Log.txt'), 'a UMM override still leaves the player log searched for');

  const player = path.join(dir, 'Player.log');
  await writeFile(player, '');
  process.env.UNITY_INSPECTOR_LOG = player;
  startRecording();
  answer = (request, socket) => {
    appendFile(player, '[Unity] <color=red>NullReferenceException: boom</color>\nNullReferenceException: boom\n   at void LevelEventAction.Start()\n \n(Filename:  Line: -1)\n\n')
      .then(() => reply(socket, request.id, { success: true }));
  };
  const scriptPath = await writeScript(t, { steps: [{ command: 'ping' }] });
  const response = await handleToolCall({ params: { name: 'run_test_script', arguments: { script: scriptPath } } });
  const payload = JSON.parse(response.content.map((c) => c.text).join('\n'));
  assert.equal(payload.logs.player.path, player);
  assert.equal(payload.logs.umm, undefined);
  const unity = payload.logs.bySource.find((s) => s.source === 'Unity');
  assert.equal(unity?.errors, 1, JSON.stringify(payload.logs));
  assert.equal(payload.logs.summary.errors, 1, 'the [Unity] mirror is not counted beside the call');
  assert.equal(unity.origin, 'Broforce');
});

test('run_test_script takes args and answers with passed and logs', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true, echoed: request.params });
  const scriptPath = await writeScript(t, {
    args: { level: { default: 0 } },
    steps: [{ command: 'go_to_level', params: { campaignIndex: 0, levelIndex: '{{level}}' } }],
  });

  const response = await handleToolCall({
    params: { name: 'run_test_script', arguments: { script: scriptPath, args: { level: 4 } } },
  });
  const payload = JSON.parse(response.content.map((c) => c.text).join('\n'));
  assert.equal(payload.passed, true, JSON.stringify(payload));
  assert.deepEqual(sent('go_to_level')[0].params, { campaignIndex: 0, levelIndex: 4 });
  assert.ok(payload.logs && 'player' in payload.logs, JSON.stringify(payload.logs));
});

test('run_test_script checks each step\'s params against its tool\'s schema before it sends anything', async (t) => {
  startRecording();
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'ping' }, { command: 'query_gameobjects', params: { name: 'Mook' } }],
  });

  const response = await handleToolCall({ params: { name: 'run_test_script', arguments: { script: scriptPath } } });
  const payload = JSON.parse(response.content.map((c) => c.text).join('\n'));
  assert.equal(payload.passed, false);
  assert.match(payload.error, /step 2: query_gameobjects has no argument "name"; its arguments are namePattern/);
  assert.equal(requests.length, 0);
});

test('run_test_script refuses args that are not an object', async (t) => {
  const scriptPath = await writeScript(t, { steps: [{ command: 'ping' }] });
  const response = await handleToolCall({
    params: { name: 'run_test_script', arguments: { script: scriptPath, args: 'level=4' } },
  });
  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, 'Error: run_test_script: args must be an object, got "level=4"');
});

const printed = (reply) => JSON.stringify(reply, null, 2).length;

test('the reply previews each step\'s result in 300 characters, flagging a cut one', async (t) => {
  startRecording();
  const long = 'x'.repeat(2000);
  answer = (request, socket) => reply(socket, request.id, request.method === 'ping'
    ? { success: true, pong: true }
    : { success: true, resultSet: true, result: long });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'ping' }, { command: 'execute_code', params: { code: 'x' } }],
  });
  const full = await runTestScript(scriptPath, client);
  const dir = await tempDir(t);

  const compact = await compactTestScriptReply(full, { script: scriptPath, dir });
  assert.equal(STEP_PREVIEW_MAX_CHARS, 300);
  assert.deepEqual(compact.results[0], { step: 1, command: 'ping', passed: true, preview: '{"success":true,"pong":true}' });
  const cut = compact.results[1];
  assert.equal(cut.passed, true);
  assert.equal(cut.truncated, true);
  assert.equal(cut.preview.length, STEP_PREVIEW_MAX_CHARS);
  assert.ok(JSON.stringify(full.results[1].result).startsWith(cut.preview));
  assert.equal(compact.omitted, undefined);
});

test('resultsFile holds the whole run, every step\'s full result included', async (t) => {
  startRecording();
  const long = 'y'.repeat(5000);
  answer = (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: long });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'execute_code', params: { code: 'a' } }],
    cleanup: [{ command: 'execute_code', params: { code: 'b' } }],
  });
  const full = await runTestScript(scriptPath, client, { isRunning: async () => true });
  const dir = await tempDir(t);

  const compact = await compactTestScriptReply(full, { script: scriptPath, dir, now: () => Date.UTC(2026, 10, 2, 9, 30, 15, 123) });
  assert.equal(compact.resultsFile, path.join(dir, 'script-2026-11-02T09-30-15-123Z.json'));
  assert.deepEqual(JSON.parse(await readFile(compact.resultsFile, 'utf-8')), JSON.parse(JSON.stringify(full)));
  assert.equal(compact.cleanup[0].truncated, true, 'cleanup steps are previewed the same way');
});

test('a run that could not write its results file says why and still answers', async (t) => {
  const dir = await tempDir(t);
  const blocker = path.join(dir, 'not-a-dir');
  await writeFile(blocker, '');
  const full = { passed: true, results: [{ step: 1, command: 'ping', success: true, result: { success: true } }] };

  const compact = await compactTestScriptReply(full, { script: 'x', dir: blocker });
  assert.equal(compact.resultsFile, undefined);
  assert.match(compact.resultsFileError, /the full results could not be written/);
  assert.equal(compact.results.length, 1);
});

test('a failing step\'s preview opens with the unmet expectation or the error\'s first lines', async (t) => {
  startRecording();
  const trace = `Main thread timeout\nat MainThreadDispatcher\n${'  at Frame()\n'.repeat(100)}`;
  answer = (request, socket) => {
    if (request.method === 'execute_code') return reply(socket, request.id, { success: true, resultSet: true, result: 'z'.repeat(3000) });
    fail(socket, request.id, trace);
  };
  const scriptPath = await writeScript(t, {
    continueOnFailure: true,
    steps: [
      { command: 'execute_code', params: { code: 'x' }, expect: { contains: ['done'] } },
      { command: 'go_to_level', params: { levelIndex: 0 } },
    ],
  });
  const full = await runTestScript(scriptPath, client, { isRunning: async () => true });
  const compact = await compactTestScriptReply(full, { script: scriptPath, dir: await tempDir(t) });

  assert.equal(compact.results[0].passed, false);
  assert.equal(compact.results[0].preview, 'Unmet expectations: expected result to contain "done"');
  assert.equal(compact.results[1].passed, false);
  assert.ok(compact.results[1].preview.startsWith('Main thread timeout\nat MainThreadDispatcher\n'));
  assert.equal(compact.results[1].truncated, true);
  assert.deepEqual(compact.failures, full.failures, 'failures pass through unchanged');
});

test('a run with no failures stays small however large its results', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: 'r'.repeat(5000) });
  const scriptPath = await writeScript(t, {
    steps: Array.from({ length: 30 }, () => ({ command: 'execute_code', params: { code: 'x' } })),
  });
  const full = await runTestScript(scriptPath, client);
  const compact = await compactTestScriptReply(full, { script: scriptPath, dir: await tempDir(t) });

  assert.equal(compact.passed, true);
  assert.ok(printed(full) > 150000, `the full run is ${printed(full)} characters`);
  assert.ok(printed(compact) < 15000, `the reply is ${printed(compact)} characters`);
  assert.equal(compact.omitted, undefined);
});

function syntheticRun({ steps = 20, eventChars = 0, checksChars = 0, logChars = 0 } = {}) {
  const results = Array.from({ length: steps }, (_, i) => (i === 0
    ? { step: 1, command: 'execute_code', success: false, error: 'boom '.repeat(100) }
    : { step: i + 1, command: 'ping', success: true, result: { text: 'p'.repeat(1000) } }));
  const report = {
    scenario: 'level-run',
    passed: false,
    outcome: 'stuck',
    checks: [{ name: 'reachedExit', passed: false, detail: 'c'.repeat(checksChars) }],
    events: Array.from({ length: 200 }, (_, i) => ({ t: i, what: 'e'.repeat(eventChars / 200) })),
    stuck: Array.from({ length: 200 }, (_, i) => ({ t: i, x: 1, y: 2 })),
    grid: { cells: 'g'.repeat(REPORT_FIELD_MAX_CHARS) },
    note: 'small object stays',
    longText: 't'.repeat(REPORT_FIELD_MAX_CHARS),
  };
  return {
    scriptName: 'Synthetic',
    passed: false,
    results,
    ...(eventChars || checksChars ? { report } : {}),
    ...(logChars ? { logs: { summary: { errors: 1 }, blob: 'L'.repeat(logChars) } } : {}),
  };
}

test('an over-long reply sheds previews, then logs, then the report\'s bulky fields, the report and the step list', async (t) => {
  const dir = await tempDir(t);
  assert.equal(TEST_REPLY_MAX_CHARS, 40000);

  const fits = await compactTestScriptReply(syntheticRun(), { dir, maxChars: 20000 });
  assert.equal(fits.omitted, undefined);
  assert.ok(fits.results[1].preview);

  const passingCut = await compactTestScriptReply(syntheticRun(), { dir, maxChars: 4000 });
  assert.ok(passingCut.results[0].preview.startsWith('boom'), 'the failing step keeps its preview');
  assert.equal(passingCut.results[1].preview, undefined);
  assert.match(passingCut.omitted, /^Left out to fit 4000 characters: the previews of passing steps; resultsFile has them$/);

  const allCut = await compactTestScriptReply(syntheticRun(), { dir, maxChars: 2000 });
  assert.deepEqual(allCut.results[0], { step: 1, command: 'execute_code', passed: false });
  assert.match(allCut.omitted, /: every step preview;/);

  const bigLogs = await compactTestScriptReply(syntheticRun({ eventChars: 2000, logChars: 50000 }), { dir });
  assert.equal(bigLogs.logs, undefined);
  assert.equal(bigLogs.report.events.length, 200, 'the report stays whole while dropping the logs is enough');
  assert.match(bigLogs.omitted, /: every step preview, logs;/);

  const bigReport = await compactTestScriptReply(syntheticRun({ eventChars: 40000, logChars: 3000 }), { dir });
  assert.equal(bigReport.logs, undefined);
  assert.deepEqual(Object.keys(bigReport.report), ['scenario', 'passed', 'outcome', 'checks', 'note']);
  assert.equal(bigReport.report.checks[0].name, 'reachedExit');
  assert.match(bigReport.omitted, /: every step preview, logs, report\.events, report\.stuck, report\.grid, report\.longText;/);
  assert.ok(printed(bigReport) <= TEST_REPLY_MAX_CHARS);

  const hugeChecks = await compactTestScriptReply(syntheticRun({ eventChars: 2000, checksChars: 50000 }), { dir });
  assert.equal(hugeChecks.report, undefined);
  assert.match(hugeChecks.omitted, /: every step preview, report;/);
  assert.equal(hugeChecks.results.length, 20);

  const manySteps = await compactTestScriptReply(syntheticRun({ steps: 1000 }), { dir });
  assert.equal(manySteps.results, undefined);
  assert.match(manySteps.omitted, /the per-step list/);
  assert.equal(manySteps.passed, false);
  assert.ok(printed(manySteps) <= TEST_REPLY_MAX_CHARS);
  assert.equal(JSON.parse(await readFile(manySteps.resultsFile, 'utf-8')).results.length, 1000);
});

test('an array of reports is trimmed report by report', async (t) => {
  const run = syntheticRun({ eventChars: 40000 });
  run.report = [run.report, { scenario: 'other', passed: true, events: ['x'] }];
  const compact = await compactTestScriptReply(run, { dir: await tempDir(t) });
  assert.deepEqual(compact.report[1], { scenario: 'other', passed: true });
  assert.equal(compact.report[0].outcome, 'stuck');
});

test('the results directory keeps only the newest files', async (t) => {
  const dir = await tempDir(t);
  const full = { passed: true, results: [] };
  let clock = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 5; i++) {
    clock += 1000;
    const { resultsFile } = await compactTestScriptReply(full, { script: `run${i}`, dir, keep: 3, now: () => clock });
    const when = new Date(clock);
    await utimes(resultsFile, when, when);
  }
  assert.equal(TEST_RESULTS_KEEP, 100);
  assert.deepEqual((await readdir(dir)).map((name) => name.split('-')[0]).sort(), ['run2', 'run3', 'run4']);
});

test('pruning leaves alone every file and directory it did not write', async (t) => {
  const dir = await tempDir(t);
  const old = new Date(Date.UTC(2020, 0, 1));
  const foreign = ['package.json', 'settings.json', 'run-2020-01-01T00-00-00-000Z.json.bak'];
  for (const name of foreign) {
    await writeFile(path.join(dir, name), '{}');
    await utimes(path.join(dir, name), old, old);
  }
  await mkdir(path.join(dir, 'sub-2020-01-01T00-00-00-000Z.json'));
  await mkdir(path.join(dir, 'sub.json'));

  const full = { passed: true, results: [] };
  for (let i = 0; i < 3; i++) await compactTestScriptReply(full, { script: `run${i}`, dir, keep: 1, now: () => Date.UTC(2026, 0, 1, 0, 0, i) });

  const left = (await readdir(dir)).sort();
  for (const name of [...foreign, 'sub-2020-01-01T00-00-00-000Z.json', 'sub.json']) assert.ok(left.includes(name), `${name} was removed`);
  assert.deepEqual(left.filter((name) => name.startsWith('run') && name.endsWith('.json')).length, 1);
});

test('the results directory is the session\'s own, in the user\'s state directory, never the temp directory', () => {
  const id = { CLAUDE_SESSION_ID: 'abc-123' };
  assert.equal(testResultsDir(id, '/home/u'), '/home/u/.local/state/unity-inspector-mcp/test-results/abc-123');
  assert.equal(testResultsDir({ ...id, XDG_STATE_HOME: '/state' }, '/home/u'), '/state/unity-inspector-mcp/test-results/abc-123');
  assert.equal(testResultsDir({ ...id, XDG_STATE_HOME: 'relative' }, '/home/u'), '/home/u/.local/state/unity-inspector-mcp/test-results/abc-123');
  assert.equal(testResultsDir({ ...id, UNITY_INSPECTOR_TEST_RESULTS_DIR: '/x', XDG_STATE_HOME: '/state' }, '/home/u'), '/x/abc-123');
  assert.equal(testResultsDir({ ...id, TMPDIR: '/tmp/nix-shell-1' }, '/home/u'), '/home/u/.local/state/unity-inspector-mcp/test-results/abc-123');
  assert.equal(resultsSession({ CLAUDE_SESSION_ID: 'not a valid id' }, 4242), 'pid-4242');
  assert.equal(resultsSession({}, 4242), 'pid-4242');
});

test('one session\'s pruning never touches another\'s results, and a session idle for a week is cleared', async (t) => {
  const root = await tempDir(t);
  const full = { passed: true, results: [] };
  const clock = Date.UTC(2026, 0, 10);
  const other = await compactTestScriptReply(full, { script: 'theirs', root, session: 'other', now: () => clock });
  const idle = await compactTestScriptReply(full, { script: 'old', root, session: 'idle', now: () => clock });
  const legacy = path.join(root, 'flat-2025-01-01T00-00-00-000Z.json');
  await writeFile(legacy, '{}');
  const weekAgo = new Date(clock - RESULTS_SESSION_IDLE_MS - 1000);
  await utimes(path.join(root, 'idle'), weekAgo, weekAgo);
  await utimes(legacy, weekAgo, weekAgo);

  for (let i = 0; i < 3; i++) {
    await compactTestScriptReply(full, { script: `mine${i}`, root, session: 'mine', keep: 1, now: () => clock + i });
  }
  assert.equal((await readdir(path.join(root, 'mine'))).length, 1);
  assert.deepEqual(await readdir(path.dirname(other.resultsFile)), [path.basename(other.resultsFile)]);
  assert.deepEqual((await readdir(root)).sort(), ['mine', 'other'], `idle results ${idle.resultsFile} and the old flat file are gone`);
});

test('a script refused before it ran answers as it was, with no results file', async (t) => {
  const refused = { error: 'Script must have a "steps" array', scriptPath: 'x', passed: false };
  assert.equal(await compactTestScriptReply(refused, { dir: await tempDir(t) }), refused);
});

test('run_test_script answers with previews and a results file in the results directory', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { success: true, resultSet: true, result: 'q'.repeat(1000) });
  const scriptPath = await writeScript(t, { steps: [{ command: 'execute_code', params: { code: 'x' } }] });

  const response = await handleToolCall({ params: { name: 'run_test_script', arguments: { script: scriptPath } } });
  const payload = JSON.parse(response.content.map((c) => c.text).join('\n'));
  t.after(() => rm(payload.resultsFile, { force: true }));

  assert.equal(path.dirname(testResultsDir()), TEST_RESULTS_SCRATCH);
  assert.equal(path.dirname(payload.resultsFile), testResultsDir());
  assert.match(path.basename(payload.resultsFile), /^script-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
  assert.equal(payload.results[0].truncated, true);
  const saved = JSON.parse(await readFile(payload.resultsFile, 'utf-8'));
  assert.equal(saved.results[0].result.result, 'q'.repeat(1000));
  assert.ok(saved.logs, 'the file carries the logs too');
});

test('a take_screenshot step through the real client reports the path this machine reads', async (t) => {
  startRecording();
  answer = (request, socket) => reply(socket, request.id, { path: 'C:/users/steamuser/shot.png' });
  client.platform = 'linux';
  client.protonPrefix = '/pfx';
  t.after(() => client.resetDetection());
  const scriptPath = await writeScript(t, { steps: [{ command: 'take_screenshot' }] });

  const run = await runTestScript(scriptPath, client);
  assert.equal(run.results[0].result.path, '/pfx/dosdevices/c:/users/steamuser/shot.png');
});

test('a run_test_script cancelled during a step\'s wait sends no later step, runs its cleanup and returns at once', { timeout: 20000 }, async (t) => {
  startRecording();
  const controller = new AbortController();
  answer = (request, socket) => {
    reply(socket, request.id, { success: true });
    if (request.method === 'ping') setTimeout(() => controller.abort(), 100);
  };
  t.after(() => { answer = (request, socket) => reply(socket, request.id, { success: true }); });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'ping', wait: 60000 }, { command: 'game_state' }],
    cleanup: [{ command: 'list_campaigns' }],
  });

  const started = Date.now();
  const response = await handleToolCall(
    { params: { name: 'run_test_script', arguments: { script: scriptPath } } },
    { signal: controller.signal },
  );
  const elapsed = Date.now() - started;
  const payload = JSON.parse(response.content.map((c) => c.text).join('\n'));

  assert.ok(elapsed < 5000, `the run took ${elapsed}ms of a 60s wait`);
  assert.equal(sent('game_state').length, 0, 'a step after the cancel reached the game');
  assert.equal(sent('list_campaigns').length, 1, 'the cleanup did not run');
  assert.equal(payload.passed, false);
  assert.match(payload.cancelled, /the run was cancelled/);
});

test('a run cancelled inside a simulate_input step cancels the plan in the game, and its cleanup still runs', { timeout: 20000 }, async (t) => {
  startRecording();
  setProcReader(fakeProcReader({ 900: { comm: 'Broforce.x86_64', cwd: '/game', startTicks: 100 } }));
  t.after(() => setProcReader(fakeProcReader({})));
  const controller = new AbortController();
  answer = (request, socket) => {
    if (request.method === 'simulate_input') {
      reply(socket, request.id, { pending: true, planId: 21, remainingMs: 5000 });
      setTimeout(() => controller.abort(), 100);
      return;
    }
    reply(socket, request.id, { success: true });
  };
  t.after(() => { answer = (request, socket) => reply(socket, request.id, { success: true }); });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'simulate_input', params: { action: 'right', duration: 30000 } }, { command: 'game_state' }],
    cleanup: [{ command: 'list_campaigns' }],
  });

  const started = Date.now();
  const response = await handleToolCall(
    { params: { name: 'run_test_script', arguments: { script: scriptPath } } },
    { signal: controller.signal },
  );
  const payload = JSON.parse(response.content.map((c) => c.text).join('\n'));

  assert.ok(Date.now() - started < 5000, 'the run waited out the 30s hold');
  assert.deepEqual(sent('cancel_input_plan').map((r) => r.params), [{ planId: 21 }]);
  assert.equal(sent('input_plan').length, 0);
  assert.equal(sent('game_state').length, 0, 'a step after the cancel reached the game');
  assert.equal(sent('list_campaigns').length, 1, 'the cleanup did not run');
  assert.equal(payload.passed, false);
  assert.match(payload.cancelled, /the run was cancelled/);
});

test('a cancelled run\'s cleanup input is polled to its end, not recorded as cancelled', { timeout: 20000 }, async (t) => {
  startRecording();
  const controller = new AbortController();
  answer = (request, socket) => {
    if (request.method === 'simulate_input') return reply(socket, request.id, { pending: true, planId: 'p1', remainingMs: 50 });
    if (request.method === 'input_plan') return reply(socket, request.id, { success: true, framesRead: 3 });
    reply(socket, request.id, { success: true });
    if (request.method === 'ping') setTimeout(() => controller.abort(), 100);
  };
  t.after(() => { answer = (request, socket) => reply(socket, request.id, { success: true }); });
  const scriptPath = await writeScript(t, {
    steps: [{ command: 'ping', wait: 60000 }],
    cleanup: [{ command: 'simulate_input', params: { action: 'fire' } }],
  });

  const response = await handleToolCall(
    { params: { name: 'run_test_script', arguments: { script: scriptPath } } },
    { signal: controller.signal },
  );
  const payload = JSON.parse(response.content.map((c) => c.text).join('\n'));
  t.after(() => rm(payload.resultsFile, { force: true }));
  const saved = JSON.parse(await readFile(payload.resultsFile, 'utf-8'));

  assert.match(payload.cancelled, /the run was cancelled/);
  assert.equal(sent('input_plan').length, 1, 'the cleanup plan was polled to its end');
  assert.equal(saved.cleanup[0].success, true, saved.cleanup[0].error);
  assert.equal(saved.cleanup[0].cancelled, undefined);
  assert.equal(saved.cleanup[0].result.framesRead, 3);
});
