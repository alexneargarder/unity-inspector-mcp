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

const readNew = async (args) => payload(await handleToolCall({ params: { name: 'read_log', arguments: { onlyNew: true, ...args } } }));

async function openFdCount() {
  if (process.platform !== 'linux') return null;
  return (await fs.readdir('/proc/self/fd')).length;
}

test.after(async () => {
  await fs.rm(logDir, { recursive: true, force: true });
});

test('read_log with onlyNew returns a baseline, then only the new lines', async () => {
  const baseline = await readNew({});
  assert.equal(baseline.isBaseline, true);

  const quiet = await readNew({});
  assert.equal(quiet.newLines, 0);
  assert.equal(quiet.isBaseline, false);

  await fs.appendFile(logPath, 'third line\nfourth line\n');
  const delta = await readNew({});
  assert.equal(delta.newLines, 2);
  assert.equal(delta.isBaseline, false);
  assert.match(delta.content, /third line\nfourth line/);
  assert.ok(!delta.truncated);
});

test('a reset reports itself as a baseline restart', async () => {
  const reset = await readNew({ reset: true });
  assert.equal(reset.isBaseline, true);
  assert.equal(reset.path, logPath);
  assert.equal(reset.fileSize, (await fs.stat(logPath)).size);

  assert.equal((await readNew({})).newLines, 0);
});

test('read_log with onlyNew caps a huge delta at 64KB and says so', async () => {
  await readNew({ reset: true });

  const line = 'x'.repeat(99) + '\n';
  await fs.appendFile(logPath, line.repeat(3000));

  const delta = await readNew({});
  assert.equal(delta.truncated, true);
  assert.ok(delta.skippedBytes > 200 * 1024, `skippedBytes was ${delta.skippedBytes}`);
  assert.ok(
    Buffer.byteLength(delta.content) <= 64 * 1024,
    `content was ${Buffer.byteLength(delta.content)} bytes`,
  );
  assert.match(delta.message, /truncated/i);

  assert.equal((await readNew({})).newLines, 0);
});

test('read_log with onlyNew does not leak file descriptors', { skip: process.platform !== 'linux' }, async () => {
  await readNew({ reset: true });
  await readNew({});

  const before = await openFdCount();
  for (let i = 0; i < 25; i++) {
    await fs.appendFile(logPath, `iteration ${i}\n`);
    await readNew({});
  }
  const after = await openFdCount();

  assert.ok(after <= before + 2, `fd count grew from ${before} to ${after}`);
});

test('read_log refuses onlyNew with lines or filter, and reset without onlyNew', async () => {
  const refused = async (args) => {
    const response = await handleToolCall({ params: { name: 'read_log', arguments: args } });
    assert.equal(response.isError, true, JSON.stringify(args));
    return response.content.map((c) => c.text).join('\n');
  };

  assert.match(await refused({ onlyNew: true, lines: 5 }), /onlyNew .*neither lines nor filter/);
  assert.match(await refused({ onlyNew: true, filter: 'x' }), /onlyNew .*neither lines nor filter/);
  assert.match(await refused({ reset: true }), /reset .*needs onlyNew/);
  assert.match(await refused({ reset: true, lines: 5 }), /reset .*needs onlyNew/);

  await readNew({ reset: true });
  await fs.appendFile(logPath, 'after the refusals\n');
  await handleToolCall({ params: { name: 'read_log', arguments: { onlyNew: true, lines: 5 } } });
  assert.equal((await readNew({})).newLines, 1, 'a refused call does not move the position');

  const plain = payload(await handleToolCall({ params: { name: 'read_log', arguments: { reset: false, onlyNew: false, lines: 1 } } }));
  assert.equal(plain.returnedLines, 1, 'false flags are the plain read');
});

