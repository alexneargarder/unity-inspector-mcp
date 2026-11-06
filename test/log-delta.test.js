import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, rename, truncate } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import {
  FLOOD_MIN_COUNT,
  LOG_PAYLOAD_MAX_CHARS,
  collectLogDelta,
  groupEntries,
  linesBackward,
  normalizeMessage,
  parsePlayerLog,
  parseUmmLog,
  readDelta,
  snapshotLogs,
} from '../lib/log-delta.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'log-delta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function logPair(t, { umm = '', player = '' } = {}) {
  const dir = await tempDir(t);
  const paths = { umm: path.join(dir, 'Log.txt'), player: path.join(dir, 'Player.log') };
  if (umm !== null) await writeFile(paths.umm, umm);
  if (player !== null) await writeFile(paths.player, player);
  return { dir, paths };
}

const UNITY_NRE_BLOCK = [
  '[Unity] <color=red>NullReferenceException: Object reference not set to an instance of an object</color>',
  '[Unity] <color=red>Stack trace:',
  'void BroMakerLib.AssMouthTransportWrapper_RunAssMouthMovement_Patch.Postfix()',
  'void TriggerManager.Update()',
  '</color>',
  'NullReferenceException: Object reference not set to an instance of an object',
  '   at void BroMakerLib.AssMouthTransportWrapper_RunAssMouthMovement_Patch.Postfix()',
  '   at void TriggerManager.Update()',
  ' ',
  '(Filename:  Line: -1)',
  '',
].join('\n') + '\n';

const UMM_SAMPLE = [
  '[Manager] Loading mods.',
  "[Swap Bros Mod] Version '2.1.5'. Loading.",
  '[BroMakerLib][16:29:02] Initialization of BroMaker',
  '[Unity Inspector Mod] [Script:tunnel-trace] [f:6267 t:207.944] entered tunnel',
  '[Swap Bros Mod] [Error] Could not swap',
  '[Manager] [Warning] Mod list is stale',
  '[Unity] NullReferenceException: Object reference not set to an instance of an object',
  '[Unity] Stack trace:',
  'void BroMakerLib.AssMouthTransportWrapper_RunAssMouthMovement_Patch.Postfix(TestVanDammeAnim)',
  '',
].join('\n') + '\n';

test('only what a log gained since the baseline is read', async (t) => {
  const { paths } = await logPair(t, { umm: '[Manager] before\n' });
  const snapshot = await snapshotLogs(paths);
  await appendFile(paths.umm, '[Manager] after\n');

  const delta = await readDelta(snapshot.umm);
  assert.equal(delta.text, '[Manager] after\n');
  assert.deepEqual(delta.info, { path: paths.umm, fromByte: '[Manager] before\n'.length, bytes: '[Manager] after\n'.length });
});

test('a log replaced mid-run is read from the start and flagged rotated', async (t) => {
  const { dir, paths } = await logPair(t, { player: 'old run line one\nold run line two\n' });
  const snapshot = await snapshotLogs(paths);

  await rename(paths.player, path.join(dir, 'Player-prev.log'));
  await writeFile(paths.player, 'new run line one\nnew run line two\nnew run line three\n');

  const delta = await readDelta(snapshot.player);
  assert.equal(delta.info.rotated, true);
  assert.equal(delta.info.fromByte, 0);
  assert.equal(delta.text, 'new run line one\nnew run line two\nnew run line three\n');
});

test('a log truncated in place is read from the start and flagged rotated', async (t) => {
  const { paths } = await logPair(t, { umm: '[Manager] a long line written before the run\n' });
  const snapshot = await snapshotLogs(paths);

  await truncate(paths.umm, 0);
  await appendFile(paths.umm, '[Manager] x\n');

  const delta = await readDelta(snapshot.umm);
  assert.equal(delta.info.rotated, true);
  assert.equal(delta.text, '[Manager] x\n');
});

