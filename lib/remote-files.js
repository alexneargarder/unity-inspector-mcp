import fs from 'fs/promises';
import path from 'path';

import { SESSION_ID_RE, serverStateDir, sessionFolder } from './instance.js';
import { GUARD_BYTES, LOG_READ_MAX_BYTES, readGuard } from './log-delta.js';

export const REMOTE_DIR_ENV = 'UNITY_INSPECTOR_REMOTE_DIR';
export const TRANSFER_MAX_BYTES = 2 * 1024 * 1024;
export const WRITE_CHUNK_BYTES = 96 * 1024;
export const SCREENSHOTS_KEEP = 50;
export const REMOTE_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
export const CODE_MARK = '// remote-files';
const LOG_KINDS = ['player', 'umm'];
export const LOG_MIRROR_NAMES = { player: 'Player.log', umm: 'Log.txt' };

// A JSON string literal is a valid C# one
export const csString = (value) => JSON.stringify(String(value));

export function remoteFilesRoot(env = process.env, home) {
  if (env[REMOTE_DIR_ENV]) return env[REMOTE_DIR_ENV];
  return path.join(serverStateDir(env, home), 'remote');
}

export function remoteFilesDir(env = process.env, home) {
  return path.join(remoteFilesRoot(env, home), sessionFolder(env));
}

let lastPrune = 0;

export async function pruneRemoteSessions(root, keep, { idleMs = REMOTE_SESSION_IDLE_MS, nowMs = Date.now() } = {}) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const folder = path.join(root, entry.name);
    if (!entry.isDirectory() || folder === keep || !SESSION_ID_RE.test(entry.name)) continue;
    try {
      if (nowMs - (await fs.lstat(folder)).mtimeMs >= idleMs) await fs.rm(folder, { recursive: true, force: true });
    } catch {}
  }
}

// The session folder's own mtime is what the prune reads, and writes deeper down never move it
async function localFolder(...parts) {
  const root = remoteFilesRoot();
  const session = remoteFilesDir();
  const folder = path.join(session, ...parts);
  await fs.mkdir(folder, { recursive: true });
  const now = new Date();
  await fs.utimes(session, now, now).catch(() => {});
  if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = Date.now();
    await pruneRemoteSessions(root, session);
  }
  return folder;
}

const header = (op, params) => `${CODE_MARK} ${op} ${JSON.stringify(params)}`;
const csStrings = (values) => `new string[] { ${values.map((value) => (value === null ? 'null' : csString(value))).join(', ')} }`;
const csLongs = (values) => `new long[] { ${values.map((value) => `${Math.trunc(value)}L`).join(', ')} }`;
const EPOCH_MS = (time) => `((${time}.Ticks - 621355968000000000L) / 10000L)`;
const MTIME_MS = (file) => EPOCH_MS(`System.IO.File.GetLastWriteTimeUtc(${file})`);
const DIR_MTIME_MS = (dir) => EPOCH_MS(`System.IO.Directory.GetLastWriteTimeUtc(${dir})`);
const JSON_TEXT = (value) => `${value}.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"")`;

function readInto(stream, into, at, count) {
  return [
    `byte[] ${into} = new byte[(int)System.Math.Max(0L, System.Math.Min(${count}, ${stream}.Length - (${at})))];`,
    `${stream}.Seek(${at}, System.IO.SeekOrigin.Begin);`,
    `int ${into}Got = 0;`,
    `while (${into}Got < ${into}.Length) { int n = ${stream}.Read(${into}, ${into}Got, ${into}.Length - ${into}Got); if (n <= 0) break; ${into}Got += n; }`,
    `if (${into}Got < ${into}.Length) { byte[] cut = new byte[${into}Got]; System.Array.Copy(${into}, cut, ${into}Got); ${into} = cut; }`,
  ];
}

const openShared = (variable, file) =>
  `using (System.IO.FileStream ${variable} = new System.IO.FileStream(${file}, System.IO.FileMode.Open, System.IO.FileAccess.Read, System.IO.FileShare.ReadWrite))`;

