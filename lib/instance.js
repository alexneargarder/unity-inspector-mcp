import path from 'path';

import { tokenizeCommand } from './command-line.js';

// The launch contract's id pattern: the session UUID as Claude Code sets it
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const UMM_LOG_IN_INSTANCE = ['profile', 'UMM', 'Core', 'Log.txt'];
const PLAYER_LOG_IN_INSTANCE = ['home', 'unity3d', 'Free Lives', 'Broforce', 'Player.log'];

export const NO_INSTANCE_REASONS = {
  notLinux: 'agent instances are a Linux arrangement, and this server is not on Linux',
  noSessionId: 'CLAUDE_SESSION_ID is not set, so this server has no session of its own to give an instance to',
  malformedId: 'CLAUDE_SESSION_ID is not a usable instance id',
  noLauncher: 'BROFORCE_INSTANCE_CMD is not set, so this server has no launcher to create an instance with',
  unusableLauncher: 'BROFORCE_INSTANCE_CMD could not be read as a command',
};

// The command that creates, launches, stops and lists instances: a program plus any leading
// arguments of its own, in the shell-style form BROFORCE_LAUNCH_CMD takes
export function instanceLauncher(env = process.env) {
  const raw = String(env.BROFORCE_INSTANCE_CMD ?? '').trim();
  if (!raw) return { tokens: null, reason: NO_INSTANCE_REASONS.noLauncher };
  let tokens;
  try {
    tokens = tokenizeCommand(raw);
  } catch (error) {
    return { tokens: null, reason: `${NO_INSTANCE_REASONS.unusableLauncher} (${error.message})` };
  }
  return tokens.length > 0
    ? { tokens, reason: null }
    : { tokens: null, reason: NO_INSTANCE_REASONS.unusableLauncher };
}


let warnedAboutId = null;

export function resetInstanceIdWarning() {
  warnedAboutId = null;
}

// A malformed id is reported once and then treated as absent: it is never a reason to fail
export function sessionInstanceId(env = process.env, {
  platform = process.platform,
  warn = (message) => console.error(message),
} = {}) {
  if (platform !== 'linux') return { id: null, reason: NO_INSTANCE_REASONS.notLinux };

  const raw = String(env.CLAUDE_SESSION_ID ?? '').trim();
  if (!raw) return { id: null, reason: NO_INSTANCE_REASONS.noSessionId };

  if (!SESSION_ID_RE.test(raw)) {
    if (warnedAboutId !== raw) {
      warnedAboutId = raw;
      warn(
        `CLAUDE_SESSION_ID="${raw}" does not match ${SESSION_ID_RE}, so this server has no agent instance ` +
        `and serves the user's game instead.`
      );
    }
    return { id: null, reason: `${NO_INSTANCE_REASONS.malformedId} ("${raw}" does not match ${SESSION_ID_RE})` };
  }

  return { id: raw, reason: null };
}

// The launcher and the commands that name no instance — `--help` and the list. A session with no
// instance of its own still asks both: the instances root is what tells the user's game from
// another session's, and only the launcher knows it
export function launcherConfig(env = process.env) {
  const launcher = instanceLauncher(env);
  if (launcher.tokens === null) {
    return { launchCommand: null, leadingArgs: [], listArgs: [], reason: launcher.reason };
  }
  const [command, ...leading] = launcher.tokens;
  return {
    launchCommand: command,
    // The setting's own leading arguments go to --help as they do to every other verb
    leadingArgs: leading,
    listArgs: [...leading, 'instance', 'list', '--json'],
    reason: null,
  };
}

// The instances root is the launcher's to report, never this server's to assume: `withRoot()` is
// what turns the derivation below into paths, once `instance list --json` has named the root
export function withRoot(config, instancesRoot, { stageRoot = null } = {}) {
  if (typeof instancesRoot !== 'string' || instancesRoot === '') {
    throw new Error('The instances root must be the path the launcher reported');
  }
  const based = { ...config, instancesRoot, stageRoot: stageRoot || null };
  if (!config.isAgentInstance) return based;

  const instanceRoot = path.join(instancesRoot, config.id);
  return {
    ...based,
    root: instanceRoot,
    workDir: path.join(instanceRoot, 'work'),
    pidfile: path.join(instanceRoot, 'game.pid'),
    portFile: path.join(instanceRoot, 'port'),
    launchLog: path.join(instanceRoot, 'launch.log'),
    // The wrapper that owns this instance id, written by the server and read by the wrapper
    ownerFile: path.join(instanceRoot, 'owner.pid'),
    ummLog: path.join(instanceRoot, ...UMM_LOG_IN_INSTANCE),
    playerLog: path.join(instanceRoot, ...PLAYER_LOG_IN_INSTANCE),
  };
}

// The user's game: every Broforce process that is not running inside an instance
export function steamConfig() {
  return { id: null, isAgentInstance: false, instancesRoot: null, stageRoot: null, root: null, reason: null };
}

// The session's own instance: its id and the commands that manage it. The paths come later, from
// the root the launcher reports, so nothing here needs to know where instances live
export function instanceConfig(env = process.env, options = {}) {
  const { id, reason } = sessionInstanceId(env, options);
  const noInstance = { ...steamConfig(), reason };
  if (id === null) return noInstance;

  const launcher = launcherConfig(env);
  if (launcher.launchCommand === null) return { ...noInstance, reason: launcher.reason };
  const leading = launcher.leadingArgs;

  return {
    ...launcher,
    id,
    isAgentInstance: true,
    reason: null,
    instancesRoot: null,
    stageRoot: null,
    root: null,
    // The launcher allocates the port and writes it to portFile; the server never asks for one
    launchArgs: [...leading, 'instance', id, 'launch'],
    stopArgs: [...leading, 'instance', id, 'stop'],
    removeArgs: [...leading, 'instance', id, 'remove'],
  };
}