test('a missing log is reported missing, and one created mid-run is read whole', async (t) => {
  const { paths } = await logPair(t, { umm: null, player: null });
  const snapshot = await snapshotLogs({ ...paths, umm: null });

  assert.deepEqual((await readDelta(snapshot.umm)).info, { path: null, missing: true });
  assert.deepEqual((await readDelta(snapshot.player)).info, { path: paths.player, missing: true });

  await writeFile(paths.player, 'Initialize engine version\n');
  const created = await readDelta(snapshot.player);
  assert.equal(created.text, 'Initialize engine version\n');
  assert.equal(created.info.rotated, undefined, 'a log that did not exist at the start was not rotated');

  const logs = await collectLogDelta(snapshot);
  assert.equal(logs.umm, undefined, 'the UMM log is not read beside a readable player log');
  assert.equal(logs.player.path, paths.player);
  assert.equal(logs.summary.lines, 1);
});

test('a delta past the read cap keeps its tail, from a whole line, and says what it skipped', async (t) => {
  const { paths } = await logPair(t);
  const snapshot = await snapshotLogs(paths);
  const lines = Array.from({ length: 200 }, (_, i) => `[Manager] line ${String(i).padStart(4, '0')}`);
  await appendFile(paths.umm, lines.join('\n') + '\n');

  const delta = await readDelta(snapshot.umm, { maxBytes: 1000 });
  assert.ok(delta.info.skippedBytes > 0);
  assert.equal(delta.info.bytes, Buffer.byteLength(lines.join('\n') + '\n'));
  assert.ok(delta.text.startsWith('[Manager] line '), delta.text.slice(0, 40));
  assert.equal(delta.info.skippedBytes + Buffer.byteLength(delta.text), delta.info.bytes);
  assert.ok(delta.text.endsWith('[Manager] line 0199\n'));
});

test('UMM lines are attributed by their prefix, scripts under their mod', () => {
  const entries = parseUmmLog(UMM_SAMPLE);
  const sources = entries.map((e) => e.source);
  assert.deepEqual(sources, [
    'Manager',
    'Swap Bros Mod',
    'BroMakerLib',
    'Unity Inspector Mod › Script:tunnel-trace',
    'Swap Bros Mod',
    'Manager',
    'Unity',
  ]);
  assert.equal(entries[2].message, 'Initialization of BroMaker');
  assert.equal(entries[4].severity, 'error');
  assert.equal(entries[5].severity, 'warning');
  const unity = entries[6];
  assert.equal(unity.lineCount, 3, 'the Stack trace: entry and its frame belong to the message before it');
  assert.equal(unity.frames.length, 1);
});

test('the UMM log is not read while Player.log is readable, and its [Unity] copies count when it is not', async (t) => {
  const { paths } = await logPair(t, { umm: '', player: '' });
  const snapshot = await snapshotLogs(paths);
  await appendFile(paths.umm, UMM_SAMPLE);
  await appendFile(paths.player, UNITY_NRE_BLOCK);

  const both = await collectLogDelta(snapshot);
  assert.equal(both.umm, undefined);
  assert.ok(!both.bySource.some((s) => s.source === 'Swap Bros Mod'), 'the UMM log was read');
  const unity = both.bySource.filter((s) => s.source === 'Unity');
  assert.equal(unity.length, 1);
  assert.equal(unity[0].errors, 1, 'the NRE is counted once, from Player.log');
  assert.equal(unity[0].origin, 'BroMakerLib', 'a mod\'s throw that Unity reports is credited to the mod');
  assert.equal(unity[0].groups[0].frame, 'BroMakerLib.AssMouthTransportWrapper_RunAssMouthMovement_Patch.Postfix');

  const ummOnly = await collectLogDelta({ ...snapshot, player: { path: null, size: 0, fileId: null } });
  const mirrored = ummOnly.bySource.find((s) => s.source === 'Unity');
  assert.equal(mirrored.errors, 1);
});

