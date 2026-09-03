import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umm-log-test-'));
const logPath = path.join(logDir, 'Log.txt');
await fs.writeFile(logPath, 'first line\nsecond line\n');

// findLogPath() honours this, so watch_log/read_log run against the temp log
process.env.UNITY_INSPECTOR_LOG = logPath;

const { handleToolCall, findLogPath } = await import('../index.js');

function payload(response) {
  const text = response.content.map((c) => c.text).join('\n');
  assert.ok(!response.isError, text);
  return JSON.parse(text);
}

const watchLog = async (args) => payload(await handleToolCall({ params: { name: 'watch_log', arguments: args } }));

async function openFdCount() {
  if (process.platform !== 'linux') return null;
  return (await fs.readdir('/proc/self/fd')).length;
}

test.after(async () => {
  await fs.rm(logDir, { recursive: true, force: true });
});

test('watch_log returns a baseline, then only the new lines', async () => {
  const baseline = await watchLog({});
  assert.equal(baseline.isBaseline, true);

  assert.equal((await watchLog({})).newLines, 0);

  await fs.appendFile(logPath, 'third line\nfourth line\n');
  const delta = await watchLog({});
  assert.equal(delta.newLines, 2);
  assert.match(delta.content, /third line\nfourth line/);
  assert.ok(!delta.truncated);
});

test('watch_log caps a huge delta at 64KB and says so', async () => {
  await watchLog({ reset: true });

  const line = 'x'.repeat(99) + '\n';
  await fs.appendFile(logPath, line.repeat(3000)); // ~300KB

  const delta = await watchLog({});
  assert.equal(delta.truncated, true);
  assert.ok(delta.skippedBytes > 200 * 1024, `skippedBytes was ${delta.skippedBytes}`);
  assert.ok(
    Buffer.byteLength(delta.content) <= 64 * 1024,
    `content was ${Buffer.byteLength(delta.content)} bytes`,
  );
  assert.match(delta.message, /truncated/i);

  // The offset still advanced to the end of the file
  assert.equal((await watchLog({})).newLines, 0);
});

test('watch_log does not leak file descriptors', { skip: process.platform !== 'linux' }, async () => {
  await watchLog({ reset: true });
  await watchLog({});

  const before = await openFdCount();
  for (let i = 0; i < 25; i++) {
    await fs.appendFile(logPath, `iteration ${i}\n`);
    await watchLog({});
  }
  const after = await openFdCount();

  assert.ok(after <= before + 2, `fd count grew from ${before} to ${after}`);
});

test('an explicit UNITY_INSPECTOR_LOG that is missing is reported, not silently replaced', async () => {
  process.env.UNITY_INSPECTOR_LOG = path.join(logDir, 'does-not-exist.txt');
  try {
    const response = await handleToolCall({ params: { name: 'read_log' } });
    assert.equal(response.isError, true);
    const text = response.content.map((c) => c.text).join('\n');
    assert.match(text, /UMM log file not found/);
    assert.match(text, /UNITY_INSPECTOR_LOG/);
    assert.match(text, /does-not-exist\.txt/);
  } finally {
    process.env.UNITY_INSPECTOR_LOG = logPath;
  }
});

test('the log search globs r2modman profiles and prefers the newest', async () => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-home-'));
  const profiles = path.join(fakeHome, '.config/r2modmanPlus-local/Broforce/profiles');

  const write = async (profile, contents, mtime) => {
    const file = path.join(profiles, profile, 'UMM/Core/Log.txt');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    await fs.utimes(file, mtime, mtime);
    return file;
  };

  // Arbitrary names that cannot collide with whatever profile a real game
  // process on this machine was launched from — profile detection must miss
  // and leave the mtime rule in charge
  const stale = await write('Test-Stale-a41f', 'stale profile\n', new Date('2020-01-01T00:00:00Z'));
  await write('Test-Older-a41f', 'older profile\n', new Date('2021-01-01T00:00:00Z'));
  const newest = await write('Test-Newest-a41f', 'newest profile\n', new Date('2024-01-01T00:00:00Z'));

  const savedHome = process.env.HOME;
  const savedOverride = process.env.UNITY_INSPECTOR_LOG;
  process.env.HOME = fakeHome;
  delete process.env.UNITY_INSPECTOR_LOG;

  try {
    const response = await handleToolCall({ params: { name: 'read_log', arguments: { lines: 5 } } });
    const result = payload(response);
    assert.equal(result.path, newest);
    assert.match(result.content, /newest profile/);

    // A detected active profile beats a newer mtime...
    assert.equal(await findLogPath(async () => 'Test-Stale-a41f'), stale);
    // ...but a detected profile with no log on disk falls back to the mtime rule
    assert.equal(await findLogPath(async () => 'Test-Missing-a41f'), newest);
    assert.equal(await findLogPath(async () => null), newest);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedOverride !== undefined) process.env.UNITY_INSPECTOR_LOG = savedOverride;
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});

test('watch_log restarts as a baseline when the resolved log path changes', async () => {
  process.env.UNITY_INSPECTOR_LOG = logPath;
  await watchLog({ reset: true });
  await fs.appendFile(logPath, 'tail on first log\n');
  assert.equal((await watchLog({})).newLines, 1);

  // Same watcher state, different resolved file — a bigger one, so a stale
  // offset would slice old bytes out of its middle as "new"
  const otherLog = path.join(logDir, 'Other.txt');
  await fs.writeFile(otherLog, 'aaaa\n'.repeat(2000) + 'last line of other\n');
  process.env.UNITY_INSPECTOR_LOG = otherLog;
  try {
    const switched = await watchLog({});
    assert.equal(switched.isBaseline, true);
    assert.equal(switched.path, otherLog);
    assert.match(switched.content, /last line of other/);
  } finally {
    process.env.UNITY_INSPECTOR_LOG = logPath;
  }
});

test('the not-found error lists the profile globs it searched', async () => {
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-home-'));
  const savedHome = process.env.HOME;
  const savedOverride = process.env.UNITY_INSPECTOR_LOG;
  process.env.HOME = emptyHome;
  delete process.env.UNITY_INSPECTOR_LOG;

  try {
    const response = await handleToolCall({ params: { name: 'watch_log' } });
    assert.equal(response.isError, true);
    const text = response.content.map((c) => c.text).join('\n');
    assert.match(text, /UMM log file not found/);
    assert.match(text, /profiles\/\*\/UMM\/Core\/Log\.txt/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedOverride !== undefined) process.env.UNITY_INSPECTOR_LOG = savedOverride;
    await fs.rm(emptyHome, { recursive: true, force: true });
  }
});