test('an explicit UNITY_INSPECTOR_LOG that is missing is reported, not silently replaced', async () => {
  process.env.UNITY_INSPECTOR_LOG = path.join(logDir, 'does-not-exist.txt');
  try {
    const response = await handleToolCall({ params: { name: 'read_log' } });
    assert.equal(response.isError, true);
    const text = response.content.map((c) => c.text).join('\n');
    assert.match(text, /Log file not found/);
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

test('read_log with onlyNew restarts as a baseline when the resolved log path changes', async () => {
  process.env.UNITY_INSPECTOR_LOG = logPath;
  await readNew({ reset: true });
  await fs.appendFile(logPath, 'tail on first log\n');
  assert.equal((await readNew({})).newLines, 1);

  const otherLog = path.join(logDir, 'Other.txt');
  await fs.writeFile(otherLog, 'aaaa\n'.repeat(2000) + 'last line of other\n');
  process.env.UNITY_INSPECTOR_LOG = otherLog;
  try {
    const switched = await readNew({});
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

test("the player log beats an active profile's UMM log the game also writes, whichever was written last", fakeHomeWorks, async () => {
  await withFakeHome(async ({ profileLog, writePlayerLog, playerLogPath }) => {
    const live = await profileLog('Test-Live-8c02', 'live profile\n', new Date('2024-06-01T00:00:30Z'));
    await writePlayerLog('player log\n', new Date('2024-06-01T00:00:00Z'));

    const startedAt = Date.parse('2024-05-01T00:00:00Z');
    assert.equal(await findLogPath(async () => 'Test-Live-8c02', async () => startedAt), playerLogPath);
    assert.equal(await findLogPath(async () => 'Test-Live-8c02', noGameStart), playerLogPath, 'a UMM log flushed just after the player log');

    await fs.utimes(playerLogPath, new Date('2024-04-01T00:00:00Z'), new Date('2024-04-01T00:00:00Z'));
    assert.equal(await findLogPath(async () => 'Test-Live-8c02', async () => startedAt), live, 'a player log this run never wrote gives way');
  });
});

test('with no profile resolved, the player log is read while both are live, never the newer of the two', fakeHomeWorks, async () => {
  await withFakeHome(async ({ profileLog, writePlayerLog, playerLogPath }) => {
    await profileLog('Test-Some-8c02', 'batched\n', new Date('2024-06-01T00:00:10Z'));
    await writePlayerLog('every line\n', new Date('2024-06-01T00:00:05Z'));

    const startedAt = Date.parse('2024-06-01T00:00:00Z');
    assert.equal(await findLogPath(async () => null, async () => startedAt), playerLogPath);
    assert.equal(await findLogPath(async () => null, noGameStart), playerLogPath);
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

test('read_log with onlyNew restarts as a baseline when the log is rotated behind the same path', async () => {
  const rotating = path.join(logDir, 'Rotating.log');
  await fs.writeFile(rotating, 'run one line\n');

  process.env.UNITY_INSPECTOR_LOG = rotating;
  try {
    assert.equal((await readNew({})).isBaseline, true);
    await fs.appendFile(rotating, 'more of run one\n');
    assert.equal((await readNew({})).newLines, 1);

    await fs.rename(rotating, path.join(logDir, 'Rotating-prev.log'));
    await fs.writeFile(rotating, '[Manager] starting up\n'.repeat(40));

    const afterRotation = await readNew({});
    assert.equal(afterRotation.isBaseline, true, 'rotation must restart the baseline');
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
    const response = await handleToolCall({ params: { name: 'read_log', arguments: { onlyNew: true } } });
    assert.equal(response.isError, true);
    const text = response.content.map((c) => c.text).join('\n');
    assert.match(text, /Log file not found/);
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

import fsDefault from 'fs/promises';

async function withLog(t, contents) {
  const file = path.join(logDir, `case-${Math.random().toString(36).slice(2)}.log`);
  await fs.writeFile(file, contents);
  process.env.UNITY_INSPECTOR_LOG = file;
  t.after(() => { process.env.UNITY_INSPECTOR_LOG = logPath; });
  return file;
}

const numbered = (count, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
const readLog = async (args) => payload(await handleToolCall({ params: { name: 'read_log', arguments: args } }));

test('read_log returns the last 50 lines by default, the trailing newline starting none', async (t) => {
  const file = await withLog(t, numbered(80));
  const result = await readLog({});
  assert.equal(result.path, file);
  assert.equal(result.returnedLines, 50);
  assert.equal(result.content.split('\n')[0], 'line 31');
  assert.ok(result.content.endsWith('line 80'));
  assert.equal(result.truncated, undefined);
  assert.equal(typeof result.modifiedAt, 'string');
  assert.notEqual(result.stale, true);
});

test('read_log refuses a line count that is not a whole number of at least 1', async (t) => {
  await withLog(t, numbered(10));
  assert.deepEqual((await readLog({ lines: 3 })).content.split('\n'), ['line 8', 'line 9', 'line 10']);
  assert.equal((await readLog({ lines: 1000 })).returnedLines, 10);

  const refusal = async (lines) => {
    const response = await handleToolCall({ params: { name: 'read_log', arguments: { lines } } });
    assert.equal(response.isError, true, JSON.stringify(lines));
    return response.content[0].text;
  };
  for (const lines of [0, -4]) {
    assert.match(await refusal(lines), /lines must be a whole number of at least 1/);
  }
  assert.match(await refusal(2.9), /read_log: lines must be an integer, got 2\.9/);
  assert.match(await refusal('lots'), /read_log: lines must be an integer, got "lots"/);
});

test('read_log filters case-insensitively and then takes the last lines of the matches', async (t) => {
  await withLog(t, '[Mod] loaded\nother\n[MOD] patched\nnoise\n[mod] ready\n');

  const all = await readLog({ filter: '[mod]' });
  assert.equal(all.content, '[Mod] loaded\n[MOD] patched\n[mod] ready');
  assert.equal(all.returnedLines, 3);

  assert.equal((await readLog({ filter: '[mod]', lines: 2 })).content, '[MOD] patched\n[mod] ready');

  const none = await readLog({ filter: 'nothing like this' });
  assert.equal(none.content, '');
  assert.equal(none.returnedLines, 0);
});

test('read_log refuses a filter that is not a string, and reads a null one as no filter', async (t) => {
  await withLog(t, numbered(3));

  for (const [filter, sent] of [[5, '5'], [['mod'], 'an array'], [{ text: 'mod' }, 'an object'], [true, 'true']]) {
    const response = await handleToolCall({ params: { name: 'read_log', arguments: { filter } } });
    assert.equal(response.isError, true, JSON.stringify(filter));
    assert.equal(response.content[0].text, `Error: read_log: filter must be a string, got ${sent}`);
  }

  assert.equal((await readLog({ filter: null })).returnedLines, 3);
});

test('read_log caps its text at 64KB, keeping the newest lines and saying how many it dropped', async (t) => {
  await withLog(t, numbered(1433, 'x'.repeat(95)));

  const result = await readLog({ lines: 1433 });
  assert.ok(Buffer.byteLength(result.content) <= 64 * 1024, `content was ${Buffer.byteLength(result.content)} bytes`);
  assert.equal(result.truncated, true);
  assert.equal(result.returnedLines + result.droppedLines, 1433);
  assert.ok(result.droppedLines > 0);
  assert.ok(result.content.endsWith(`${'x'.repeat(95)} 1433`), 'the newest line is kept');
  assert.equal(result.content.split('\n').length, result.returnedLines);
  assert.match(result.message, new RegExp(`${result.droppedLines} earlier lines dropped`));

  const small = await readLog({ lines: 10 });
  assert.equal(small.truncated, undefined, 'a reply under the cap is not flagged');
});

test('read_log keeps the end of a single line longer than the cap', async (t) => {
  const huge = 'é'.repeat(40 * 1024) + 'END';
  await withLog(t, `before\n${huge}\n`);

  const result = await readLog({ lines: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.returnedLines, 1);
  assert.equal(result.droppedLines, 1);
  assert.match(result.message, /the newest line is cut to its last 65536 bytes, and 1 earlier line dropped/);

  const alone = await readLog({ lines: 1 });
  assert.equal(alone.droppedLines, 0);
  assert.match(alone.message, /the newest line is cut to its last 65536 bytes\./);
  assert.doesNotMatch(alone.message, /dropped/);
  assert.ok(Buffer.byteLength(result.content) <= 64 * 1024);
  assert.ok(result.content.endsWith('END'));
  assert.doesNotMatch(result.content, /�/, 'the cut never splits a character');
});

test('read_log looks the log up again when it vanishes under it, with and without onlyNew', async (t) => {
  const file = await withLog(t, numbered(3));
  const original = { open: fsDefault.open, stat: fsDefault.stat };
  t.after(() => Object.assign(fsDefault, original));

  const vanishOnce = (method, nth) => {
    let calls = 0;
    let vanished = false;
    fsDefault[method] = async (target, ...rest) => {
      if (target === file && ++calls === nth) {
        vanished = true;
        throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
      }
      return original[method](target, ...rest);
    };
    return () => vanished;
  };

  const readVanished = vanishOnce('open', 1);
  assert.equal((await readLog({})).content, 'line 1\nline 2\nline 3');
  assert.ok(readVanished(), 'the read never hit the vanished file');

  const statVanished = vanishOnce('stat', 2);
  assert.equal((await readNew({})).isBaseline, true);
  assert.ok(statVanished(), 'the onlyNew read never hit the vanished file');
});

test('read_log with onlyNew starts with the last 20 lines of the log', async (t) => {
  await withLog(t, numbered(30));
  const baseline = await readNew({});
  assert.equal(baseline.isBaseline, true);
  assert.equal(baseline.newLines, 20);
  assert.equal(baseline.content.split('\n')[0], 'line 11');
  assert.ok(baseline.content.endsWith('line 30'));
});

test('read_log with onlyNew restarts as a baseline when the log is truncated in place', async (t) => {
  const file = await withLog(t, numbered(30));
  await readNew({});
  const { ino } = await fs.stat(file);

  await fs.writeFile(file, 'fresh start\n');
  assert.equal((await fs.stat(file)).ino, ino, 'the file was truncated, not replaced');

  const after = await readNew({});
  assert.equal(after.isBaseline, true);
  assert.equal(after.content, 'fresh start');
});

test('read_log with onlyNew restarts as a baseline when the game rewrote the log in place past the old position', async (t) => {
  const file = await withLog(t, numbered(30, 'old run'));
  await readNew({});
  const { ino } = await fs.stat(file);

  await fs.writeFile(file, numbered(60, 'new run'));
  assert.equal((await fs.stat(file)).ino, ino, 'the file was rewritten in place, not replaced');

  const after = await readNew({});
  assert.equal(after.isBaseline, true, 'the old position was read as if the new run had appended to the old one');
  assert.ok(after.content.endsWith('new run 60'));
});

test('read_log with onlyNew holds back a line still being written and reads CRLF lines whole', async (t) => {
  const file = await withLog(t, 'first\r\n');
  await readNew({});

  await fs.appendFile(file, 'second\r\n\r\nhalf a li');
  const partial = await readNew({});
  assert.equal(partial.content, 'second');
  assert.equal(partial.newLines, 1, 'a blank CRLF line is not a new line');

  await fs.appendFile(file, 'ne\r\n');
  const rest = await readNew({});
  assert.equal(rest.content, 'half a line');
  assert.equal(rest.newLines, 1);
});

test('read_log with onlyNew cuts a huge delta at a line boundary', async (t) => {
  const file = await withLog(t, 'start\n');
  await readNew({});
  await fs.appendFile(file, Array.from({ length: 3000 }, (_, i) => `${'y'.repeat(97)}${String(i).padStart(4, '0')}`).join('\n') + '\n');

  const delta = await readNew({});
  assert.equal(delta.truncated, true);
  assert.match(delta.content.split('\n')[0], /^y{97}\d{4}$/, 'the first line is whole');
});

test('a baseline never repeats lines the next onlyNew call returns', async (t) => {
  const file = await withLog(t, numbered(5));
  const baseline = await readNew({});
  await fs.appendFile(file, 'line 6\n');
  const next = await readNew({});
  assert.equal(next.content, 'line 6');
  assert.ok(!baseline.content.includes('line 6'));
});

test('parallel onlyNew calls hand each new line out once', async (t) => {
  const file = await withLog(t, numbered(3));
  await readNew({});
  await fs.appendFile(file, 'line 4\nline 5\n');

  const replies = await Promise.all([readNew({}), readNew({}), readNew({})]);
  assert.deepEqual(replies.map((reply) => reply.newLines).sort(), [0, 0, 2]);
});

test('onlyNew keeps reading the file it started on while that file is still written', fakeHomeWorks, async () => {
  await withFakeHome(async ({ profileLog, writePlayerLog, playerLogPath }) => {
    const umm = await profileLog('Test-Only-8c02', 'umm line 1\n', new Date());
    const baseline = await readNew({});
    assert.equal(baseline.path, umm);

    await writePlayerLog('the player log turns up\n', new Date());
    await fs.appendFile(umm, 'umm line 2\n');
    const next = await readNew({});
    assert.equal(next.path, umm, 'the read switched files and rebaselined');
    assert.equal(next.isBaseline, false);
    assert.equal(next.content, 'umm line 2');

    assert.equal((await readLog({ lines: 1 })).path, playerLogPath, 'a plain read takes the player log');
  });
});

test('the player log paths wait for the Proton detection, so the first read after a start finds the prefix log', fakeHomeWorks, async () => {
  const { unityClient, targetLogPaths } = await import('../index.js');
  await withFakeHome(async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'proton-prefix-'));
    const outputLog = path.join(prefix, 'drive_c/users/steamuser/AppData/LocalLow/Free Lives/Broforce/output_log.txt');
    await fs.mkdir(path.dirname(outputLog), { recursive: true });
    await fs.writeFile(outputLog, 'proton run\n');

    const original = unityClient.detectPlatform;
    unityClient.detectPlatform = async function detectLater() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.platform = 'linux';
      this.protonPrefix = prefix;
    };
    try {
      assert.equal((await targetLogPaths()).player, outputLog);
    } finally {
      unityClient.detectPlatform = original;
      await fs.rm(prefix, { recursive: true, force: true });
    }
  });
});

test('while a game runs, the logs a test run snapshots name no player log it has not written', fakeHomeWorks, async () => {
  const { targetLogPaths } = await import('../index.js');
  await withFakeHome(async ({ profileLog, writePlayerLog }) => {
    const started = Date.now() - 60000;
    const old = new Date(started - 3600000);
    await writePlayerLog('another install\n', old);
    const live = await profileLog('Test-Live-8c02', 'this run\n', new Date());

    assert.deepEqual(await targetLogPaths({ detectProfile: async () => 'Test-Live-8c02', startTime: async () => started }), { umm: live, player: null });

    process.env.UNITY_INSPECTOR_LOG = live;
    try {
      assert.deepEqual(await targetLogPaths({ startTime: async () => started }), { umm: live, player: null }, 'a UMM override follows the same rule');
    } finally {
      delete process.env.UNITY_INSPECTOR_LOG;
    }
  });
});