export function readCode(segments) {
  return [
    header('read', { segments }),
    `string[] paths = ${csStrings(segments.map((segment) => segment.path))};`,
    `long[] offsets = ${csLongs(segments.map((segment) => segment.offset))};`,
    `long[] lengths = ${csLongs(segments.map((segment) => segment.length))};`,
    'System.Text.StringBuilder json = new System.Text.StringBuilder("{");',
    'for (int i = 0; i < paths.Length; i++) {',
    '  if (i > 0) json.Append(",");',
    '  json.Append("\\"" + i + "\\":");',
    '  string encoded = null;',
    '  try {',
    `    ${openShared('file', 'paths[i]')} {`,
    ...readInto('file', 'data', 'offsets[i]', 'lengths[i]').map((line) => `      ${line}`),
    '      encoded = System.Convert.ToBase64String(data);',
    '    }',
    '  } catch (System.Exception) { encoded = null; }',
    '  json.Append(encoded == null ? "null" : "\\"" + encoded + "\\"");',
    '}',
    'json.Append("}");',
    'return json.ToString();',
  ].join('\n');
}

export function statCode(paths) {
  return [
    header('stat', { paths }),
    `string[] paths = ${csStrings(paths)};`,
    'System.Text.StringBuilder json = new System.Text.StringBuilder("{");',
    'for (int i = 0; i < paths.Length; i++) {',
    '  if (i > 0) json.Append(",");',
    '  json.Append("\\"" + i + "\\":" + (System.IO.File.Exists(paths[i]) ? "" + new System.IO.FileInfo(paths[i]).Length : "null"));',
    '}',
    'json.Append("}");',
    'return json.ToString();',
  ].join('\n');
}

export function writeCode({ path: file, append, data }) {
  return [
    header('write', { path: file, append }),
    `string path = ${csString(file)};`,
    `byte[] bytes = System.Convert.FromBase64String(${csString(data)});`,
    'string folder = System.IO.Path.GetDirectoryName(path);',
    'if (!string.IsNullOrEmpty(folder)) System.IO.Directory.CreateDirectory(folder);',
    `using (System.IO.FileStream file = new System.IO.FileStream(path, System.IO.FileMode.${append ? 'Append' : 'Create'}, System.IO.FileAccess.Write, System.IO.FileShare.Read)) {`,
    '  file.Write(bytes, 0, bytes.Length);',
    '}',
    'return "" + new System.IO.FileInfo(path).Length;',
  ].join('\n');
}

export function removeDirCode(folder, { pruneParent = false } = {}) {
  return [
    header('removeDir', { path: folder, pruneParent }),
    `string path = ${csString(folder)};`,
    'string result = "absent";',
    'if (System.IO.Directory.Exists(path)) {',
    '  System.IO.Directory.Delete(path, true);',
    '  result = "removed";',
    '}',
    ...(pruneParent
      ? [
        'string parent = System.IO.Path.GetDirectoryName(path);',
        'try {',
        '  if (!string.IsNullOrEmpty(parent) && System.IO.Directory.Exists(parent) && System.IO.Directory.GetFileSystemEntries(parent).Length == 0) System.IO.Directory.Delete(parent, false);',
        '} catch (System.Exception) {}',
      ]
      : []),
    'return result;',
  ].join('\n');
}

