import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { isGameRunning } from './game-process.js';
import { collectLogDelta, snapshotLogs } from './log-delta.js';
import { toolCommand } from './unity-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
export const CSHARP_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'csharp');
export const TEST_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'tests');

export const NODE_ONLY_TOOLS = new Set([
  'capture_animations',
  'launch_game',
  'stop_game',
  'read_log',
  'list_scripts',
  'list_test_scripts',
  'run_test_script',
  'wait_for_game',
  'restart_server',
]);

const SOURCE_REQUIRED_TOOLS = new Set(['execute_script']);

const EXPECT_KEYS = ['success', 'contains', 'notContains'];

function expectProblems(expect) {
  if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) {
    return ['"expect" must be an object'];
  }

  const problems = [];
  for (const key of Object.keys(expect)) {
    if (!EXPECT_KEYS.includes(key)) {
      problems.push(`unknown "expect" key "${key}" (allowed: ${EXPECT_KEYS.join(', ')})`);
    }
  }
  if ('success' in expect && typeof expect.success !== 'boolean') {
    problems.push('"expect.success" must be a boolean');
  }
  for (const key of ['contains', 'notContains']) {
    if (!(key in expect)) continue;
    const value = expect[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      problems.push(`"expect.${key}" must be an array of strings`);
    } else if (value.length === 0) {
      problems.push(`"expect.${key}" must not be empty`);
    }
  }
  if (!EXPECT_KEYS.some((key) => key in expect)) {
    problems.push(`"expect" must check at least one of ${EXPECT_KEYS.join(', ')}`);
  }
  return problems;
}

export function evaluateExpectations(expect, { result, errorMessage = null }) {
  const met = [];
  const unmet = [];

  const threw = errorMessage !== null && errorMessage !== undefined;
  const success = threw ? false : !(result && typeof result === 'object' && result.success === false);
  const haystack = threw ? errorMessage : JSON.stringify(result, null, 2) ?? '';

  if (expect.success !== undefined) {
    if (success === expect.success) {
      met.push(`success=${success}`);
    } else {
      unmet.push(`expected success=${expect.success}, got ${success}`);
    }
  }

  for (const needle of expect.contains || []) {
    if (haystack.includes(needle)) {
      met.push(`result contains ${JSON.stringify(needle)}`);
    } else {
      unmet.push(`expected result to contain ${JSON.stringify(needle)}`);
    }
  }

  for (const needle of expect.notContains || []) {
    if (haystack.includes(needle)) {
      unmet.push(`expected result not to contain ${JSON.stringify(needle)}`);
    } else {
      met.push(`result does not contain ${JSON.stringify(needle)}`);
    }
  }

  return { met, unmet };
}

export function parseScriptMetadata(content) {
  const metadata = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('//')) break;

    const match = trimmed.match(/^\/\/\s*#(\w+)\s+(.*)/);
    if (match) {
      const key = match[1];
      const value = match[2].trim();
      if (key === 'args') {
        if (!metadata.args) metadata.args = [];
        metadata.args.push(value);
      } else {
        metadata[key] = value;
      }
    }
  }
  return metadata;
}

