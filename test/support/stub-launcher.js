import fs from 'fs/promises';
import net from 'net';
import path from 'path';

import { NO_LISTENER_PORT, NO_OP_LAUNCH_CMD } from './session.js';
import { serveConnection } from './stub-server.js';

// The launcher's own game root, which it reports as `root` and the server has no use for: instances
// live under `instancesRoot`, and a server that confused the two would derive every path from here
export const STUB_GAME_ROOT = '/opt/stub-launcher/game';

// A launcher that meets the launch contract and starts no game: it writes `port` and then `game.pid`,
// exits 75 while a control file says the cap is full, and answers `instance list --json`.
// BROFORCE_INSTANCE_CMD points straight at it, so nothing here can reach a real launcher.
export async function writeStubLauncher(binDir, instancesRoot) {
  const script = path.join(binDir, 'stub-launcher');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(script, `#!/bin/sh
root="\${STUB_INSTANCES_ROOT:-${instancesRoot}}"
stamp() { printf '[2026-01-02 03:04:05] %s\\n' "$1" >> "$dir/launch.log"; }
printf '%s\\n' "$*" >> "$root/calls.log"

while [ "\${1#-}" != "\${1:-}" ] && [ "$1" != --help ] && [ "$1" != --args-help ]; do shift; done

case "$1" in
  --help)
    [ -f "$root/slow-help" ] && sleep 2
    # A launcher that never answers at all: the probe's own budget is what ends this
    [ -f "$root/hang-help" ] && sleep 30
    # A --help that could not answer settles nothing, and is asked again
    [ -f "$root/help-fails" ] && exit 3
    printf 'Usage: stub [profile] [options]\\n'
    # One that answers and names no instance mode is a launcher without one, for good
    [ -f "$root/no-instance-mode" ] || printf '  stub instance <id> <cmd>   launch, stop, status or remove an agent instance\\n'
    [ -f "$root/no-args-help" ] || printf '  --args-help   print the launch arguments this launcher accepts\\n'
    [ -f "$root/help-nonzero" ] && exit 2
    exit 0
    ;;
  --args-help)
    if [ -f "$root/long-args-help" ]; then
      awk 'BEGIN { while (i++ < 40) print "  --pad-" i "   padding so the capture has to be cut" }'
      exit 0
    fi
    if [ -f "$root/args-help-text" ]; then
      cat "$root/args-help-text"
      exit 0
    fi
    printf 'stub launch arguments:\\n  --window WxH   the size of the window it opens\\n'
    exit 0
    ;;
esac

if [ "$1" = instance ] && [ "$2" = list ]; then
  [ -s "$root/slow-list" ] && sleep "$(cat "$root/slow-list")"
  if [ -s "$root/list-fails-after" ]; then
    left=$(cat "$root/list-fails-after")
    [ "$left" -le 0 ] && exit 1
    printf '%s' "$((left - 1))" > "$root/list-fails-after"
  fi
  if [ -f "$root/list.json" ]; then
    cat "$root/list.json"
  elif [ -n "\${STUB_STAGE_ROOT:-}" ]; then
    printf '{"instancesRoot":"%s","root":"%s","stageRoot":"%s","cap":8}\\n' "$root" '${STUB_GAME_ROOT}' "$STUB_STAGE_ROOT"
  else
    printf '{"instancesRoot":"%s","root":"%s","cap":8}\\n' "$root" '${STUB_GAME_ROOT}'
  fi
  exit 0
fi

id="$2"
action="$3"
dir="$root/$id"

# A launcher that refuses a brand-new id has created nothing for the server to claim
if [ "$action" = launch ] && [ -f "$root/creates-nothing" ]; then
  printf 'launch: this instance id is not one I will create\\n' >&2
  exit 3
fi

# What the server wrote before running this command, so a test can see the ownership claim
if [ "$action" = launch ]; then
  if [ -f "$dir/owner.pid" ]; then
    cp "$dir/owner.pid" "$root/owner-at-launch"
  else
    rm -f "$root/owner-at-launch"
  fi
fi

# A launcher creates a missing instance as the first act of its launch
if [ "$action" = launch ] && [ ! -d "$dir" ]; then
  [ -f "$root/create-late" ] && sleep 1
  mkdir -p "$dir/profile"
fi
mkdir -p "$dir"

case "$action" in
  launch)
    # A directory holding no profile is not an instance this launcher can launch into
    if [ ! -d "$dir/profile" ]; then
      stamp "instance profile missing: $dir/profile"
      exit 1
    fi
    if [ -f "$root/stderr-only" ]; then
      printf 'launch: no display could be created for this instance\n' >&2
      exit 3
    fi
    if [ -f "$root/slow-launch" ]; then
      stamp "launch: still setting the instance up"
      sleep 3
      stamp "launch: set up"
      exit 0
    fi
    if [ -s "$root/cap-refusals" ]; then
      left=$(cat "$root/cap-refusals")
      printf '%s' "$((left - 1))" > "$root/cap-refusals"
      [ "$((left - 1))" -le 0 ] && rm -f "$root/cap-refusals"
      # A port this refusal leaves behind is not the next launch's allocation
      [ -f "$root/decoy-port" ] && cat "$root/decoy-port" > "$dir/port"
      stamp "launch: cap reached: 8 running: busy-one, busy-two"
      exit 75
    fi
    if [ -f "$root/slow-fail" ]; then
      sleep 1
      stamp "launch: refused, the display could not be created"
      exit 3
    fi
    if [ -f "$root/launch-terminated" ]; then
      stamp "launch: terminated by SIGTERM (a stop or remove of instance $id sends one)"
      printf 'Error: launch: terminated by SIGTERM (a stop or remove of instance %s sends one)\\n' "$id" >&2
      exit 1
    fi
    if [ -f "$root/launch-fails" ]; then
      stamp "launch: refused, the display could not be created"
      printf 'raw game noise\\n' >> "$dir/launch.log"
      exit 3
    fi
    if [ -f "$root/bad-port" ]; then
      printf 'not-a-port\\n' > "$dir/port"
      stamp "launch: ready"
      exit 0
    fi
    stamp "launch: syncing the profile"
    if [ -f "$root/allocated-port" ] && [ ! -f "$root/skip-port" ]; then
      cat "$root/allocated-port" > "$dir/port"
      printf '4242\\n' > "$dir/game.pid"
    fi
    stamp "launch: ready"
    exit 0
    ;;
  stop)
    if [ -s "$root/stop-refused" ]; then
      stamp "$(cat "$root/stop-refused")"
      printf 'Error: %s\\n' "$(cat "$root/stop-refused")" >&2
      exit 1
    fi
    stamp "stop: done"
    rm -f "$dir/game.pid"
    [ -f "$root/stop-fails" ] && exit 4
    exit 0
    ;;
  remove)
    stamp "remove: done"
    rm -rf "$dir"
    exit 0
    ;;
esac

printf 'unknown command: %s\\n' "$*" >&2
exit 64
`, { mode: 0o755 });
  return script;
}