export function listCode({ path: folder, underCache = false }) {
  const root = underCache ? `System.IO.Path.Combine(UnityEngine.Application.temporaryCachePath, ${csString(folder)})` : csString(folder);
  return [
    header('list', { path: folder, underCache }),
    `string root = ${root};`,
    `long now = ${EPOCH_MS('System.DateTime.UtcNow')};`,
    'int pid;',
    'using (System.Diagnostics.Process self = System.Diagnostics.Process.GetCurrentProcess()) { pid = self.Id; }',
    `System.Text.StringBuilder json = new System.Text.StringBuilder("{\\"root\\":\\"" + ${JSON_TEXT('root')} + "\\",\\"pid\\":" + pid + ",\\"now\\":" + now + ",\\"dirs\\":[");`,
    'bool exists = System.IO.Directory.Exists(root);',
    'string[] dirs = exists ? System.IO.Directory.GetDirectories(root) : new string[0];',
    'for (int i = 0; i < dirs.Length; i++) {',
    '  string name = System.IO.Path.GetFileName(dirs[i]);',
    '  long newest = now;',
    '  System.Text.StringBuilder runs = new System.Text.StringBuilder();',
    '  try {',
    `    newest = ${DIR_MTIME_MS('dirs[i]')};`,
    `    foreach (string top in System.IO.Directory.GetFiles(dirs[i])) newest = System.Math.Max(newest, ${MTIME_MS('top')});`,
    '    string[] subs = System.IO.Directory.GetDirectories(dirs[i]);',
    '    for (int j = 0; j < subs.Length; j++) {',
    `      long latest = ${DIR_MTIME_MS('subs[j]')};`,
    `      foreach (string inner in System.IO.Directory.GetDirectories(subs[j], "*", System.IO.SearchOption.AllDirectories)) latest = System.Math.Max(latest, ${DIR_MTIME_MS('inner')});`,
    `      foreach (string inner in System.IO.Directory.GetFiles(subs[j], "*", System.IO.SearchOption.AllDirectories)) latest = System.Math.Max(latest, ${MTIME_MS('inner')});`,
    '      newest = System.Math.Max(newest, latest);',
    `      runs.Append((j > 0 ? "," : "") + "{\\"name\\":\\"" + ${JSON_TEXT('System.IO.Path.GetFileName(subs[j])')} + "\\",\\"newest\\":" + latest + "}");`,
    '    }',
    '  } catch (System.Exception) { newest = now; }',
    `  json.Append((i > 0 ? "," : "") + "{\\"name\\":\\"" + ${JSON_TEXT('name')} + "\\",\\"newest\\":" + newest + ",\\"dirs\\":[" + runs + "]}");`,
    '}',
    'json.Append("],\\"files\\":[");',
    'string[] files = exists ? System.IO.Directory.GetFiles(root) : new string[0];',
    'for (int i = 0; i < files.Length; i++) {',
    '  string name = System.IO.Path.GetFileName(files[i]);',
    `  json.Append((i > 0 ? "," : "") + "\\"" + ${JSON_TEXT('name')} + "\\"");`,
    '}',
    'json.Append("]}");',
    'return json.ToString();',
  ].join('\n');
}

export function sentinelCode({ path: folder, done, error, progress }) {
  return [
    header('sentinel', { path: folder, done, error, progress }),
    `string folder = ${csString(folder)};`,
    `string done = System.IO.Path.Combine(folder, ${csString(done)});`,
    `string error = System.IO.Path.Combine(folder, ${csString(error)});`,
    `string progress = System.IO.Path.Combine(folder, ${csString(progress)});`,
    'string failure = null;',
    'try {',
    '  if (System.IO.File.Exists(error)) {',
    `    ${openShared('file', 'error')} {`,
    ...readInto('file', 'data', '0L', 'file.Length').map((line) => `      ${line}`),
    '      failure = System.Convert.ToBase64String(data);',
    '    }',
    '  }',
    '} catch (System.Exception) { failure = null; }',
    `string stamp = System.IO.File.Exists(progress) ? ${MTIME_MS('progress')} + ":" + new System.IO.FileInfo(progress).Length : null;`,
    'return "{\\"error\\":" + (failure == null ? "null" : "\\"" + failure + "\\"")',
    '  + ",\\"done\\":" + (System.IO.File.Exists(done) ? "true" : "false")',
    '  + ",\\"progress\\":" + (stamp == null ? "null" : "\\"" + stamp + "\\"") + "}";',
  ].join('\n');
}

