import './support/session.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { startWrapper } from './support/wrapper-harness.js';
import { writeStubLauncher } from './support/stub-launcher.js';

const isLinux = process.platform === 'linux';
const SESSION = 'wrapper-session-3ae2';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-stderr-'));
const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-stderr-bin-'));
const launcher = await writeStubLauncher(binDir, root);

test.after(() => fs.rm(root, { recursive: true, force: true }));
test.after(() => fs.rm(binDir, { recursive: true, force: true }));

const instanceDir = path.join(root, SESSION);
const ownerFile = path.join(instanceDir, 'owner.pid');
const callsLog = path.join(root, 'calls.log');
const STOP_CALL = `instance ${SESSION} stop`;

const wrapperEnv = {
  CLAUDE_SESSION_ID: SESSION,
  BROFORCE_INSTANCE_CMD: launcher,
  UNITY_INSPECTOR_MCP_STOP_WAIT_MS: '600',
};

async function launcherCalls() {
  try {
    return (await fs.readFile(callsLog, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// The server writes owner.pid and records where it wrote it in the file the wrapper named
async function claimFor(w) {
  const stat = readFileSync(`/proc/${w.proc.pid}/stat`, 'utf8');
  await fs.mkdir(instanceDir, { recursive: true });
  await fs.writeFile(ownerFile, `${w.proc.pid} ${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}\n`);
  await fs.writeFile(w.claimFile, `${ownerFile}\n`);
}

const exited = (w) => new Promise((resolve) => w.proc.on('exit', (code) => resolve(code)));

// A client that has exited leaves nothing reading the wrapper's streams, and the wrapper has to
// write to one while it is still running for the broken pipe to be discovered at all: a child dying
// is one such thing — it logs and it notifies the client — and the stub child is killed here to
// make the moment deterministic
async function breakStreamsAndWrite(w, { stdout = false } = {}) {
  w.proc.stderr.destroy();
  if (stdout) w.proc.stdout.destroy();
  const pids = w.childPids();
  assert.ok(pids.length > 0, 'the wrapper had no child to kill');
  for (const pid of pids) process.kill(Number(pid), 'SIGKILL');
  await w.sleep(400);
}

// One line per stream saying it is gone is the whole of what a broken pipe may cost
async function assertQuietLog(w, trigger, brokenStreams = 1) {
  const log = await fs.readFile(w.logFile, 'utf8');
  assert.match(log, new RegExp(`Stopped instance ${SESSION}, \\d+ms after ${trigger}`));
  assert.match(log, new RegExp(`Wrapper exiting, \\d+ms after ${trigger}`));
  assert.doesNotMatch(log, /Uncaught exception/, 'a write to a dead stream was raised instead of dropped');
  const broken = log.split('\n').filter((line) => line.includes('EPIPE'));
  assert.ok(broken.length <= brokenStreams, `the log carries ${broken.length} broken-pipe lines`);
  const { size } = await fs.stat(w.logFile);
  assert.ok(size < 20 * 1024, `the log grew to ${size} bytes`);
}

beforeEach(async () => {
  await fs.rm(callsLog, { force: true });
  await fs.rm(instanceDir, { recursive: true, force: true });
});

test('a wrapper whose stderr died with its parent still stops the instance on stdin end', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);
  await breakStreamsAndWrite(w);

  const done = exited(w);
  const started = Date.now();
  w.proc.stdin.end();
  const code = await done;
  const elapsed = Date.now() - started;
  assert.ok(await w.waitForReaper(), 'the reaper never finished');

  assert.equal(code, 0);
  assert.ok(elapsed < 1500, `the wrapper took ${elapsed}ms to exit`);
  assert.deepEqual((await launcherCalls()).filter((call) => call === STOP_CALL), [STOP_CALL]);
  await assertQuietLog(w, 'stdin end');
});

test('a wrapper whose stderr died with its parent still stops the instance on SIGTERM', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);
  await breakStreamsAndWrite(w);

  const done = exited(w);
  const started = Date.now();
  w.proc.kill('SIGTERM');
  const code = await done;
  const elapsed = Date.now() - started;
  assert.ok(await w.waitForReaper(), 'the reaper never finished');

  assert.equal(code, 0);
  assert.ok(elapsed < 1500, `the wrapper took ${elapsed}ms to exit`);
  assert.deepEqual((await launcherCalls()).filter((call) => call === STOP_CALL), [STOP_CALL]);
  await assertQuietLog(w, 'SIGTERM');
});

test('a wrapper whose parent took both streams with it still stops the instance and exits', { timeout: 20000, skip: !isLinux }, async (t) => {
  const w = startWrapper(wrapperEnv);
  t.after(() => w.stop());
  await w.initialize(0);
  await claimFor(w);
  // The shape of a real session end: the client is gone and neither of its pipes is read again
  await breakStreamsAndWrite(w, { stdout: true });

  const done = exited(w);
  const started = Date.now();
  w.proc.stdin.end();
  const code = await done;
  const elapsed = Date.now() - started;
  assert.ok(await w.waitForReaper(), 'the reaper never finished');

  assert.equal(code, 0);
  assert.ok(elapsed < 1500, `the wrapper took ${elapsed}ms to exit`);
  assert.deepEqual((await launcherCalls()).filter((call) => call === STOP_CALL), [STOP_CALL]);
  await assertQuietLog(w, 'stdin end', 2);
  const log = await fs.readFile(w.logFile, 'utf8');
  assert.match(log, /Parent's stdout is gone/, 'a mute wrapper left nothing in its log saying why');
  assert.match(log, /Parent's stderr is gone/);
});
