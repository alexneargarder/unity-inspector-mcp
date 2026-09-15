export const FAKE_BOOT_TIME_MS = Date.parse('2026-01-01T00:00:00Z');

// A /proc/<pid>/stat line: ppid is field 4 and starttime field 22, with filler in between
function statLine(pid, comm, ppid, startTicks) {
  return `${pid} (${comm}) S ${ppid} ${Array(17).fill(0).join(' ')} ${startTicks} 0 0\n`;
}

export function fakeProcReader(processes, { bootTimeMs = FAKE_BOOT_TIME_MS } = {}) {
  const entry = (pid) => processes[String(pid)] ?? null;

  return {
    async pids() {
      return Object.keys(processes);
    },
    async comm(pid) {
      const proc = entry(pid);
      return proc ? `${proc.comm}\n` : null;
    },
    async stat(pid) {
      const proc = entry(pid);
      return proc ? statLine(pid, proc.comm, proc.ppid ?? 1, proc.startTicks ?? 0) : null;
    },
    async cmdline(pid) {
      const proc = entry(pid);
      return proc?.cmdline ? proc.cmdline.replace(/ /g, '\0') : null;
    },
    async environ(pid) {
      const proc = entry(pid);
      return proc?.environ ? proc.environ.replace(/ /g, '\0') : null;
    },
    async cwd(pid) {
      return entry(pid)?.cwd ?? null;
    },
    async bootTimeMs() {
      return bootTimeMs;
    },
  };
}

export function fakeFileSystem(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    async readFile(file) {
      if (!store.has(file)) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      return store.get(file);
    },
    async unlink(file) {
      if (!store.delete(file)) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
    },
  };
}

// diesOnKillAfter models the real gap between SIGKILL and the process leaving the table
export function recordingKill({ diesOnTerm = false, diesOnKillAfter = 0, startsDead = [] } = {}) {
  const calls = [];
  const dead = new Set(startsDead);
  const dying = new Map();
  const kill = (pid, signal) => {
    calls.push({ pid, signal });
    if (dead.has(pid)) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    if (signal === 0) {
      if (dying.has(pid)) {
        const left = dying.get(pid) - 1;
        if (left <= 0) {
          dying.delete(pid);
          dead.add(pid);
        } else {
          dying.set(pid, left);
        }
      }
      return true;
    }
    if (signal === 'SIGTERM' && diesOnTerm) dead.add(pid);
    if (signal === 'SIGKILL') {
      if (diesOnKillAfter > 0) dying.set(pid, diesOnKillAfter);
      else dead.add(pid);
    }
    return true;
  };
  kill.calls = calls;
  kill.signalsFor = (pid) => calls.filter(call => call.pid === pid).map(call => call.signal);
  return kill;
}