export function logSyncCode({ player, umm, window = LOG_READ_MAX_BYTES, budget = TRANSFER_MAX_BYTES }) {
  return [
    header('logSync', { player, umm, window, budget }),
    'string persistent = UnityEngine.Application.persistentDataPath;',
    'string[] candidates = new string[] {',
    '  System.IO.Path.Combine(persistent, "Player.log"),',
    '  System.IO.Path.Combine(persistent, "output_log.txt"),',
    '  System.IO.Path.Combine(UnityEngine.Application.dataPath, "output_log.txt"),',
    '  UnityEngine.Application.platform == UnityEngine.RuntimePlatform.OSXPlayer',
    '    ? System.IO.Path.Combine(System.Environment.GetEnvironmentVariable("HOME") ?? "", "Library/Logs/Unity/Player.log") : null,',
    '};',
    'string player = null;',
    'long newest = 0;',
    'foreach (string candidate in candidates) {',
    '  if (candidate == null || !System.IO.File.Exists(candidate)) continue;',
    '  long written = System.IO.File.GetLastWriteTimeUtc(candidate).Ticks;',
    '  if (player == null || written > newest) { player = candidate; newest = written; }',
    '}',
    'string umm = UnityModManagerNet.UnityModManager.Logger.filepath;',
    'if (umm != null && !System.IO.File.Exists(umm)) umm = null;',
    'string[] paths = new string[] { player, umm };',
    'string[] kinds = new string[] { "player", "umm" };',
    `long[] known = ${csLongs([player.known, umm.known])};`,
    `string[] lastPaths = ${csStrings([player.lastPath, umm.lastPath])};`,
    `string[] guards = ${csStrings([player.guard, umm.guard])};`,
    `long window = ${Math.trunc(window)}L;`,
    `long budget = ${Math.trunc(budget)}L;`,
    'System.Text.StringBuilder json = new System.Text.StringBuilder("{");',
    'for (int i = 0; i < 2; i++) {',
    '  if (i > 0) json.Append(",");',
    '  json.Append("\\"" + kinds[i] + "\\":");',
    '  if (paths[i] == null) { json.Append("null"); continue; }',
    `  long mtime = ${MTIME_MS('paths[i]')};`,
    `  ${openShared('file', 'paths[i]')} {`,
    '    long size = file.Length;',
    '    long start = -1;',
    '    byte[] guard = System.Convert.FromBase64String(guards[i]);',
    '    if (known[i] >= guard.Length && paths[i] == lastPaths[i] && known[i] <= size && size - known[i] <= window) {',
    ...readInto('file', 'seen', 'known[i] - guard.Length', 'guard.Length').map((line) => `      ${line}`),
    '      bool same = seen.Length == guard.Length;',
    '      for (int j = 0; same && j < guard.Length; j++) if (seen[j] != guard[j]) same = false;',
    '      if (same) start = known[i];',
    '    }',
    '    bool append = start >= 0;',
    '    if (!append) start = System.Math.Max(0L, size - window);',
    ...readInto('file', 'data', 'start', 'System.Math.Min(size - start, budget)').map((line) => `    ${line}`),
    '    budget -= data.Length;',
    `    byte[] tail = new byte[0];`,
    `    if (start + data.Length < size) {`,
    ...readInto('file', 'last', `size - System.Math.Min(size, ${GUARD_BYTES}L)`, `${GUARD_BYTES}L`).map((line) => `      ${line}`),
    '      tail = last;',
    '    }',
    `    json.Append("{\\"path\\":\\"" + ${JSON_TEXT('paths[i]')} + "\\",\\"size\\":" + size + ",\\"mtime\\":" + mtime`,
    '      + ",\\"start\\":" + start + ",\\"append\\":" + (append ? "true" : "false")',
    '      + ",\\"data\\":\\"" + System.Convert.ToBase64String(data) + "\\",\\"tail\\":\\"" + System.Convert.ToBase64String(tail) + "\\"}");',
    '  }',
    '}',
    'json.Append("}");',
    'return json.ToString();',
  ].join('\n');
}