export async function listCSharpScripts() {
  try {
    await fs.mkdir(CSHARP_SCRIPTS_DIR, { recursive: true });
    const files = await fs.readdir(CSHARP_SCRIPTS_DIR);
    const scripts = [];

    for (const file of files) {
      if (!file.endsWith('.cs')) continue;

      try {
        const filePath = path.join(CSHARP_SCRIPTS_DIR, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const metadata = parseScriptMetadata(content);

        scripts.push({
          file,
          name: metadata.name || file.replace('.cs', ''),
          description: metadata.description || 'No description',
          tags: metadata.tags || '',
          args: metadata.args || [],
          path: filePath,
        });
      } catch (err) {
        console.error(`Error reading script ${file}: ${err.message}`);
      }
    }

    return {
      count: scripts.length,
      scripts,
      scriptsDirectory: CSHARP_SCRIPTS_DIR,
    };
  } catch (err) {
    return {
      error: err.message,
      count: 0,
      scripts: [],
    };
  }
}

export async function buildScriptCatalog() {
  const result = await listCSharpScripts();
  if (result.count === 0) {
    return '# C# Script Library\n\nNo scripts available yet. Create .cs files in scripts/csharp/ to add to the library.';
  }

  let catalog = '# C# Script Library\n\n';
  for (const script of result.scripts) {
    let line = `- ${script.name}: ${script.description}`;
    if (script.tags) {
      line += ` [tags: ${script.tags}]`;
    }
    if (script.args.length > 0) {
      line += ` [args: ${script.args.map(a => a.split(':')[0].trim()).join(', ')}]`;
    }
    catalog += line + '\n';
  }
  return catalog;
}

export function resolveInside(baseDir, candidate) {
  const resolved = path.resolve(baseDir, candidate);
  const relative = path.relative(baseDir, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Script path escapes the script library: ${candidate}`);
  }
  return resolved;
}

export async function readScriptSource(scriptPath) {
  if (path.isAbsolute(scriptPath)) {
    return {
      source: await fs.readFile(scriptPath, 'utf-8'),
      name: path.basename(scriptPath, '.cs'),
    };
  }

  let resolved = scriptPath;
  if (!resolved.endsWith('.cs')) {
    resolved += '.cs';
  }

  const filePath = resolveInside(CSHARP_SCRIPTS_DIR, resolved);
  try {
    return {
      source: await fs.readFile(filePath, 'utf-8'),
      name: path.basename(resolved, '.cs'),
    };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const wanted = scriptPath.trim().toLowerCase();
    const { scripts } = await listCSharpScripts();
    const match = scripts.find((script) => script.name.toLowerCase() === wanted);
    if (!match) throw err;
    return {
      source: await fs.readFile(match.path, 'utf-8'),
      name: path.basename(match.file, '.cs'),
    };
  }
}

export async function listTestScripts(dir = TEST_SCRIPTS_DIR) {
  const scripts = [];
  const errors = [];

  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`${dir}: ${err.message}`);
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const filePath = path.join(dir, file);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const script = JSON.parse(content);

      scripts.push({
        name: file,
        title: script.name || file,
        description: script.description || 'No description',
        steps: script.steps?.length || 0,
        ...(script.args && typeof script.args === 'object' ? { args: script.args } : {}),
        path: filePath,
      });
    } catch (err) {
      console.error(`Error reading script ${filePath}: ${err.message}`);
    }
  }

  return {
    count: scripts.length,
    scripts,
    scriptsDirectory: dir,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function resolveTestScriptPath(scriptNameOrPath) {
  if (path.isAbsolute(scriptNameOrPath)) return scriptNameOrPath;

  let name = scriptNameOrPath;
  if (!name.endsWith('.json')) name += '.json';

  const resolved = resolveInside(TEST_SCRIPTS_DIR, name);
  try {
    await fs.access(resolved);
    return resolved;
  } catch {
    throw new Error(`Test script not found: ${scriptNameOrPath} (looked in ${resolved})`);
  }
}

const UNTIL_KEYS = ['timeout', 'interval'];

function untilProblems(until) {
  if (typeof until !== 'object' || until === null || Array.isArray(until)) {
    return ['"until" must be an object'];
  }

  const problems = [];
  for (const key of Object.keys(until)) {
    if (!UNTIL_KEYS.includes(key)) {
      problems.push(`unknown "until" key "${key}" (allowed: ${UNTIL_KEYS.join(', ')})`);
    }
  }
  if (typeof until.timeout !== 'number' || !Number.isFinite(until.timeout) || until.timeout < 0) {
    problems.push('"until.timeout" must be a number of seconds, 0 or more');
  }
  if ('interval' in until
    && (typeof until.interval !== 'number' || !Number.isFinite(until.interval) || until.interval <= 0)) {
    problems.push('"until.interval" must be a positive number of seconds');
  }
  return problems;
}

export function validateTestScriptSteps(steps, label = 'step') {
  const unsupported = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const where = `${label} ${i + 1}`;
    const command = step?.command;
    if (!command) {
      unsupported.push(`${where}: missing "command"`);
    } else if (NODE_ONLY_TOOLS.has(command)) {
      unsupported.push(`${where}: "${command}" is implemented by the MCP server, not the game`);
    } else {
      if (SOURCE_REQUIRED_TOOLS.has(command)) {
        const hasPath = typeof step.params?.path === 'string' && step.params.path.length > 0;
        const hasSource = Boolean(step.params?.source);
        if (hasPath && hasSource) {
          unsupported.push(`${where}: "${command}" takes params.path or params.source, not both`);
        } else if (!hasPath && !hasSource) {
          unsupported.push(`${where}: "${command}" needs params.path (a library script) or params.source`);
        }
      }
      try {
        toolCommand(command, step.params ?? {});
      } catch (err) {
        unsupported.push(`${where}: ${err.message}`);
      }
    }

    if (step?.expect !== undefined) {
      for (const problem of expectProblems(step.expect)) {
        unsupported.push(`${where}: ${problem}`);
      }
    }
    if (step?.until !== undefined) {
      for (const problem of untilProblems(step.until)) {
        unsupported.push(`${where}: ${problem}`);
      }
      if (step.expect === undefined) {
        unsupported.push(`${where}: "until" needs an "expect" to poll for`);
      }
    }
    if (step?.report !== undefined && typeof step.report !== 'boolean') {
      unsupported.push(`${where}: "report" must be a boolean`);
    }
  }

  return unsupported;
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const ARG_DECLARATION_KEYS = ['default', 'description'];

function argDeclarationProblems(declared) {
  if (declared === undefined) return [];
  if (!isPlainObject(declared)) return ['"args" must be an object of { default, description } declarations'];

  const problems = [];
  for (const [name, declaration] of Object.entries(declared)) {
    if (!isPlainObject(declaration)) {
      problems.push(`args.${name}: must be an object with "default" and/or "description"`);
      continue;
    }
    for (const key of Object.keys(declaration)) {
      if (!ARG_DECLARATION_KEYS.includes(key)) {
        problems.push(`args.${name}: unknown key "${key}" (allowed: ${ARG_DECLARATION_KEYS.join(', ')})`);
      }
    }
    if ('description' in declaration && typeof declaration.description !== 'string') {
      problems.push(`args.${name}: "description" must be a string`);
    }
  }
  return problems;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z_][\w-]*)\s*\}\}$/;

const hasArg = (args, name) => Object.hasOwn(args, name) && args[name] !== undefined;

function substitute(value, args, missing) {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE_PLACEHOLDER);
    if (whole) {
      if (hasArg(args, whole[1])) return structuredClone(args[whole[1]]);
      missing.add(whole[1]);
      return value;
    }
    return value.replace(PLACEHOLDER, (placeholder, name) => {
      if (!hasArg(args, name)) {
        missing.add(name);
        return placeholder;
      }
      const arg = args[name];
      return typeof arg === 'string' ? arg : JSON.stringify(arg);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, args, missing));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, args, missing)]));
  }
  return value;
}

function applyArgs(steps, args, label, problems) {
  return steps.map((step, i) => {
    if (!isPlainObject(step) || step.params === undefined) return step;
    const missing = new Set();
    const params = substitute(step.params, args, missing);
    for (const name of missing) {
      problems.push(`${label} ${i + 1}: no value for {{${name}}} (pass it in args or declare a default)`);
    }
    return { ...step, params };
  });
}

async function resolveScriptPaths(steps, label, problems) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!SOURCE_REQUIRED_TOOLS.has(step.command) || !step.params?.path) continue;
    try {
      const { path: scriptPath, ...rest } = step.params;
      const script = await readScriptSource(scriptPath);
      step.sendParams = { ...rest, source: script.source, name: rest.name ?? script.name };
    } catch (err) {
      problems.push(`${label} ${i + 1}: params.path "${step.params.path}": ${err.message}`);
    }
  }
}

export async function prepareTestScript(scriptNameOrPath, givenArgs = {}) {
  if (!isPlainObject(givenArgs)) throw new Error('"args" must be an object');

  const scriptPath = await resolveTestScriptPath(scriptNameOrPath);
  console.error(`Loading test script: ${scriptPath}`);
  const script = JSON.parse(await fs.readFile(scriptPath, 'utf-8'));

  if (!script.steps || !Array.isArray(script.steps)) {
    throw new Error('Script must have a "steps" array');
  }
  if (script.cleanup !== undefined && !Array.isArray(script.cleanup)) {
    throw new Error('"cleanup" must be an array of steps');
  }

  const problems = argDeclarationProblems(script.args);
  if (script.continueOnFailure !== undefined && typeof script.continueOnFailure !== 'boolean') {
    problems.push('"continueOnFailure" must be a boolean');
  }
  const args = {};
  if (isPlainObject(script.args)) {
    for (const [name, declaration] of Object.entries(script.args)) {
      if (isPlainObject(declaration) && declaration.default !== undefined) args[name] = declaration.default;
    }
  }
  for (const [name, value] of Object.entries(givenArgs)) {
    if (value !== undefined) args[name] = value;
  }

  const steps = applyArgs(script.steps, args, 'step', problems);
  const cleanup = applyArgs(script.cleanup ?? [], args, 'cleanup step', problems);
  problems.push(...validateTestScriptSteps(steps), ...validateTestScriptSteps(cleanup, 'cleanup step'));

  if (problems.length === 0) {
    await resolveScriptPaths(steps, 'step', problems);
    await resolveScriptPaths(cleanup, 'cleanup step', problems);
  }

  if (problems.length > 0) {
    throw new Error(
      'Test script steps run directly against the game, so they are limited to game-side commands. ' +
      `Invalid script: ${problems.join('; ')}`
    );
  }

  return { script, steps, cleanup, args };
}

function buildStepResult(step, index, duration, { result, errorMessage = null }) {
  const threw = errorMessage !== null && errorMessage !== undefined;
  const record = {
    step: index + 1,
    command: step.command,
    params: step.params,
    success: threw ? false : !(result && typeof result === 'object' && result.success === false),
    duration,
  };
  if (!threw) record.result = result;

  if (step.expect === undefined) {
    if (!record.success) {
      record.error = threw ? errorMessage : (result.error || 'Command reported failure');
    }
    return record;
  }

  const { met, unmet } = evaluateExpectations(step.expect, { result, errorMessage });
  record.success = unmet.length === 0;
  record.expect = step.expect;
  record.expectations = { met, unmet };
  if (threw) record.commandError = errorMessage;
  if (unmet.length > 0) record.error = `Unmet expectations: ${unmet.join('; ')}`;
  return record;
}

const GAME_GONE_MESSAGE = /Game process died|game likely crashed|Game is not running/;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// UMM flushes its log buffer only after more than 0.5s of summed Time.deltaTime
export const UMM_FLUSH_WAIT_MS = 600;

function liftReport(record, reply) {
  let value = isPlainObject(reply) && 'result' in reply ? reply.result : reply;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (err) {
      record.success = false;
      record.error = `report: the step's result is not JSON (${err.message})`;
      return null;
    }
  }
  if (!isPlainObject(value)) {
    record.success = false;
    record.error = 'report: the step\'s result is not a JSON object';
    return null;
  }
  delete record.result;
  record.reportLifted = true;
  return value;
}

