import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umm-log-test-'));
const logPath = path.join(logDir, 'Log.txt');
await fs.writeFile(logPath, 'first line\nsecond line\n');

process.env.UNITY_INSPECTOR_LOG = logPath;

const { handleToolCall, findLogPath, logFileInfo, resetPlatformDetection, resolveLogFile } = await import('../index.js');

// os.homedir() reads the registry on Windows, so a fake HOME proves nothing there
const fakeHomeWorks = { skip: process.platform === 'win32' && 'HOME is not honoured on Windows' };

async function withFakeHome(run) {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-home-'));
  const profiles = path.join(fakeHome, '.config/r2modmanPlus-local/Broforce/profiles');
  const playerLog = path.join(fakeHome, '.config/unity3d/Free Lives/Broforce/Player.log');

  const write = async (file, contents, mtime) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    if (mtime) await fs.utimes(file, mtime, mtime);
    return file;
  };

  // APPDATA and USERPROFILE add real candidate roots outside the fake HOME
  const saved = {
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
    USERPROFILE: process.env.USERPROFILE,
    UNITY_INSPECTOR_LOG: process.env.UNITY_INSPECTOR_LOG,
  };
  process.env.HOME = fakeHome;
  delete process.env.APPDATA;
  delete process.env.USERPROFILE;
  delete process.env.UNITY_INSPECTOR_LOG;
  // Platform detection caches paths off the real HOME, so without this the candidate set depends on test order
  resetPlatformDetection();

  try {
    return await run({
      profileLog: (profile, contents, mtime) =>
        write(path.join(profiles, profile, 'UMM/Core/Log.txt'), contents, mtime),
      writePlayerLog: (contents, mtime) => write(playerLog, contents, mtime),
      playerLogPath: playerLog,
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPlatformDetection();
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
}

const noGameStart = async () => null;

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

  const quiet = await watchLog({});
  assert.equal(quiet.newLines, 0);
  assert.equal(quiet.isBaseline, false);

  await fs.appendFile(logPath, 'third line\nfourth line\n');
  const delta = await watchLog({});
  assert.equal(delta.newLines, 2);
  assert.equal(delta.isBaseline, false);
  assert.match(delta.content, /third line\nfourth line/);
  assert.ok(!delta.truncated);
});

test('a reset reports itself as a baseline restart', async () => {
  const reset = await watchLog({ reset: true });
  assert.equal(reset.isBaseline, true);
  assert.equal(reset.path, logPath);
  assert.equal(reset.fileSize, (await fs.stat(logPath)).size);

  assert.equal((await watchLog({})).newLines, 0);
});

