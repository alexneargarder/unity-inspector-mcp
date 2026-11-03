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
  assert.deepEqual(logs.umm, { path: null, missing: true });
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

test('the UMM log\'s [Unity] copies are dropped while Player.log is readable, and used when it is not', async (t) => {
  const { paths } = await logPair(t, { umm: '', player: '' });
  const snapshot = await snapshotLogs(paths);
  await appendFile(paths.umm, UMM_SAMPLE);
  await appendFile(paths.player, UNITY_NRE_BLOCK);

  const both = await collectLogDelta(snapshot);
  const unity = both.bySource.filter((s) => s.source === 'Unity');
  assert.equal(unity.length, 1);
  assert.equal(unity[0].errors, 1, 'the NRE is counted once, from Player.log');
  assert.equal(unity[0].origin, 'BroMakerLib', 'a mod\'s throw that Unity reports is credited to the mod');
  assert.equal(unity[0].groups[0].frame, 'BroMakerLib.AssMouthTransportWrapper_RunAssMouthMovement_Patch.Postfix');

  const ummOnly = await collectLogDelta({ ...snapshot, player: { path: null, size: 0, fileId: null } });
  const mirrored = ummOnly.bySource.find((s) => s.source === 'Unity');
  assert.equal(mirrored.errors, 1);
});

test('Player.log keeps Unity log calls and engine lines, and its UMM copies only when the UMM log is unreadable', () => {
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
  assert.equal(logs.umm.missing, true);
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
  await appendFile(paths.umm, '[Swap Bros Mod] [Error] Could not swap\n'.repeat(FLOOD_MIN_COUNT - 1));

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
  await appendFile(paths.umm, ['[Manager] Loading mods.', ...frames].join('\n') + '\n');

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
    await appendFile(paths.umm, block);
    written += Buffer.byteLength(block);
  }

  const logs = await collectLogDelta(snapshot);
  const size = JSON.stringify(logs).length;
  assert.ok(size <= LOG_PAYLOAD_MAX_CHARS, `logs payload is ${size} chars`);
  assert.equal(logs.truncated, true);
  assert.ok(logs.omittedSources > 0);
  assert.ok(logs.umm.skippedBytes > 0, 'the read keeps only the tail');
  assert.ok(logs.summary.errors > 0);
});
