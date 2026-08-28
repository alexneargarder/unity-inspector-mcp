// Platform-aware Broforce process detection, termination, and launching.
//
// Every helper here spawns children with stdio "ignore" or piped stdout only —
// nothing may reach this process's stdout, which carries the MCP protocol.

import { spawn } from 'child_process';

export const STEAM_APP_ID = 274190;
export const STEAM_LAUNCH_URL = `steam://rungameid/${STEAM_APP_ID}`;

// The bracketed first characters keep the pattern from matching the `sh -c`
// wrapper that runs it: the literal command text contains "[B]roforce" and
// "[.]e[x]e", neither of which the regex matches.
export const POSIX_GAME_CHECK_CMD =
  "pgrep -x 'Broforce.x86_64' >/dev/null 2>&1 || " +
  "pgrep -x Broforce >/dev/null 2>&1 || " +
  "pgrep -f '[B]roforce.*[.]e[x]e' >/dev/null 2>&1";

export const POSIX_GAME_KILL_CMD =
  "r=1; " +
  "pkill -9 -x 'Broforce.x86_64' 2>/dev/null && r=0; " +
  "pkill -9 -x Broforce 2>/dev/null && r=0; " +
  "pkill -9 -f '[B]roforce.*[.]e[x]e' 2>/dev/null && r=0; " +
  "exit $r";

export const WINDOWS_IMAGE_NAMES = ['Broforce.exe', 'Broforce_beta.exe'];

const isWindows = () => process.platform === 'win32';

/**
 * Spawn a child, never letting a spawn failure escape as an uncaught exception.
 * Resolves { code, signal, stdout, stderr, error }. `error` is set when the
 * process could not be spawned at all (ENOENT, EACCES, ...).
 */
export function runChild(command, args, { timeoutMs = 10000, capture = true } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore'],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ code: null, signal: 'SIGKILL', stdout, stderr, error: new Error('Timed out') });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => finish({ code: null, signal: null, stdout, stderr, error }));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr, error: null }));
  });
}

/**
 * Is a Broforce process running?
 *   true  — found
 *   false — definitively not found
 *   null  — could not tell (no pgrep/tasklist, unexpected exit code, ...)
 * Callers must treat null as "unknown" and never as a crash.
 */
export async function isGameRunning() {
  if (isWindows()) return isGameRunningWindows();

  const { code, error } = await runChild('sh', ['-c', POSIX_GAME_CHECK_CMD], { capture: false });
  if (error) return null;
  if (code === 0) return true;
  if (code === 1) return false;
  return null; // 127 = pgrep missing, 2/3 = pgrep failure
}

async function isGameRunningWindows() {
  let sawUsableAnswer = false;

  for (const image of WINDOWS_IMAGE_NAMES) {
    const { code, stdout, error } = await runChild('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH']);
    // tasklist exits 0 even when the filter matches nothing, so inspect output.
    if (error || code !== 0) continue;
    sawUsableAnswer = true;
    if (stdout.toLowerCase().includes(image.toLowerCase())) return true;
  }

  return sawUsableAnswer ? false : null;
}

/**
 * Kill any running Broforce process.
 * Resolves { killed, detail } — `killed` is false when nothing matched.
 */
export async function killGame() {
  if (isWindows()) {
    const killedImages = [];
    const failures = [];
    for (const image of WINDOWS_IMAGE_NAMES) {
      const { code, error, stderr } = await runChild('taskkill', ['/F', '/IM', image]);
      if (error) {
        failures.push(`could not run taskkill for ${image}: ${error.message}`);
      } else if (code === 0) {
        killedImages.push(image);
      } else if (code !== 128) {
        // 128 = "process not found", which is not a failure worth reporting.
        failures.push(`${image}: taskkill exited ${code}${stderr.trim() ? ` (${stderr.trim()})` : ''}`);
      }
    }
    if (killedImages.length > 0) {
      return { killed: true, detail: `Killed ${killedImages.join(', ')}` };
    }
    if (failures.length > 0) {
      return { killed: false, unknown: true, detail: failures.join('; ') };
    }
    return { killed: false, detail: 'No Broforce process was running' };
  }

  // Distinguish "pkill is missing" from "nothing matched" — the kill command
  // silences stderr, so a 127 would otherwise read as a clean no-op.
  const probe = await runChild('sh', ['-c', 'command -v pkill >/dev/null 2>&1'], { capture: false });
  if (probe.error || probe.code !== 0) {
    return {
      killed: false,
      unknown: true,
      detail: 'pkill is not available on this system, so the game could not be stopped',
    };
  }

  const { code, error, stderr } = await runChild('sh', ['-c', POSIX_GAME_KILL_CMD]);
  if (error) {
    return { killed: false, unknown: true, detail: `Could not run pkill: ${error.message}` };
  }
  if (code === 0) {
    return { killed: true, detail: 'Killed the running Broforce process' };
  }
  if (code !== 1) {
    return {
      killed: false,
      unknown: true,
      detail: `pkill exited ${code}${stderr.trim() ? ` (${stderr.trim()})` : ''}`,
    };
  }
  return { killed: false, detail: 'No Broforce process was running' };
}

/**
 * Split a launch command string into command + args.
 * Handles single quotes, double quotes and backslash escapes.
 */
export function tokenizeCommand(input) {
  const tokens = [];
  let current = '';
  let hasCurrent = false;
  let quote = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasCurrent = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      hasCurrent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasCurrent) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += ch;
    hasCurrent = true;
  }

  if (hasCurrent) tokens.push(current);
  return tokens;
}

/**
 * Work out how to start the game.
 * BROFORCE_LAUNCH_CMD wins when set; otherwise fall back to a platform
 * appropriate Steam protocol launch, which ignores extra args.
 */
export function resolveLaunchCommand(extraArgs = [], env = process.env, platform = process.platform) {
  const custom = (env.BROFORCE_LAUNCH_CMD || '').trim();

  if (custom) {
    const tokens = tokenizeCommand(custom);
    if (tokens.length === 0) {
      throw new Error('BROFORCE_LAUNCH_CMD is set but contains no command');
    }
    return {
      source: 'BROFORCE_LAUNCH_CMD',
      command: tokens[0],
      args: [...tokens.slice(1), ...extraArgs],
      display: [...tokens, ...extraArgs].join(' '),
      ignoredArgs: [],
    };
  }

  const steam = {
    source: 'steam',
    ignoredArgs: extraArgs,
  };

  if (platform === 'win32') {
    return {
      ...steam,
      command: 'cmd',
      args: ['/c', 'start', '', STEAM_LAUNCH_URL],
      display: `cmd /c start "" ${STEAM_LAUNCH_URL}`,
    };
  }
  if (platform === 'darwin') {
    return {
      ...steam,
      command: 'open',
      args: [STEAM_LAUNCH_URL],
      display: `open ${STEAM_LAUNCH_URL}`,
    };
  }
  return {
    ...steam,
    command: 'sh',
    args: [
      '-c',
      'if command -v steam >/dev/null 2>&1; then exec steam "$1"; else exec xdg-open "$1"; fi',
      'sh',
      STEAM_LAUNCH_URL,
    ],
    display: `steam ${STEAM_LAUNCH_URL} (falling back to xdg-open)`,
  };
}

/**
 * Spawn a detached, fully-ignored child and report spawn failures as a
 * rejection instead of an async uncaught exception.
 */
export function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(child);
    });
  });
}