test('watch_log caps a huge delta at 64KB and says so', async () => {
  await watchLog({ reset: true });

  const line = 'x'.repeat(99) + '\n';
  await fs.appendFile(logPath, line.repeat(3000));

  const delta = await watchLog({});
  assert.equal(delta.truncated, true);
  assert.ok(delta.skippedBytes > 200 * 1024, `skippedBytes was ${delta.skippedBytes}`);
  assert.ok(
    Buffer.byteLength(delta.content) <= 64 * 1024,
    `content was ${Buffer.byteLength(delta.content)} bytes`,
  );
  assert.match(delta.message, /truncated/i);

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

test('the log search globs r2modman profiles and prefers the newest', fakeHomeWorks, async () => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-home-'));
  const profiles = path.join(fakeHome, '.config/r2modmanPlus-local/Broforce/profiles');

  const write = async (profile, contents, mtime) => {
    const file = path.join(profiles, profile, 'UMM/Core/Log.txt');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    await fs.utimes(file, mtime, mtime);
    return file;
  };

  // Names that cannot collide with a real game process's profile, so detection misses and mtime decides
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

    assert.equal(await findLogPath(async () => 'Test-Stale-a41f', noGameStart), stale);
    assert.equal(await findLogPath(async () => 'Test-Missing-a41f', noGameStart), newest);
    assert.equal(await findLogPath(async () => null, noGameStart), newest);
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

test('an active profile with no UMM log falls back to the Unity player log', fakeHomeWorks, async () => {
  await withFakeHome(async ({ profileLog, writePlayerLog, playerLogPath }) => {
    await profileLog('Test-Dead-8c02', 'dead profile\n', new Date('2020-01-01T00:00:00Z'));
    await writePlayerLog('player log\n', new Date('2024-06-01T00:00:00Z'));

    const resolved = await resolveLogFile(async () => 'Test-Live-8c02', noGameStart);
    assert.equal(resolved.path, playerLogPath);
    assert.equal(resolved.stale, false);
    assert.match(resolved.modifiedAt, /^2024-06-01T/);
  });
});

test("an active profile's own UMM log beats the player log once a start time exists", fakeHomeWorks, async () => {
  await withFakeHome(async ({ profileLog, writePlayerLog, playerLogPath }) => {
    const live = await profileLog('Test-Live-8c02', 'live profile\n', new Date('2024-01-01T00:00:00Z'));
    await writePlayerLog('player log\n', new Date('2024-06-01T00:00:00Z'));

    const startedAt = Date.parse('2023-01-01T00:00:00Z');
    assert.equal(await findLogPath(async () => 'Test-Live-8c02', async () => startedAt), live);

    assert.equal(await findLogPath(async () => 'Test-Live-8c02', noGameStart), playerLogPath);
  });
});

test('with no profile resolved the newest candidate wins, player log included', fakeHomeWorks, async () => {
  await withFakeHome(async ({ profileLog, writePlayerLog, playerLogPath }) => {
    await profileLog('Test-Old-8c02', 'old profile\n', new Date('2021-01-01T00:00:00Z'));
    const newestProfile = await profileLog('Test-New-8c02', 'newer profile\n', new Date('2024-01-01T00:00:00Z'));
    await writePlayerLog('player log\n', new Date('2024-06-01T00:00:00Z'));

    assert.equal(await findLogPath(async () => null, noGameStart), playerLogPath);

    await fs.utimes(playerLogPath, new Date('2019-01-01T00:00:00Z'), new Date('2019-01-01T00:00:00Z'));
    assert.equal(await findLogPath(async () => null, noGameStart), newestProfile);
  });
});

test('a log older than the running game is reported as stale, never served silently', fakeHomeWorks, async () => {
  await withFakeHome(async ({ writePlayerLog, playerLogPath }) => {
    await writePlayerLog('from a previous run\n', new Date('2024-06-01T00:00:00Z'));
    const logMtime = Date.parse('2024-06-01T00:00:00Z');

    const startedAfter = await resolveLogFile(async () => null, async () => logMtime + 60000);
    assert.equal(startedAfter.path, playerLogPath);
    assert.equal(startedAfter.stale, true);
    assert.match(startedAfter.warning, new RegExp(playerLogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(startedAfter.warning, /not writing to it/);

    const startedBefore = await resolveLogFile(async () => null, async () => logMtime - 60000);
    assert.equal(startedBefore.stale, false);
    assert.equal(startedBefore.warning, undefined);

    assert.equal((await resolveLogFile(async () => null, noGameStart)).stale, false);
  });
});

test('a leftover profile log from an older install loses to the live player log', fakeHomeWorks, async () => {
  await withFakeHome(async ({ profileLog, writePlayerLog, playerLogPath }) => {
    await profileLog('Test-Live-8c02', 'from an old install\n', new Date('2026-04-01T00:00:00Z'));
    await writePlayerLog('live output\n', new Date());
    const startedAt = Date.now() - 60000;

    const resolved = await resolveLogFile(async () => 'Test-Live-8c02', async () => startedAt);
    assert.equal(resolved.path, playerLogPath);
    assert.equal(resolved.stale, false);
  });
});

test('when nothing has been written since the game started, the newest is served and flagged', fakeHomeWorks, async () => {
  await withFakeHome(async ({ profileLog, writePlayerLog }) => {
    const profilePath = await profileLog('Test-Live-8c02', 'old install\n', new Date('2026-04-01T00:00:00Z'));
    await writePlayerLog('older still\n', new Date('2026-01-01T00:00:00Z'));

    const resolved = await resolveLogFile(async () => 'Test-Live-8c02', async () => Date.now());
    assert.equal(resolved.path, profilePath, 'the newest of the stale candidates');
    assert.equal(resolved.stale, true);
    assert.match(resolved.warning, /not writing to it/);
  });
});

test('a log within the start-time tolerance is not called stale', fakeHomeWorks, async () => {
  await withFakeHome(async ({ writePlayerLog }) => {
    const now = Date.now();
    await writePlayerLog('written a beat before the process was seen\n', new Date(now - 1000));
    // etimes rounds to whole seconds, so the start can land after the write
    const resolved = await resolveLogFile(async () => null, async () => now);
    assert.equal(resolved.stale, false);
  });
});

test('a stale resolution reaches the response through logFileInfo', fakeHomeWorks, async () => {
  await withFakeHome(async ({ writePlayerLog, playerLogPath }) => {
    const mtime = Date.parse('2026-01-01T00:00:00Z');
    await writePlayerLog('from a previous run\n', new Date(mtime));

    const stale = logFileInfo(await resolveLogFile(async () => null, async () => mtime + 60000));
    assert.equal(stale.path, playerLogPath);
    assert.equal(stale.stale, true);
    assert.match(stale.warning, /not writing to it/);
    assert.ok(stale.modifiedAt);

    const fresh = logFileInfo(await resolveLogFile(async () => null, async () => mtime - 60000));
    assert.ok(!('stale' in fresh), 'a current log must not carry a stale key');
    assert.ok(!('warning' in fresh), 'a current log must not carry a warning');
  });
});

test('the Windows layout offers output_log.txt as well as Player.log', fakeHomeWorks, async () => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-winhome-'));
  const outputLog = path.join(fakeHome, 'AppData/LocalLow/Free Lives/Broforce/output_log.txt');
  await fs.mkdir(path.dirname(outputLog), { recursive: true });
  await fs.writeFile(outputLog, 'unity 2017 output log\n');

  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, UNITY_INSPECTOR_LOG: process.env.UNITY_INSPECTOR_LOG };
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-home-'));
  process.env.HOME = emptyHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.APPDATA;
  delete process.env.UNITY_INSPECTOR_LOG;

  try {
    assert.equal(await findLogPath(async () => null, noGameStart), outputLog);
    assert.equal(await findLogPath(async () => 'Test-Live-8c02', noGameStart), outputLog);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(emptyHome, { recursive: true, force: true });
  }
});

test('watch_log restarts as a baseline when the log is rotated behind the same path', async () => {
  const rotating = path.join(logDir, 'Rotating.log');
  await fs.writeFile(rotating, 'run one line\n');

  process.env.UNITY_INSPECTOR_LOG = rotating;
  try {
    assert.equal((await watchLog({})).isBaseline, true);
    await fs.appendFile(rotating, 'more of run one\n');
    assert.equal((await watchLog({})).newLines, 1);

    await fs.rename(rotating, path.join(logDir, 'Rotating-prev.log'));
    await fs.writeFile(rotating, '[Manager] starting up\n'.repeat(40));

    const afterRotation = await watchLog({});
    assert.equal(afterRotation.isBaseline, true, 'rotation must restart the watch');
    assert.match(afterRotation.content, /\[Manager\] starting up/);
  } finally {
    process.env.UNITY_INSPECTOR_LOG = logPath;
  }
});

test('an override that is stale says to unset or repoint it, not to set it', async () => {
  const overrideLog = path.join(logDir, 'Override.log');
  await fs.writeFile(overrideLog, 'from a previous run\n');
  const mtime = new Date('2026-01-01T00:00:00Z');
  await fs.utimes(overrideLog, mtime, mtime);

  process.env.UNITY_INSPECTOR_LOG = overrideLog;
  try {
    const resolved = await resolveLogFile(async () => null, async () => Date.now());
    assert.equal(resolved.path, overrideLog);
    assert.equal(resolved.stale, true);
    assert.match(resolved.warning, /UNITY_INSPECTOR_LOG selected this file/);
    assert.match(resolved.warning, /unset it|repoint it/);
    assert.doesNotMatch(resolved.warning, /set UNITY_INSPECTOR_LOG if/);
  } finally {
    process.env.UNITY_INSPECTOR_LOG = logPath;
  }
});

test('an override is never filtered out by the freshness cutoff', async () => {
  const overrideLog = path.join(logDir, 'Ancient.log');
  await fs.writeFile(overrideLog, 'ancient\n');
  const mtime = new Date('2019-01-01T00:00:00Z');
  await fs.utimes(overrideLog, mtime, mtime);

  process.env.UNITY_INSPECTOR_LOG = overrideLog;
  try {
    const resolved = await resolveLogFile(async () => 'Test-Live-8c02', async () => Date.now());
    assert.equal(resolved.path, overrideLog);
    assert.equal(resolved.stale, true);
  } finally {
    process.env.UNITY_INSPECTOR_LOG = logPath;
  }
});

test('read_log reports the file it read and when it was last written', async () => {
  const result = payload(await handleToolCall({ params: { name: 'read_log', arguments: { lines: 2 } } }));
  assert.equal(result.path, logPath);
  assert.match(result.modifiedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  const drift = Math.abs(Date.parse(result.modifiedAt) - (await fs.stat(logPath)).mtimeMs);
  assert.ok(drift < 1000, `modifiedAt is ${drift}ms off the file's mtime`);
});

test('the not-found error lists the profile globs it searched', fakeHomeWorks, async () => {
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
    assert.match(text, /unity3d\/Free Lives\/Broforce\/Player\.log/);
    assert.match(text, /AppData\/LocalLow\/Free Lives\/Broforce\/Player\.log/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedOverride !== undefined) process.env.UNITY_INSPECTOR_LOG = savedOverride;
    await fs.rm(emptyHome, { recursive: true, force: true });
  }
});
