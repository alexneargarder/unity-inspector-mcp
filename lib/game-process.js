import { spawn } from 'child_process';

export const STEAM_APP_ID = 274190;
export const STEAM_LAUNCH_URL = `steam://rungameid/${STEAM_APP_ID}`;

// The bracketed first characters keep the pattern from matching the `sh -c` wrapper that runs it
export const POSIX_GAME_CHECK_CMD =
  "pgrep -x 'Broforce.x86_64' >/dev/null 2>&1 || " +
  "pgrep -x Broforce >/dev/null 2>&1 || " +
  "pgrep -f '[B]roforce.*[.]e[x]e' >/dev/null 2>&1";

export const POSIX_GAME_PID_CMD =
  "pgrep -x 'Broforce.x86_64' 2>/dev/null || " +
  "pgrep -x Broforce 2>/dev/null";

// Under Proton the process name is the wine loader, so the game is only findable by command line
export const POSIX_GAME_CMDLINE_PID_CMD =
  "pgrep -f '[B]roforce.*[.]e[x]e' 2>/dev/null";

export const POSIX_GAME_KILL_CMD =
  "r=1; " +
  "pkill -9 -x 'Broforce.x86_64' 2>/dev/null && r=0; " +
  "pkill -9 -x Broforce 2>/dev/null && r=0; " +
  "pkill -9 -f '[B]roforce.*[.]e[x]e' 2>/dev/null && r=0; " +
  "exit $r";

export const WINDOWS_IMAGE_NAMES = ['Broforce.exe', 'Broforce_beta.exe'];

const isWindows = () => process.platform === 'win32';

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

export function parseWmicCreationDate(raw) {
  const match = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{1,4})/.exec(String(raw).trim());
  if (!match) return null;
  const utc = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
    Math.floor(Number(match[7]) / 1000),
  );
  return utc - Number(match[8]) * 60000;
}

function pidsFrom(result) {
  if (result.error || result.code !== 0) return [];
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

// Number('') is 0, which would read as "started this instant", so blank lines go first
export function startFromEtimes(stdout, now = Date.now(), pick = 'earliest') {
  const seconds = String(stdout ?? '').split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter(value => Number.isFinite(value));
  if (seconds.length === 0) return null;
  return now - (pick === 'latest' ? Math.min(...seconds) : Math.max(...seconds)) * 1000;
}

export function startFromLstart(stdout, pick = 'earliest') {
  const times = String(stdout ?? '').split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map(line => Date.parse(line))
    .filter(value => Number.isFinite(value));
  if (times.length === 0) return null;
  return pick === 'latest' ? Math.max(...times) : Math.min(...times);
}

export async function gameStartTime() {
  if (isWindows()) {
    const starts = [];
    for (const image of WINDOWS_IMAGE_NAMES) {
      const { code, stdout, error } = await runChild('wmic', [
        'process', 'where', `name='${image}'`, 'get', 'CreationDate',
      ]);
      if (error || code !== 0) continue;
      for (const line of stdout.replace(/\0/g, '').split('\n')) {
        const parsed = parseWmicCreationDate(line);
        if (parsed !== null) starts.push(parsed);
      }
    }
    return starts.length > 0 ? Math.min(...starts) : null;
  }

  const byName = pidsFrom(await runChild('sh', ['-c', POSIX_GAME_PID_CMD]));
  // Command-line matches include the launcher chain, so the game is the last of them to start
  const pick = byName.length > 0 ? 'earliest' : 'latest';
  const pids = byName.length > 0
    ? byName
    : pidsFrom(await runChild('sh', ['-c', POSIX_GAME_CMDLINE_PID_CMD]));
  if (pids.length === 0) return null;

  // etimes (elapsed seconds) is procps/BSD only; lstart is the portable answer.
  const elapsed = await runChild('ps', ['-o', 'etimes=', '-p', pids.join(',')]);
  if (!elapsed.error && elapsed.code === 0) {
    const start = startFromEtimes(elapsed.stdout, Date.now(), pick);
    if (start !== null) return start;
  }

  const started = await runChild('ps', ['-o', 'lstart=', '-p', pids.join(',')]);
  if (!started.error && started.code === 0) {
    const start = startFromLstart(started.stdout, pick);
    if (start !== null) return start;
  }

  return null;
}

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

  // The kill command silences stderr, so a missing pkill (127) would otherwise read as a clean no-op
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

// The bracketed "[B]roforce" keeps the pattern from matching the `sh -c` wrapper that carries it
export const POSIX_PROFILE_SCAN_CMD =
  "pgrep -fa 'r2modmanPlus-local/[B]roforce/profiles/'";

// A profile name containing a space must not truncate into a match on a different profile
const PROFILE_PATH_RE = /r2modmanPlus-local[\/\\]Broforce[\/\\]profiles[\/\\]([^\/\\\s"']+)(?=[\/\\])/g;

// A second distinct profile name in the scan must make detection return null, not pick one
const LAUNCHER_LINE_RE = /run_umm\.sh|doorstop/i;

export function extractProfileName(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    if (!LAUNCHER_LINE_RE.test(line)) continue;
    for (const match of line.matchAll(PROFILE_PATH_RE)) {
      names.add(match[1]);
    }
  }
  return names.size === 1 ? [...names][0] : null;
}

export async function detectActiveProfile() {
  if ((await isGameRunning()) !== true) return null;

  if (isWindows()) {
    const { code, stdout, error } = await runChild('wmic', [
      'process', 'where', "CommandLine like '%r2modmanPlus-local%Broforce%profiles%'", 'get', 'CommandLine',
    ]);
    if (error || code !== 0) return null;
    // wmic emits UTF-16LE when redirected; dropping the NULs recovers the paths
    return extractProfileName(stdout.replace(/\0/g, ''));
  }

  const { code, stdout, error } = await runChild('sh', ['-c', POSIX_PROFILE_SCAN_CMD]);
  if (error || code !== 0) return null;
  return extractProfileName(stdout);
}

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

  if (quote) {
    throw new Error(`Unbalanced ${quote === '"' ? 'double' : 'single'} quote in command string`);
  }
  if (hasCurrent) tokens.push(current);
  return tokens;
}

export function composeExtraLaunchArgs({ vanilla, launchArgs } = {}) {
  const extra = vanilla ? ['--vanilla'] : [];
  if (launchArgs != null) {
    if (typeof launchArgs !== 'string') {
      throw new Error(`launchArgs must be a string, got ${typeof launchArgs}`);
    }
    extra.push(...tokenizeCommand(launchArgs));
  }
  return extra;
}

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
