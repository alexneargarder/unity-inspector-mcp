import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { startWrapper } from './support/wrapper-harness.js';

const isPosix = process.platform !== 'win32';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listedTools(wrapper) {
  await wrapper.initialize();
  wrapper.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  const reply = await wrapper.waitFor((m) => m.id === 7);
  return reply?.result?.tools?.map((tool) => tool.name) ?? [];
}

test('the wrapper log is private to the user, and a start clears logs and claims nobody wrote for a week, but never a live wrapper\'s, nor a claim whose log is fresh', { timeout: 20000, skip: !isPosix && 'file modes' }, async (t) => {
  const dir = await tempDir(t);
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const plant = async (name, mtime) => {
    await fs.writeFile(path.join(dir, name), 'x');
    if (mtime) await fs.utimes(path.join(dir, name), mtime, mtime);
  };
  // Past any pid_max, so no process holds these pids
  await plant('mcp-wrapper-999999911.log', weekAgo);
  await plant('mcp-wrapper-999999912.log');
  await plant('mcp-wrapper-999999914.claim', weekAgo);
  await plant('mcp-wrapper-999999915.claim');
  await plant('mcp-wrapper-999999916.claim', weekAgo);
  await plant('mcp-wrapper-999999916.log');
  await plant('mcp-wrapper-999999917.claim', weekAgo);
  await plant('mcp-wrapper-999999917.log', weekAgo);
  await plant(`mcp-wrapper-${process.pid}.claim`, weekAgo);
  await plant(`mcp-wrapper-${process.pid}.log`, weekAgo);
  await plant('notes-13.log', weekAgo);

  const logFile = path.join(dir, 'mcp-wrapper-99.log');
  const wrapper = startWrapper({ UNITY_INSPECTOR_MCP_WRAPPER_LOG: logFile });
  t.after(() => wrapper.stop());
  assert.ok((await listedTools(wrapper)).includes('restart_server'));

  assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(dir)).sort(), [
    `mcp-wrapper-${process.pid}.claim`,
    `mcp-wrapper-${process.pid}.log`,
    'mcp-wrapper-99.log',
    'mcp-wrapper-999999912.log',
    'mcp-wrapper-999999915.claim',
    'mcp-wrapper-999999916.claim',
    'mcp-wrapper-999999916.log',
    'notes-13.log',
  ].sort());
});

test('a wrapper whose log cannot be opened still starts its server and lists restart_server', { timeout: 20000 }, async (t) => {
  const dir = await tempDir(t);
  const wrapper = startWrapper({ UNITY_INSPECTOR_MCP_WRAPPER_LOG: path.join(dir, 'missing-dir', 'wrapper.log') });
  t.after(() => wrapper.stop());

  const tools = await listedTools(wrapper);
  assert.ok(tools.includes('restart_server'), JSON.stringify(tools));
  assert.ok(tools.length > 1, 'the server behind the wrapper answered');
});

test('by default the wrapper logs to a private folder in the user\'s state directory, and clears its old logs from /tmp', { timeout: 20000, skip: !isPosix && 'file modes' }, async (t) => {
  const stateHome = await tempDir(t);
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const oldTmpLog = `/tmp/mcp-wrapper-${900000000 + Math.floor(Math.random() * 99999999)}.log`;
  await fs.writeFile(oldTmpLog, 'x');
  await fs.utimes(oldTmpLog, weekAgo, weekAgo);
  t.after(() => fs.rm(oldTmpLog, { force: true }));

  const wrapper = startWrapper({ UNITY_INSPECTOR_MCP_WRAPPER_LOG: '', XDG_STATE_HOME: stateHome });
  t.after(() => wrapper.stop());
  assert.ok((await listedTools(wrapper)).includes('restart_server'));

  const dir = path.join(stateHome, 'unity-inspector-mcp');
  const logFile = path.join(dir, `mcp-wrapper-${wrapper.proc.pid}.log`);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(logFile, 'utf-8'), /Wrapper started/);
  await assert.rejects(fs.stat(oldTmpLog), { code: 'ENOENT' });
});