// The environment an instance test runs in: its own instances root, its own session id, and
// BROFORCE_INSTANCE_CMD pointing straight at the stub, so no real launcher is reachable. The server
// learns both roots from the stub's own list header, exactly as it would from a real launcher
export async function useStubLauncher({ session, root, binDir, stageRoot = path.join(root, 'stages') }) {
  const launcher = await writeStubLauncher(binDir, root);
  process.env.CLAUDE_SESSION_ID = session;
  process.env.BROFORCE_INSTANCE_CMD = launcher;
  process.env.STUB_INSTANCES_ROOT = root;
  // A stage root of its own, reported in the same header, so no test can read the stages of the
  // session running them
  process.env.STUB_STAGE_ROOT = stageRoot;
  // The user's-game launch stays the no-op every test entry point starts with: a launch that fell
  // through to the `steam` target must never be a real one
  process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
  // Restored, never deleted: unset, the `steam` target falls back to the port the user's game listens on
  process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
  delete process.env.UNITY_INSPECTOR_LOG;
  return { instanceDir: path.join(root, session), launcher, stageRoot, stagePath: path.join(stageRoot, session, 'UMM') };
}

// An instance directory as a launch has already left it: the profile is what tells the launcher the
// instance exists, so a test that wants a launch into an existing instance seeds one
export async function seedInstanceDir(instanceDir) {
  await fs.mkdir(path.join(instanceDir, 'profile'), { recursive: true });
  return instanceDir;
}

export function fakeInspector({ answers = true, hello = 'accept' } = {}) {
  return new Promise((resolve, reject) => {
    const sockets = [];
    const state = { hello, hellos: [], firstLines: [], lines: [] };
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
      serveConnection(socket, state, (request) => {
        if (answers) socket.write(JSON.stringify({ id: request.id, success: true, result: {} }) + '\n');
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      get hello() { return state.hello; },
      set hello(mode) { state.hello = mode; },
      hellos: state.hellos,
      firstLines: state.firstLines,
      lines: state.lines,
      close: () => {
        for (const socket of sockets) socket.destroy();
        return new Promise(done => server.close(done));
      },
    }));
  });
}

// The launcher prints its list as JSON Lines: a header carrying instancesRoot — the stub's own
// instances root, which is where the server learns where instances live — stageRoot where the
// launcher stages one, its own unrelated `root`, and cap from a launcher that caps running
// instances, an undefined cap being one that reports none. Then one line per instance directory.
// The fixtures are that layout and nothing else.
export function instanceListJsonl(
  cap,
  instances = [],
  instancesRoot = process.env.STUB_INSTANCES_ROOT,
  stageRoot = process.env.STUB_STAGE_ROOT,
) {
  return [
    JSON.stringify({ instancesRoot, root: STUB_GAME_ROOT, stageRoot, cap }),
    ...instances.map(entry => JSON.stringify({
      id: String(entry.id),
      running: entry.running ? 1 : 0,
      pid: entry.pid ?? null,
      port: entry.port ?? null,
      display: entry.display ?? '',
      last_launch: entry.last_launch ?? 1788687953,
      stale: entry.stale ?? 0,
    })),
  ].join('\n') + '\n';
}

// A stop command for the user's game, as BROFORCE_STOP_CMD names one: it leaves a marker the fake
// /proc reader follows, or a control file makes it leave the game running
export async function writeStubStopCommand(binDir, root) {
  const script = path.join(binDir, 'stub-stop');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(script, `#!/bin/sh
printf 'stop %s\\n' "$*" >> '${root}/calls.log'
if [ -f '${root}/stop-leaves-survivor' ]; then
  printf 'stop: the game did not go away\\n' >&2
  exit 0
fi
: > '${root}/user-game-stopped'
exit 0
`, { mode: 0o755 });
  return script;
}