export function logChunkCode(segments) {
  return [
    header('logChunk', { segments }),
    `string[] paths = ${csStrings(segments.map((segment) => segment.path))};`,
    `long[] offsets = ${csLongs(segments.map((segment) => segment.offset))};`,
    `long[] lengths = ${csLongs(segments.map((segment) => segment.length))};`,
    `long[] sizes = ${csLongs(segments.map((segment) => segment.size))};`,
    `string[] tails = ${csStrings(segments.map((segment) => segment.tail))};`,
    'System.Text.StringBuilder json = new System.Text.StringBuilder("{");',
    'for (int i = 0; i < paths.Length; i++) {',
    '  if (i > 0) json.Append(",");',
    '  json.Append("\\"" + i + "\\":");',
    '  string encoded = null;',
    '  try {',
    `    ${openShared('file', 'paths[i]')} {`,
    '      byte[] tail = System.Convert.FromBase64String(tails[i]);',
    '      if (file.Length >= sizes[i]) {',
    ...readInto('file', 'seen', 'sizes[i] - tail.Length', 'tail.Length').map((line) => `        ${line}`),
    '        bool same = seen.Length == tail.Length;',
    '        for (int j = 0; same && j < tail.Length; j++) if (seen[j] != tail[j]) same = false;',
    '        if (same) {',
    ...readInto('file', 'data', 'offsets[i]', 'lengths[i]').map((line) => `          ${line}`),
    '          encoded = System.Convert.ToBase64String(data);',
    '        }',
    '      }',
    '    }',
    '  } catch (System.Exception) { encoded = null; }',
    '  json.Append(encoded == null ? "null" : "\\"" + encoded + "\\"");',
    '}',
    'json.Append("}");',
    'return json.ToString();',
  ].join('\n');
}

async function runCode(client, code, what) {
  const reply = await client.sendCommand('execute_code', { code });
  if (!reply || reply.success !== true || typeof reply.result !== 'string') {
    const cause = reply?.error ?? (reply?.mainThreadAnswered === false ? "the game's main thread did not answer" : 'no result came back');
    throw new Error(`${what} failed in the game: ${cause}`);
  }
  return reply.result;
}

const decoded = (value) => (typeof value === 'string' ? Buffer.from(value, 'base64') : null);

function packCalls(segments) {
  const calls = [];
  let current = [];
  let bytes = 0;
  for (const segment of segments) {
    if (current.length > 0 && bytes + segment.length > TRANSFER_MAX_BYTES) {
      calls.push(current);
      current = [];
      bytes = 0;
    }
    current.push(segment);
    bytes += segment.length;
  }
  if (current.length > 0) calls.push(current);
  return calls;
}

export async function readSegments(client, segments, what = 'Reading files on the game\'s machine') {
  const reply = JSON.parse(await runCode(client, readCode(segments), what));
  return segments.map((_, index) => decoded(reply[String(index)]));
}

async function writeWhole(localPath, bytes) {
  const part = `${localPath}.part`;
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(part, bytes);
  await fs.rename(part, localPath);
}

export async function pullFile(client, gamePath, localPath) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const [chunk] = await readSegments(client, [{ path: gamePath, offset, length: TRANSFER_MAX_BYTES }]);
    if (chunk === null) throw new Error(`${gamePath} could not be read on the game's machine`);
    parts.push(chunk);
    offset += chunk.length;
    if (chunk.length < TRANSFER_MAX_BYTES) break;
  }
  await writeWhole(localPath, Buffer.concat(parts));
  return offset;
}