test('Player.log keeps Unity log calls and engine lines, and its UMM copies when asked for them', () => {
  const text = [
    'Initialize engine version: 2017.4',
    '[Swap Bros Mod] Loading.',
    '',
    UNITY_NRE_BLOCK,
    '[MyMod] logged through Debug.Log',
    ' ',
    '(Filename: ./Runtime/Export/Debug.bindings.h Line: 35)',
    '',
  ].join('\n');

  const withoutCopies = parsePlayerLog(text);
  const sources = withoutCopies.map((e) => `${e.source}: ${e.message}`).sort();
  assert.deepEqual(sources, [
    'MyMod: logged through Debug.Log',
    'Unity (engine): Initialize engine version: 2017.4',
    'Unity: NullReferenceException: Object reference not set to an instance of an object',
  ]);

  const withCopies = parsePlayerLog(text, { includePrefixed: true });
  assert.ok(withCopies.some((e) => e.source === 'Swap Bros Mod'));
  assert.equal(withCopies.filter((e) => e.source === 'Unity').length, 1, 'the [Unity] mirror is never counted beside the call it mirrors');
});

const REAL_WARNINGS = [
  '[Unity] <color=yellow>DontDestroyOnLoad only work for root GameObjects or components on root GameObjects.</color>',
  'DontDestroyOnLoad only work for root GameObjects or components on root GameObjects.',
  ' ',
  '(Filename:  Line: 485)',
  '',
  'Fallback handler could not load library /game/Broforce_Data/Mono/x86_64/LightFX.dll',
  '[Unity] <color=yellow>Font size and style overrides are only supported for dynamic fonts.</color>',
  'Font size and style overrides are only supported for dynamic fonts.',
  ' ',
  '(Filename:  Line: 101)',
  '',
  '',
  'Unloading 814 unused Assets to reduce memory usage. Loaded Objects now: 112422.',
  '',
].join('\n');

const REAL_EXIT_EXCEPTION = [
  '[Manager] Destroying when exit.',
  '[Unity] <color=red>NullReferenceException: Object reference not set to an instance of an object</color>',
  '[Unity] <color=red>Stack trace:',
  'void Map.RemoveProjectile(Projectile projectile)',
  'void Projectile.DeregisterProjectile()',
  'void Projectile.OnDestroy()',
  '</color>',
  'NullReferenceException: Object reference not set to an instance of an object',
  '   at void Map.RemoveProjectile(Projectile projectile)',
  '   at void Projectile.DeregisterProjectile()',
  '   at void Projectile.OnDestroy()',
  ' ',
  '(Filename:  Line: -1)',
  '',
].join('\n');

test('a yellow mirror makes the Unity call below it a warning, and only that call', () => {
  const entries = parsePlayerLog(REAL_WARNINGS);
  const calls = entries.filter((e) => e.source === 'Unity');
  assert.deepEqual(calls.map((e) => [e.message, e.severity]), [
    ['DontDestroyOnLoad only work for root GameObjects or components on root GameObjects.', 'warning'],
    ['Font size and style overrides are only supported for dynamic fonts.', 'warning'],
  ]);
  const engine = entries.filter((e) => e.source === 'Unity (engine)');
  assert.equal(engine.length, 2);
  assert.ok(engine.every((e) => e.severity === null), 'the mirror colour does not leak past its call');
});

test('a red mirror makes even a keyword-free Debug.LogError an error', () => {
  const text = [
    '[Unity] <color=red>Bro roster is empty</color>',
    'Bro roster is empty',
    ' ',
    '(Filename:  Line: 52)',
    '',
    'Bro roster is empty',
    ' ',
    '(Filename:  Line: 52)',
    '',
  ].join('\n');
  const calls = parsePlayerLog(text).filter((e) => e.source === 'Unity');
  assert.deepEqual(calls.map((e) => e.severity), ['error', null], 'without a mirror the keyword fallback decides');
});

test('without a UMM log each mirrored call counts once, at its mirror\'s severity', async (t) => {
  const { paths } = await logPair(t, { umm: null });
  const snapshot = await snapshotLogs(paths);
  await appendFile(paths.player, REAL_WARNINGS + REAL_EXIT_EXCEPTION);

  const logs = await collectLogDelta(snapshot);
  assert.equal(logs.umm, undefined);
  const unity = logs.bySource.filter((s) => s.source === 'Unity');
  assert.equal(unity.reduce((n, s) => n + s.errors, 0), 1);
  assert.equal(unity.reduce((n, s) => n + (s.warnings ?? 0), 0), 2);
  assert.equal(logs.summary.errors, 1, JSON.stringify(logs.bySource));
  assert.equal(logs.summary.warnings, 2);
  assert.ok(logs.bySource.some((s) => s.source === 'Manager'), 'UMM\'s other console lines stand in for its log');
});

