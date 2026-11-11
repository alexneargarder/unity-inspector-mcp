import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WRAPPER_CODE_FILES, changedSince, serverCodeFiles } from '../lib/stale-code.js';
import { startWrapper } from './support/wrapper-harness.js';
import { fakeInspector } from './support/stub-launcher.js';
import { commandTimeout } from '../lib/unity-client.js';

const { handleToolCall, unityClient } = await import('../index.js');

const posix = process.platform !== 'win32';
const repo = fileURLToPath(new URL('..', import.meta.url));

const errorNotice = (names) =>
  `The server's code changed on disk after this server started (${names}), so it is running older code than its checkout and can refuse files the newer code wrote. Call restart_server once no other call is running, then repeat this call unless it may already have acted.`;
const successNotice = (names) =>
  `The server's code changed on disk after this server started (${names}), so it is running older code than its checkout. This call ran, so do not repeat it. Call restart_server once no other call is running.`;

function tempDir(t, prefix) {
  // index.js runs its main only when argv[1] is its resolved path, which a symlinked TMPDIR is not
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function codeTree(t) {
  const root = tempDir(t, 'stale-code-');
  mkdirSync(path.join(root, 'lib/nested/deeper'), { recursive: true });
  for (const file of ['index.js', 'wrapper.js', 'lib/a.js', 'lib/nested/deeper/b.js', 'lib/states.json', 'lib/nested/capture.cs']) {
    writeFileSync(path.join(root, file), '');
  }
  return root;
}

const setMtime = (root, file, ms) => utimesSync(path.join(root, file), new Date(ms), new Date(ms));

test('the server code files are index.js, wrapper.js and every .js under lib/, as posix paths, and no data file', (t) => {
  const root = codeTree(t);
  assert.deepEqual(serverCodeFiles(root).sort(), ['index.js', 'lib/a.js', 'lib/nested/deeper/b.js', 'wrapper.js']);
});

test('the wrapper code files are wrapper.js and everything it imports from lib/', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(path.join(repo, file), 'utf8');
    for (const [, target] of source.matchAll(/^import .* from '(\.[^']+)';$/gm)) walk(path.posix.join(path.posix.dirname(file), target));
  };
  walk('wrapper.js');
  assert.deepEqual([...seen].sort(), [...WRAPPER_CODE_FILES].sort());
});

test('changedSince reports a file with a later mtime and a deleted one, and nothing when all are older', (t) => {
  const root = codeTree(t);
  const files = serverCodeFiles(root);
  const start = Date.now();
  for (const file of files) setMtime(root, file, start - 60000);
  assert.deepEqual(changedSince(files, start, root), []);

  setMtime(root, 'lib/nested/deeper/b.js', start + 60000);
  rmSync(path.join(root, 'lib/a.js'));
  assert.deepEqual(changedSince(files, start, root).sort(), ['lib/a.js', 'lib/nested/deeper/b.js']);
});

test('a call whose runCall rejects keeps rejecting', async (t) => {
  t.mock.method(unityClient, 'runCall', () => Promise.reject(new Error('cancelled')));
  await assert.rejects(handleToolCall({ params: { name: 'list_scripts', arguments: {} } }), /^Error: cancelled$/);
});

async function copiedServer(t, env = {}) {
  const copy = tempDir(t, 'stale-server-');
  for (const entry of ['index.js', 'wrapper.js', 'lib', 'package.json']) {
    cpSync(path.join(repo, entry), path.join(copy, entry), { recursive: true });
  }
  const sdk = fileURLToPath(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'));
  symlinkSync(sdk.slice(0, sdk.lastIndexOf(`${path.sep}@modelcontextprotocol`)), path.join(copy, 'node_modules'));

  const w = startWrapper({ UNITY_INSPECTOR_MCP_CHILD: path.join(copy, 'index.js'), UNITY_INSPECTOR_LOG: path.join(copy, 'Player.log'), ...env });
  t.after(() => w.stop());
  assert.ok(await w.initialize(0), 'the copied server never answered initialize');

  let nextId = 1;
  const call = async (name, args = {}) => {
    const id = nextId++;
    w.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return (await w.waitFor((m) => m.id === id, 15000)).result;
  };
  const makeStale = () => {
    const now = new Date();
    utimesSync(path.join(copy, 'lib/log-delta.js'), now, now);
  };
  return { copy, call, makeStale };
}

test('a reply carries the notice once server code changes, a run_test_script step never does, and restart_server clears it', { timeout: 60000, skip: !posix }, async (t) => {
  const { copy, call, makeStale } = await copiedServer(t);
  const script = path.join(copy, 'one-step.json');
  writeFileSync(script, JSON.stringify({ steps: [{ command: 'ping' }] }));

  const success = await call('list_scripts');
  const refused = await call('list_scripts', { stray: 1 });
  assert.equal(success.content.length, 1);
  assert.equal(success.isError, undefined);
  assert.equal(refused.content.length, 1);
  assert.equal(refused.isError, true);

  makeStale();
  const notices = {
    success: { type: 'text', text: successNotice('lib/log-delta.js') },
    error: { type: 'text', text: errorNotice('lib/log-delta.js') },
  };

  const staleSuccess = await call('list_scripts');
  assert.deepEqual(staleSuccess.content, [success.content[0], notices.success]);
  assert.equal(staleSuccess.isError, undefined);

  const staleRefused = await call('list_scripts', { stray: 1 });
  assert.deepEqual(staleRefused.content, [refused.content[0], notices.error]);
  assert.equal(staleRefused.isError, true);

  const run = await call('run_test_script', { script });
  assert.equal(run.content.length, 2);
  assert.deepEqual(run.content[1], run.isError ? notices.error : notices.success);
  const runReply = JSON.parse(run.content[0].text);
  assert.equal(runReply.results[0].command, 'ping');
  assert.doesNotMatch(run.content[0].text, /code changed on disk/);
  assert.doesNotMatch(readFileSync(runReply.resultsFile, 'utf8'), /code changed on disk/);

  assert.match((await call('restart_server')).content[0].text, /"success":true/);
  assert.deepEqual((await call('list_scripts')).content, success.content);
});

test("a timed-out call's reply on a stale server keeps its error and says to repeat it only if it has not acted", { timeout: 60000, skip: !posix }, async (t) => {
  const silent = await fakeInspector({ answers: false });
  t.after(() => silent.close());
  const { call, makeStale } = await copiedServer(t, { UNITY_INSPECTOR_PORT: String(silent.port) });
  makeStale();

  const timedOut = await call('ping');

  assert.equal(timedOut.isError, true);
  assert.deepEqual(timedOut.content, [
    { type: 'text', text: `Error: Command timeout after ${commandTimeout('ping')}ms — the game may still carry the command out` },
    { type: 'text', text: errorNotice('lib/log-delta.js') },
  ]);
});