export async function pullFiles(client, files) {
  const failed = [];
  const fail = (file, reason) => {
    if (!failed.some((entry) => entry.gamePath === file.gamePath)) failed.push({ gamePath: file.gamePath, reason });
  };
  if (files.length === 0) return { pulled: [], failed };

  const sizes = JSON.parse(await runCode(client, statCode(files.map((file) => file.gamePath)), 'Listing files on the game\'s machine'));
  const segments = [];
  const parts = files.map(() => []);
  files.forEach((file, index) => {
    const size = sizes[String(index)];
    if (!Number.isInteger(size)) return fail(file, 'missing on the game\'s machine');
    if (size === 0) segments.push({ index, path: file.gamePath, offset: 0, length: 0 });
    for (let offset = 0; offset < size; offset += TRANSFER_MAX_BYTES) {
      segments.push({ index, path: file.gamePath, offset, length: Math.min(TRANSFER_MAX_BYTES, size - offset) });
    }
  });

  for (const call of packCalls(segments)) {
    let chunks;
    try {
      chunks = await readSegments(client, call.map(({ path: gamePath, offset, length }) => ({ path: gamePath, offset, length })));
    } catch (err) {
      for (const segment of call) fail(files[segment.index], err.message);
      continue;
    }
    call.forEach((segment, i) => {
      const chunk = chunks[i];
      if (chunk === null || chunk.length !== segment.length) fail(files[segment.index], 'it changed or vanished while it was read');
      else parts[segment.index].push(chunk);
    });
  }

  const pulled = [];
  for (const [index, file] of files.entries()) {
    if (failed.some((entry) => entry.gamePath === file.gamePath)) continue;
    try {
      await writeWhole(file.localPath, Buffer.concat(parts[index]));
      pulled.push(file.localPath);
    } catch (err) {
      fail(file, `writing ${file.localPath} failed: ${err.message}`);
    }
  }
  return { pulled, failed };
}

export async function writeRemoteFile(client, gamePath, bytes) {
  let written = 0;
  do {
    const chunk = bytes.subarray(written, written + WRITE_CHUNK_BYTES);
    const length = Number(await runCode(
      client,
      writeCode({ path: gamePath, append: written > 0, data: chunk.toString('base64') }),
      `Writing ${gamePath} on the game's machine`,
    ));
    written += chunk.length;
    if (length !== written) throw new Error(`Writing ${gamePath} on the game's machine left ${length} bytes of ${written}`);
  } while (written < bytes.length);
  return written;
}

export async function removeRemoteDir(client, gamePath, { pruneParent = false } = {}) {
  return runCode(client, removeDirCode(gamePath, { pruneParent }), `Removing ${gamePath} on the game's machine`);
}

export async function listRemoteDir(client, folder, { underCache = false } = {}) {
  return JSON.parse(await runCode(client, listCode({ path: folder, underCache }), `Listing ${folder} on the game's machine`));
}

export async function readSentinel(client, folder, names) {
  const reply = JSON.parse(await runCode(client, sentinelCode({ path: folder, ...names }), `Reading ${folder} on the game's machine`));
  return { error: reply.error === null ? null : Buffer.from(reply.error, 'base64').toString('utf-8'), done: reply.done === true, progress: reply.progress };
}

