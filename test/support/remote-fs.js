import path from 'path';

import { CODE_MARK, listCode, logChunkCode, logSyncCode, readCode, removeDirCode, sentinelCode, statCode, writeCode } from '../../lib/remote-files.js';
import { reply } from './stub-server.js';

const BUILDERS = {
  read: ({ segments }) => readCode(segments),
  stat: ({ paths }) => statCode(paths),
  write: writeCode,
  removeDir: ({ path: folder, pruneParent }) => removeDirCode(folder, { pruneParent }),
  list: listCode,
  sentinel: sentinelCode,
  logSync: logSyncCode,
  logChunk: ({ segments }) => logChunkCode(segments),
};
const GUARD = 256;

// The game's filesystem as the stub mod sees it: each transfer's code is checked against its builder
// and answered as the game would; `hooks[op]` runs before an answer and may change the files
export function fakeRemoteFs({
  persistentDataPath = '/game/home/.config/unity3d/Free Lives/Broforce',
  dataPath = '/game/Broforce/Broforce_Data',
  ummLog = '/game/Broforce/Broforce_Data/Managed/UnityModManager/Log.txt',
  temporaryCachePath = '/game/home/.cache/unity3d/Free Lives/Broforce',
  processId = 7310,
  machine = { files: new Map(), clock: Date.parse('2026-05-01T00:00:00Z') },
} = {}) {
  const { files } = machine;
  const remote = {
    files,
    machine,
    calls: [],
    hooks: {},
    fail: {},
    persistentDataPath,
    dataPath,
    ummLog,
    temporaryCachePath,
    processId,
    playerLog: path.posix.join(persistentDataPath, 'Player.log'),
    now: () => machine.clock,
    write(file, bytes, mtimeMs = (machine.clock += 1000)) {
      files.set(file, { bytes: Buffer.from(bytes), mtimeMs });
    },
    append(file, bytes) {
      const old = files.get(file)?.bytes ?? Buffer.alloc(0);
      remote.write(file, Buffer.concat([old, Buffer.from(bytes)]));
    },
    bytesOf: (file) => files.get(file)?.bytes ?? null,
    callsOf: (op) => remote.calls.filter((call) => call.op === op),
    fetchedBytes: (op) => remote.callsOf(op).reduce((sum, call) => sum + call.bytes, 0),
    handle(code) {
      const first = code.slice(0, code.indexOf('\n'));
      if (!first.startsWith(`${CODE_MARK} `)) return null;
      const [, op, json] = /^\/\/ remote-files (\w+) (.*)$/.exec(first);
      const params = JSON.parse(json);
      if (op === 'write') params.data = /System\.Convert\.FromBase64String\("([A-Za-z0-9+/=]*)"\)/.exec(code)[1];
      if (BUILDERS[op](params) !== code) throw new Error(`the ${op} code differs from what its builder makes`);
      remote.hooks[op]?.(params);
      if (remote.fail[op]) throw new Error(remote.fail[op]);
      const call = { op, params, bytes: 0 };
      remote.calls.push(call);
      return ANSWERS[op](remote, params, call);
    },
  };
  return remote;
}

const slice = (bytes, offset, length) => bytes.subarray(Math.min(offset, bytes.length), Math.min(bytes.length, offset + length));