async function runStep(step, index, { client, sleep, now }) {
  const { method, params } = toolCommand(step.command, step.sendParams ?? step.params ?? {});
  const started = now();
  const deadline = step.until ? started + step.until.timeout * 1000 : null;
  const intervalMs = step.until ? (step.until.interval ?? 1) * 1000 : 0;

  let attempts = 0;
  let outcome;
  let record;
  for (;;) {
    attempts++;
    const attemptStarted = now();
    try {
      let result = await client.sendCommand(method, params);
      if (step.command === 'take_screenshot' && result && result.path) {
        result.path = client.translateScreenshotPath(result.path);
      }
      outcome = { result };
    } catch (err) {
      outcome = { errorMessage: err.message };
    }
    record = buildStepResult(step, index, now() - attemptStarted, outcome);

    if (!step.until || record.success) break;
    if (outcome.errorMessage && GAME_GONE_MESSAGE.test(outcome.errorMessage)) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  if (step.until) {
    record.duration = now() - started;
    record.attempts = attempts;
  }

  const report = step.report && record.success ? liftReport(record, outcome.result) : null;
  return { record, report, errorMessage: outcome.errorMessage ?? null };
}

function failureLine(record) {
  const unmet = record.expectations?.unmet?.[0];
  const text = unmet ?? String(record.error ?? 'failed').split('\n')[0];
  return { step: record.step, command: record.command, error: text };
}

async function gameGoneReason(errorMessage, isRunning) {
  if (!errorMessage) return null;
  let alive = null;
  try {
    alive = await isRunning();
  } catch {
    alive = null;
  }
  if (alive === true) return null;
  if (alive === false || GAME_GONE_MESSAGE.test(errorMessage)) return errorMessage;
  return null;
}

async function logDeltaFor(baseline) {
  if (baseline.error) return { error: baseline.error };
  try {
    return await collectLogDelta(baseline.snapshot);
  } catch (err) {
    return { error: `log delta failed: ${err.message}` };
  }
}

export async function runTestScript(scriptNameOrPath, unityClient, options = {}) {
  const {
    args: givenArgs = {},
    logPaths = null,
    sleep = delay,
    now = Date.now,
    isRunning = () => isGameRunning(unityClient.gameConfig ?? undefined),
  } = options;

  let prepared;
  try {
    prepared = await prepareTestScript(scriptNameOrPath, givenArgs ?? {});
  } catch (err) {
    console.error(`Error running test script: ${err.message}`);
    return { error: err.message, scriptPath: scriptNameOrPath, passed: false };
  }
  const { script, steps, cleanup, args } = prepared;

  let baseline = null;
  if (logPaths) {
    try {
      baseline = { snapshot: await snapshotLogs(await logPaths()) };
    } catch (err) {
      baseline = { error: `log baseline failed: ${err.message}` };
    }
  }

  const context = { client: unityClient, sleep, now };
  const startTime = now();
  const results = [];
  const reports = [];
  let lastError = null;
  let runError = null;
  let gameGone = false;

  console.error(`Executing script: ${script.name || scriptNameOrPath}`);
  console.error(`Steps: ${steps.length}`);

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      console.error(`Step ${i + 1}/${steps.length}: ${step.command}`);

      const { record, report, errorMessage } = await runStep(step, i, context);
      results.push(record);
      lastError = errorMessage;
      if (report) reports.push(report);

      if (!record.success) {
        console.error(`Step ${i + 1} failed: ${record.error}`);
        if (!script.continueOnFailure) break;
        if (await gameGoneReason(errorMessage, isRunning)) {
          gameGone = true;
          break;
        }
      }

      if (step.wait) {
        console.error(`Waiting ${step.wait}ms...`);
        await sleep(step.wait);
      }
    }
  } catch (err) {
    runError = err.message;
    lastError ??= err.message;
  }

  const cleanupResults = [];
  let cleanupSkipped = null;
  if (cleanup.length > 0) {
    const gone = gameGone ? lastError : await gameGoneReason(lastError, isRunning);
    if (gone) {
      gameGone = true;
      cleanupSkipped = `the game is gone (${gone}), so no cleanup step ran`;
    } else {
      for (let i = 0; i < cleanup.length; i++) {
        const step = cleanup[i];
        console.error(`Cleanup step ${i + 1}/${cleanup.length}: ${step.command}`);

        let outcome;
        try {
          outcome = await runStep(step, i, context);
        } catch (err) {
          outcome = {
            record: { step: i + 1, command: step.command, params: step.params, success: false, error: err.message },
            report: null,
            errorMessage: err.message,
          };
        }
        cleanupResults.push(outcome.record);
        if (outcome.report) reports.push(outcome.report);
        if (outcome.errorMessage) lastError = outcome.errorMessage;

        const goneNow = await gameGoneReason(outcome.errorMessage, isRunning);
        if (goneNow) {
          gameGone = true;
          const left = cleanup.length - i - 1;
          if (left > 0) cleanupSkipped = `the game is gone (${goneNow}); ${left} cleanup step(s) did not run`;
          break;
        }

        if (step.wait) {
          try {
            await sleep(step.wait);
          } catch {}
        }
      }
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const stepsPassed = runError === null && results.length === steps.length && successCount === steps.length;
  const cleanupPassed = cleanupSkipped === null
    && cleanupResults.length === cleanup.length
    && cleanupResults.every((r) => r.success);
  const reportsPassed = reports.every((report) => report.passed !== false);

  const reply = {
    scriptName: script.name || scriptNameOrPath,
    description: script.description,
    passed: stepsPassed && cleanupPassed && reportsPassed,
    ...(Object.keys(args).length > 0 ? { args } : {}),
    totalSteps: steps.length,
    completedSteps: results.length,
    successfulSteps: successCount,
    failedSteps: results.length - successCount,
    totalDuration: now() - startTime,
    ...(runError !== null ? { error: runError } : {}),
    results,
  };
  if (script.continueOnFailure) {
    reply.failures = [
      ...results.filter((r) => !r.success).map((r) => failureLine(r)),
      ...cleanupResults.filter((r) => !r.success).map((r) => ({ ...failureLine(r), cleanup: true })),
    ];
  }
  if (cleanup.length > 0) {
    reply.cleanup = cleanupResults;
    if (cleanupSkipped) reply.cleanupSkipped = cleanupSkipped;
  }
  if (reports.length === 1) reply.report = reports[0];
  else if (reports.length > 1) reply.report = reports;
  if (baseline) {
    if (baseline.snapshot?.umm.path && !gameGone && !(await gameGoneReason(lastError, isRunning))) {
      let alive = null;
      try {
        alive = await isRunning();
      } catch {
        alive = null;
      }
      if (alive !== false) await sleep(UMM_FLUSH_WAIT_MS);
    }
    reply.logs = await logDeltaFor(baseline);
  }

  return reply;
}

// Claude Code saves an MCP result over 25,000 tokens to a file instead of showing it
export const TEST_REPLY_MAX_CHARS = 40000;
export const STEP_PREVIEW_MAX_CHARS = 300;
export const TEST_RESULTS_KEEP = 100;
export const REPORT_FIELD_MAX_CHARS = 2000;
const BULKY_REPORT_FIELDS = new Set(['events', 'stuck', 'survey']);

// nix-shell deletes its temp dir, and with it os.tmpdir(), when the server it started exits
export function testResultsDir(env = process.env, home = os.homedir()) {
  if (env.UNITY_INSPECTOR_TEST_RESULTS_DIR) return env.UNITY_INSPECTOR_TEST_RESULTS_DIR;
  const stateHome = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'unity-inspector-mcp', 'test-results');
}