async function keepNewest(folder, keep) {
  const files = [];
  for (const name of await fs.readdir(folder)) {
    if (name.endsWith('.part')) continue;
    try {
      const stat = await fs.lstat(path.join(folder, name));
      if (stat.isFile()) files.push({ name, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  await Promise.all(files.slice(keep).map(({ name }) => fs.rm(path.join(folder, name), { force: true })));
}

export async function pullScreenshot(client, gamePath) {
  const base = String(gamePath).split(/[\\/]/).pop();
  const name = base && base !== '.' && base !== '..' ? base : 'screenshot.png';
  try {
    const folder = await localFolder('screenshots');
    const local = path.join(folder, name);
    await pullFile(client, gamePath, local);
    await keepNewest(folder, SCREENSHOTS_KEEP);
    return local;
  } catch (err) {
    throw new Error(`The screenshot was taken but could not be fetched from the game's machine, where it is ${gamePath}: ${err.message}`);
  }
}

const mirrorState = new Map();
const mirrorQueues = new Map();

const endpointFolder = (endpoint) => endpoint.replace(/[^A-Za-z0-9._-]/g, '_');

export function logMirrorPaths(endpoint, dir = remoteFilesDir()) {
  const folder = path.join(dir, 'logs', endpointFolder(endpoint));
  return { player: path.join(folder, LOG_MIRROR_NAMES.player), umm: path.join(folder, LOG_MIRROR_NAMES.umm) };
}

async function mirrorRequest(mirrorPath, known) {
  const none = { known: -1, guard: '', lastPath: null };
  if (!known) return none;
  let size;
  try {
    size = (await fs.stat(mirrorPath)).size;
  } catch {
    return none;
  }
  return { known: known.base + size, guard: (await readGuard(mirrorPath, size)).toString('base64'), lastPath: known.remotePath };
}

async function rewriteInPlace(file, bytes) {
  let handle;
  try {
    handle = await fs.open(file, 'r+');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    handle = await fs.open(file, 'w');
  }
  try {
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
}

async function syncMirrors(client, endpoint) {
  const paths = logMirrorPaths(endpoint);
  await localFolder('logs', endpointFolder(endpoint));
  const state = mirrorState.get(endpoint) ?? { player: null, umm: null };
  mirrorState.set(endpoint, state);

  const request = {};
  for (const kind of LOG_KINDS) request[kind] = await mirrorRequest(paths[kind], state[kind]);
  const first = JSON.parse(await runCode(client, logSyncCode(request), "Fetching the game's log"));

  const fetched = {};
  const later = [];
  for (const kind of LOG_KINDS) {
    const info = first[kind];
    if (!info) continue;
    const data = Buffer.from(info.data, 'base64');
    fetched[kind] = { info, parts: [data] };
    for (let offset = info.start + data.length; offset < info.size; offset += TRANSFER_MAX_BYTES) {
      later.push({ kind, path: info.path, offset, length: Math.min(TRANSFER_MAX_BYTES, info.size - offset), size: info.size, tail: info.tail });
    }
  }
  for (const call of packCalls(later)) {
    const reply = JSON.parse(await runCode(client, logChunkCode(call.map(({ kind, ...segment }) => segment)), "Fetching the game's log"));
    call.forEach((segment, i) => {
      const chunk = decoded(reply[String(i)]);
      if (chunk === null || chunk.length !== segment.length) {
        throw new Error(
          `The remote game's log ${segment.path} shrank or was rewritten while it was being fetched, so nothing was ` +
          'read this time; the next read fetches it afresh.'
        );
      }
      fetched[segment.kind].parts.push(chunk);
    });
  }

  for (const kind of LOG_KINDS) {
    const entry = fetched[kind];
    if (!entry) {
      await fs.rm(paths[kind], { force: true });
      state[kind] = null;
      continue;
    }
    let bytes = Buffer.concat(entry.parts);
    if (entry.info.append) {
      if (bytes.length > 0) await fs.appendFile(paths[kind], bytes);
    } else {
      let start = entry.info.start;
      // A window cut from a longer file starts mid-line
      if (start > 0) {
        const newline = bytes.indexOf(0x0a);
        if (newline !== -1) {
          bytes = bytes.subarray(newline + 1);
          start += newline + 1;
        }
      }
      state[kind] = null;
      await rewriteInPlace(paths[kind], bytes);
      state[kind] = { base: start, remotePath: entry.info.path };
    }
    const mtime = new Date(entry.info.mtime);
    await fs.utimes(paths[kind], mtime, mtime);
  }
  return paths;
}

export function withLogMirrors(client, endpoint, use = async (paths) => paths) {
  const previous = mirrorQueues.get(endpoint) ?? Promise.resolve();
  const run = previous.then(async () => use(await syncMirrors(client, endpoint)));
  const settled = run.catch(() => {});
  mirrorQueues.set(endpoint, settled);
  settled.then(() => {
    if (mirrorQueues.get(endpoint) === settled) mirrorQueues.delete(endpoint);
  });
  return run;
}