test('one line repeated past the flood threshold is one flood group with its count', async (t) => {
  const { paths } = await logPair(t);
  const snapshot = await snapshotLogs(paths);
  await appendFile(paths.player, UNITY_NRE_BLOCK.repeat(FLOOD_MIN_COUNT + 10));
  await appendFile(paths.player, '[Swap Bros Mod] [Error] Could not swap\n'.repeat(FLOOD_MIN_COUNT - 1));

  const logs = await collectLogDelta(snapshot);
  assert.equal(logs.summary.floods, 1);
  const unity = logs.bySource.find((s) => s.source === 'Unity');
  assert.equal(unity.groups.length, 1);
  assert.equal(unity.groups[0].count, FLOOD_MIN_COUNT + 10);
  assert.equal(unity.groups[0].flood, true);
  const swap = logs.bySource.find((s) => s.source === 'Swap Bros Mod');
  assert.equal(swap.groups[0].count, FLOOD_MIN_COUNT - 1);
  assert.equal(swap.groups[0].flood, undefined);
  assert.equal(logs.bySource[0].source, 'Unity', 'sources are ordered errors first');
});

test('info lines are counted but listed only when they flood', async (t) => {
  const { paths } = await logPair(t);
  const snapshot = await snapshotLogs(paths);
  const frames = Array.from({ length: FLOOD_MIN_COUNT }, (_, i) => `[Unity Inspector Mod] [Script:x] [f:${i} t:${i}.5] tick ${i}`);
  await appendFile(paths.player, ['[Manager] Loading mods.', ...frames].join('\n') + '\n');

  const logs = await collectLogDelta(snapshot);
  const manager = logs.bySource.find((s) => s.source === 'Manager');
  assert.equal(manager.lines, 1);
  assert.deepEqual(manager.groups, []);
  const script = logs.bySource.find((s) => s.source === 'Unity Inspector Mod › Script:x');
  assert.equal(script.groups.length, 1, 'frame counters and numbers normalize into one group');
  assert.equal(script.groups[0].flood, true);
  assert.equal(script.groups[0].count, FLOOD_MIN_COUNT);
  assert.ok(script.groups[0].samples.length <= 2);
});

test('numbers, ids and stamps normalize away', () => {
  assert.equal(
    normalizeMessage('[16:29:02] [f:6267 t:207.944] object 0x7f3a at 12,34 id 2d13312f-8ffd-4950'),
    'object # at #,# id #',
  );
});

test('a 10 MB flood of distinct errors cannot blow up the payload', async (t) => {
  const { paths } = await logPair(t);
  const snapshot = await snapshotLogs(paths);

  const chunk = [];
  for (let i = 0; i < 2000; i++) {
    chunk.push(`[Mod ${i % 400}] [Error] failure kind ${'abcdefghij'[i % 10].repeat(1 + (i % 7))} ${'x'.repeat(400)}`);
  }
  const block = chunk.join('\n') + '\n';
  let written = 0;
  while (written < 10 * 1024 * 1024) {
    await appendFile(paths.player, block);
    written += Buffer.byteLength(block);
  }

  const logs = await collectLogDelta(snapshot);
  const size = JSON.stringify(logs).length;
  assert.ok(size <= LOG_PAYLOAD_MAX_CHARS, `logs payload is ${size} chars`);
  assert.equal(logs.truncated, true);
  assert.ok(logs.omittedSources > 0);
  assert.ok(logs.player.skippedBytes > 0, 'the read keeps only the tail');
  assert.ok(logs.summary.errors > 0);
});