const REPLY_LEVELS = [
  { previews: 'all' },
  { previews: 'failed' },
  { previews: 'none' },
  { previews: 'none', logs: false },
  { previews: 'none', logs: false, report: 'trimmed' },
  { previews: 'none', logs: false, report: false },
  { previews: 'none', logs: false, report: false, steps: false },
];

function stepPreview(record) {
  const text = record.success
    ? (record.result === undefined ? undefined : JSON.stringify(record.result))
    : String(record.error ?? 'failed');
  if (text === undefined) return {};
  if (text.length <= STEP_PREVIEW_MAX_CHARS) return { preview: text };
  return { preview: text.slice(0, STEP_PREVIEW_MAX_CHARS), truncated: true };
}

function compactStep(record, previews) {
  const step = { step: record.step, command: record.command, passed: record.success };
  if (previews === 'all' || (previews === 'failed' && !record.success)) Object.assign(step, stepPreview(record));
  return step;
}

const RESULTS_FILE_PATTERN = /^[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

function resultsFileName(script, now) {
  const base = path.basename(String(script ?? 'script')).replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-') || 'script';
  return `${base}-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.json`;
}

function trimReport(report, dropped) {
  if (!isPlainObject(report)) return report;
  const kept = {};
  for (const [key, value] of Object.entries(report)) {
    const bulky = key !== 'checks'
      && (BULKY_REPORT_FIELDS.has(key) || (JSON.stringify(value)?.length ?? 0) > REPORT_FIELD_MAX_CHARS);
    if (bulky) dropped.add(`report.${key}`);
    else kept[key] = value;
  }
  return kept;
}

function shapeReply(full, level, file, maxChars) {
  const reply = {};
  const shed = { logs: [], reportFields: [], report: [], steps: [] };
  for (const [key, value] of Object.entries(full)) {
    if (key === 'results' || key === 'cleanup') {
      if (level.steps === false) shed.steps.push(key === 'results' ? 'the per-step list' : 'the cleanup list');
      else reply[key] = value.map((record) => compactStep(record, level.previews));
    } else if (key === 'logs' && level.logs === false) {
      shed.logs.push('logs');
    } else if (key === 'report' && level.report === false) {
      shed.report.push('report');
    } else if (key === 'report' && level.report === 'trimmed') {
      const dropped = new Set();
      reply.report = Array.isArray(value) ? value.map((one) => trimReport(one, dropped)) : trimReport(value, dropped);
      shed.reportFields.push(...dropped);
    } else {
      reply[key] = value;
    }
    if (key === 'passed') Object.assign(reply, file);
  }
  const omitted = [...shed.logs, ...shed.reportFields, ...shed.report, ...shed.steps];
  if (level.steps !== false && level.previews !== 'all') {
    omitted.unshift(level.previews === 'failed' ? 'the previews of passing steps' : 'every step preview');
  }
  if (omitted.length > 0) {
    reply.omitted = `Left out to fit ${maxChars} characters: ${omitted.join(', ')}`
      + (file.resultsFile ? '; resultsFile has them' : '');
  }
  return reply;
}

async function pruneResults(dir, keep) {
  const entries = await fs.readdir(dir);
  const files = [];
  for (const name of entries.filter((entry) => RESULTS_FILE_PATTERN.test(entry))) {
    try {
      const stats = await fs.lstat(path.join(dir, name));
      if (stats.isFile()) files.push({ name, mtime: stats.mtimeMs });
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  await Promise.all(files.slice(keep).map(({ name }) => fs.rm(path.join(dir, name), { force: true })));
}

export async function compactTestScriptReply(full, {
  script, dir = testResultsDir(), maxChars = TEST_REPLY_MAX_CHARS, keep = TEST_RESULTS_KEEP, now = Date.now,
} = {}) {
  if (!Array.isArray(full?.results)) return full;

  let file;
  try {
    await fs.mkdir(dir, { recursive: true });
    const resultsFile = path.join(dir, resultsFileName(script, now));
    await fs.writeFile(resultsFile, JSON.stringify(full, null, 2), 'utf-8');
    file = { resultsFile };
  } catch (err) {
    file = { resultsFileError: `the full results could not be written: ${err.message}` };
  }
  if (file.resultsFile) {
    try {
      await pruneResults(dir, keep);
    } catch (err) {
      console.error(`Pruning ${dir} failed: ${err.message}`);
    }
  }

  let reply = null;
  for (const level of REPLY_LEVELS) {
    reply = shapeReply(full, level, file, maxChars);
    if (JSON.stringify(reply, null, 2).length <= maxChars) return reply;
  }
  return reply;
}