const ANSWERS = {
  read(remote, { segments }, call) {
    const out = {};
    segments.forEach((segment, i) => {
      const file = remote.files.get(segment.path);
      const data = file ? slice(file.bytes, segment.offset, segment.length) : null;
      call.bytes += data?.length ?? 0;
      out[i] = data ? data.toString('base64') : null;
    });
    return JSON.stringify(out);
  },
  stat(remote, { paths }) {
    return JSON.stringify(Object.fromEntries(paths.map((file, i) => [i, remote.files.get(file)?.bytes.length ?? null])));
  },
  write(remote, { path: file, append, data }, call) {
    const bytes = Buffer.from(data, 'base64');
    call.bytes = bytes.length;
    if (append) remote.append(file, bytes);
    else remote.write(file, bytes);
    return String(remote.files.get(file).bytes.length);
  },
  removeDir(remote, { path: folder }) {
    const under = [...remote.files.keys()].filter((file) => file.startsWith(`${folder}/`));
    for (const file of under) remote.files.delete(file);
    return under.length > 0 ? 'removed' : 'absent';
  },
  list(remote, { path: folder, underCache }) {
    const root = underCache ? path.posix.join(remote.temporaryCachePath, folder) : folder;
    const dirs = new Map();
    const files = [];
    for (const [file, { mtimeMs }] of remote.files) {
      if (!file.startsWith(`${root}/`)) continue;
      const [first, second, ...rest] = file.slice(root.length + 1).split('/');
      if (second === undefined) {
        files.push(first);
        continue;
      }
      const dir = dirs.get(first) ?? { name: first, newest: mtimeMs, runs: new Map() };
      dir.newest = Math.max(dir.newest, mtimeMs);
      if (rest.length > 0) dir.runs.set(second, Math.max(dir.runs.get(second) ?? mtimeMs, mtimeMs));
      dirs.set(first, dir);
    }
    return JSON.stringify({
      root,
      pid: remote.processId,
      now: remote.now(),
      dirs: [...dirs.values()].map(({ name, newest, runs }) => ({ name, newest, dirs: [...runs].map(([run, latest]) => ({ name: run, newest: latest })) })),
      files,
    });
  },
  sentinel(remote, { path: folder, done, error, progress }) {
    const at = (name) => remote.files.get(path.posix.join(folder, name));
    const failure = at(error);
    const stamp = at(progress);
    return JSON.stringify({
      error: failure ? failure.bytes.toString('base64') : null,
      done: Boolean(at(done)),
      progress: stamp ? `${stamp.mtimeMs}:${stamp.bytes.length}` : null,
    });
  },
  logSync(remote, { player, umm, window, budget }, call) {
    const candidates = [
      path.posix.join(remote.persistentDataPath, 'Player.log'),
      path.posix.join(remote.persistentDataPath, 'output_log.txt'),
      path.posix.join(remote.dataPath, 'output_log.txt'),
    ];
    let chosen = null;
    for (const candidate of candidates) {
      const file = remote.files.get(candidate);
      if (file && (!chosen || file.mtimeMs > remote.files.get(chosen).mtimeMs)) chosen = candidate;
    }
    const paths = { player: chosen, umm: remote.files.has(remote.ummLog) ? remote.ummLog : null };
    const requests = { player, umm };
    const out = {};
    for (const kind of ['player', 'umm']) {
      if (!paths[kind]) {
        out[kind] = null;
        continue;
      }
      const { bytes, mtimeMs } = remote.files.get(paths[kind]);
      const { known, guard, lastPath } = requests[kind];
      const size = bytes.length;
      const expected = Buffer.from(guard, 'base64');
      let start = -1;
      if (known >= expected.length && paths[kind] === lastPath && known <= size && size - known <= window
        && bytes.subarray(known - expected.length, known).equals(expected)) {
        start = known;
      }
      const append = start >= 0;
      if (!append) start = Math.max(0, size - window);
      const data = bytes.subarray(start, start + Math.min(size - start, budget));
      budget -= data.length;
      call.bytes += data.length;
      const tail = start + data.length < size ? bytes.subarray(size - Math.min(size, GUARD), size) : Buffer.alloc(0);
      out[kind] = { path: paths[kind], size, mtime: mtimeMs, start, append, data: data.toString('base64'), tail: tail.toString('base64') };
    }
    return JSON.stringify(out);
  },
  logChunk(remote, { segments }, call) {
    const out = {};
    segments.forEach((segment, i) => {
      const bytes = remote.files.get(segment.path)?.bytes;
      const tail = Buffer.from(segment.tail, 'base64');
      const same = bytes && bytes.length >= segment.size && bytes.subarray(segment.size - tail.length, segment.size).equals(tail);
      const data = same ? slice(bytes, segment.offset, segment.length) : null;
      call.bytes += data?.length ?? 0;
      out[i] = data ? data.toString('base64') : null;
    });
    return JSON.stringify(out);
  },
};

// A stub-server handler answering execute_code from the fake filesystem, and every other command through `others`
export function remoteFsHandler(remote, others = {}) {
  return async (request, socket) => {
    if (request.method === 'execute_code') {
      let result;
      try {
        result = remote.handle(request.params.code);
      } catch (err) {
        return reply(socket, request.id, { success: false, error: err.message });
      }
      if (result !== null) return reply(socket, request.id, { success: true, resultSet: true, result });
    }
    const answer = others[request.method];
    if (typeof answer === 'function') return answer(request, socket);
    return reply(socket, request.id, answer ?? {});
  };
}