test('a log the game truncated and regrew past the baseline is read from the start', async (t) => {
  const { paths } = await logPair(t, { umm: null, player: 'old run '.repeat(20) + '\n' });
  const snapshot = await snapshotLogs(paths);

  await writeFile(paths.player, 'new run, written over the old in place, and longer than it was\n'.repeat(5));
  const delta = await readDelta(snapshot.player);
  assert.equal(delta.info.rotated, true);
  assert.equal(delta.info.fromByte, 0);
  assert.match(delta.text, /^new run/);
});

test('a game that started again since the baseline restarts the read, though the bytes match', async (t) => {
  const { paths } = await logPair(t, { umm: null, player: 'Mono path[0] = header\n' });
  const snapshot = await snapshotLogs(paths, Date.parse('2026-01-01T00:00:00Z'));
  await appendFile(paths.player, 'more\n');

  const sameGame = await readDelta(snapshot.player, { started: Date.parse('2026-01-01T00:00:01Z') });
  assert.equal(sameGame.text, 'more\n', 'a start time within the tolerance is the same game');

  const relaunched = await readDelta(snapshot.player, { started: Date.parse('2026-01-01T00:05:00Z') });
  assert.equal(relaunched.info.rotated, true);
  assert.equal(relaunched.text, 'Mono path[0] = header\nmore\n');
});

test('the console copies in Player.log are the mod lines, read the moment they are logged', async (t) => {
  const { paths } = await logPair(t);
  const snapshot = await snapshotLogs(paths);
  await appendFile(paths.player, '[Swap Bros Mod] [Error] Could not swap\n[Manager] Loading mods.\n');
  await appendFile(paths.umm, '[Other Mod] [Error] only in the UMM log\n');

  const logs = await collectLogDelta(snapshot);
  assert.deepEqual(logs.bySource.map((s) => s.source).sort(), ['Manager', 'Swap Bros Mod']);
  assert.equal(logs.summary.errors, 1);
});

test('engine lines above a Unity call are not part of it', () => {
  const text = [
    'UnloadTime: 6.233000 ms',
    'Unloading 3 Unused Serialized files (Serialized files now loaded: 0)',
    'Bro roster is empty, warning',
    'UnityEngine.Debug:LogWarning(Object)',
    'Mod.Main:Load()',
    ' ',
    '(Filename: ./Runtime/Export/Debug.bindings.h Line: 35)',
    '',
    '- Completed reload, in  0.164 seconds',
    'NullReferenceException: Object reference not set to an instance of an object',
    '  at Mod.Main.Update () [0x00000] in <filename unknown>:0 ',
    ' ',
    '(Filename:  Line: -1)',
    '',
  ].join('\n');
  const entries = parsePlayerLog(text);
  const calls = entries.filter((e) => e.unityCall);
  assert.deepEqual(calls.map((e) => e.message), [
    'Bro roster is empty, warning',
    'NullReferenceException: Object reference not set to an instance of an object',
  ]);
  const engine = entries.filter((e) => e.source === 'Unity (engine)').map((e) => e.message);
  assert.deepEqual(engine, [
    'UnloadTime: 6.233000 ms',
    'Unloading 3 Unused Serialized files (Serialized files now loaded: 0)',
    '- Completed reload, in  0.164 seconds',
  ]);
});

test('an engine line after a UMM console copy ends it in Player.log', () => {
  const entries = parsePlayerLog([
    '[Unity Inspector Mod] Error handling message: System.Exception: boom',
    '  at Mod.Handler.Run () [0x00000] in <filename unknown>:0 ',
    'UnloadTime: 1.000000 ms',
    '[Unity] <color=red>Stack trace:',
    '',
  ].join('\n'), { includePrefixed: true });
  const mod = entries.find((e) => e.source === 'Unity Inspector Mod');
  assert.equal(mod.frames.length, 1);
  assert.ok(entries.some((e) => e.source === 'Unity (engine)' && e.message === 'UnloadTime: 1.000000 ms'));
});

test('a generic method frame is named by its method, not its last type argument', () => {
  const { bySource } = groupEntries([{
    source: 'Unity Inspector Mod',
    message: 'System.FormatException: Input string was not in the correct format',
    severity: null,
    frames: ['at int Newtonsoft.Json.Linq.Extensions.Convert<JToken, int>(JToken token)', 'at Mod.Main.Run()'],
    lineCount: 3,
  }]);
  assert.equal(bySource[0].groups[0].frame, 'Newtonsoft.Json.Linq.Extensions.Convert<JToken, int>');
});

test('a stamp or a JSON array opening a line names no source, and a long tag is clipped', () => {
  const stamped = Array.from({ length: 60 }, (_, i) => `[12:00:${String(i).padStart(2, '0')}] Bro roster is empty error`).join('\n');
  const stampedLogs = groupEntries(parseUmmLog(stamped));
  assert.equal(stampedLogs.bySource.length, 1);
  assert.equal(stampedLogs.summary.floods, 1);

  assert.equal(parseUmmLog('[1, 2, 3] listed')[0].source, '(unprefixed)');

  const long = parseUmmLog(`[${'{"x":1},'.repeat(2000)}] payload`)[0];
  assert.ok(long.source.length <= 81, `source was ${long.source.length} characters`);
});

test('a native crash report is an error', () => {
  const { summary } = groupEntries(parsePlayerLog([
    'Caught fatal signal - signo:11 code:1 errno:0 addr:0x0',
    'Obtained 12 stack frames.',
    '#0 0x007f in Foo',
    '',
  ].join('\n')));
  assert.equal(summary.errors, 2);
});

test('an engine error whose detail is a bracketed line of its own names no source of that name', () => {
  const { summary, bySource } = groupEntries(parsePlayerLog([
    "[Unity] <color=red>The file 'none' is corrupted! Remove it and launch unity again!",
    '[Position out of bounds!]</color>',
    "The file 'none' is corrupted! Remove it and launch unity again!",
    '[Position out of bounds!]',
    ' ',
    '(Filename:  Line: 215)',
    '',
  ].join('\n'), { includePrefixed: true }));
  assert.equal(summary.errors, 1);
  assert.ok(!bySource.some((source) => source.source.includes('Position out of bounds')), JSON.stringify(bySource));
  const unity = bySource.find((source) => source.source === 'Unity');
  assert.deepEqual(unity.groups.map(({ severity, message }) => ({ severity, message })),
    [{ severity: 'error', message: "The file 'none' is corrupted! Remove it and launch unity again! [Position out of bounds!]" }]);
});

test("the game's own native crash report is one error group, its frames under it", () => {
  const { summary, bySource } = groupEntries(parsePlayerLog([
    'Receiving unhandled NULL exception',
    '#0  0x007ffe9d39b840 in __sigaction',
    '#1  0x007ffe9d39c428 in mono_upgrade_remote_class_wrapper',
    '#2  0x007ffe9d39c430 in (Unknown)',
    '',
  ].join('\n')));
  assert.equal(summary.errors, 1);
  assert.equal(bySource[0].lines, 4);
  assert.deepEqual(bySource[0].groups.map(({ severity, count, message, frame }) => ({ severity, count, message, frame })),
    [{ severity: 'error', count: 1, message: 'Receiving unhandled NULL exception', frame: '__sigaction' }]);
});

test('linesBackward reads lines newest first from a floor, keeping the end of a long one', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'log');
  await writeFile(file, 'before\nfirst\r\n' + 'é'.repeat(20) + 'END\nlast\n');
  const read = async (options) => {
    const lines = [];
    for await (const line of linesBackward(file, { chunkBytes: 5, ...options })) lines.push(line);
    return lines;
  };

  assert.deepEqual((await read()).map((l) => l.text), ['last', 'é'.repeat(20) + 'END', 'first', 'before']);
  assert.deepEqual((await read({ start: 'before\n'.length })).map((l) => l.text), ['last', 'é'.repeat(20) + 'END', 'first']);
  const cut = (await read({ maxLineBytes: 8 }))[1];
  assert.equal(cut.cut, true);
  assert.ok(cut.text.endsWith('END') && !cut.text.includes('\ufffd'), cut.text);
});
