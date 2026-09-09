import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
export const CSHARP_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'csharp');
export const EXAMPLE_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'examples');

const TEST_SCRIPT_DIRS = [SCRIPTS_DIR, EXAMPLE_SCRIPTS_DIR];

export const NODE_ONLY_TOOLS = new Set([
  'capture_animations',
  'launch_game',
  'stop_game',
  'read_log',
  'watch_log',
  'list_scripts',
  'list_test_scripts',
  'run_test_script',
  'wait_for_game',
  'restart_server',
]);

const SOURCE_REQUIRED_TOOLS = new Set(['execute_script', 'compile_script']);

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
  return {
    source: await fs.readFile(filePath, 'utf-8'),
    name: path.basename(resolved, '.cs'),
  };
}

export async function listTestScripts() {
  const scripts = [];
  const errors = [];

  for (const dir of TEST_SCRIPT_DIRS) {
    let files;
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(`${dir}: ${err.message}`);
      continue;
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
          path: filePath,
        });
      } catch (err) {
        console.error(`Error reading script ${filePath}: ${err.message}`);
      }
    }
  }

  return {
    count: scripts.length,
    scripts,
    scriptsDirectories: TEST_SCRIPT_DIRS,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function resolveTestScriptPath(scriptNameOrPath) {
  if (path.isAbsolute(scriptNameOrPath)) return scriptNameOrPath;

  let name = scriptNameOrPath;
  if (!name.endsWith('.json')) name += '.json';

  const tried = [];
  for (const dir of TEST_SCRIPT_DIRS) {
    const candidate = resolveInside(dir, name);
    tried.push(candidate);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(`Test script not found: ${scriptNameOrPath} (looked in ${tried.join(', ')})`);
}

export function validateTestScriptSteps(steps) {
  const unsupported = [];

  for (let i = 0; i < steps.length; i++) {
    const command = steps[i]?.command;
    if (!command) {
      unsupported.push(`step ${i + 1}: missing "command"`);
    } else if (NODE_ONLY_TOOLS.has(command)) {
      unsupported.push(`step ${i + 1}: "${command}" is implemented by the MCP server, not the game`);
    } else if (SOURCE_REQUIRED_TOOLS.has(command) && !steps[i].params?.source) {
      unsupported.push(
        `step ${i + 1}: "${command}" needs params.source (test scripts cannot resolve script files by path)`
      );
    }

    if (steps[i]?.expect !== undefined) {
      for (const problem of expectProblems(steps[i].expect)) {
        unsupported.push(`step ${i + 1}: ${problem}`);
      }
    }
  }

  return unsupported;
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

export async function runTestScript(scriptNameOrPath, unityClient) {
  try {
    const scriptPath = await resolveTestScriptPath(scriptNameOrPath);

    console.error(`Loading test script: ${scriptPath}`);
    const content = await fs.readFile(scriptPath, 'utf-8');
    const script = JSON.parse(content);

    if (!script.steps || !Array.isArray(script.steps)) {
      throw new Error('Script must have a "steps" array');
    }

    const unsupported = validateTestScriptSteps(script.steps);
    if (unsupported.length > 0) {
      throw new Error(
        'Test script steps run directly against the game, so they are limited to game-side commands. ' +
        `Unsupported steps: ${unsupported.join('; ')}`
      );
    }

    const results = [];
    const startTime = Date.now();

    console.error(`Executing script: ${script.name || scriptNameOrPath}`);
    console.error(`Steps: ${script.steps.length}`);

    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i];
      const stepStartTime = Date.now();

      console.error(`Step ${i + 1}/${script.steps.length}: ${step.command}`);

      let record;
      try {
        let stepResult = await unityClient.sendCommand(step.command, step.params || {});
        if (step.command === 'take_screenshot' && stepResult && stepResult.path) {
          stepResult.path = unityClient.translateScreenshotPath(stepResult.path);
        }

        // execute_code and friends can report failure inside a successful reply
        record = buildStepResult(step, i, Date.now() - stepStartTime, { result: stepResult });
      } catch (err) {
        record = buildStepResult(step, i, Date.now() - stepStartTime, { errorMessage: err.message });
      }

      results.push(record);

      if (!record.success) {
        console.error(`Step ${i + 1} failed: ${record.error}`);
        break;
      }

      if (step.wait) {
        console.error(`Waiting ${step.wait}ms...`);
        await new Promise(resolve => setTimeout(resolve, step.wait));
      }
    }

    const totalDuration = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;

    return {
      scriptName: script.name || scriptNameOrPath,
      description: script.description,
      totalSteps: script.steps.length,
      completedSteps: results.length,
      successfulSteps: successCount,
      failedSteps: results.length - successCount,
      totalDuration: totalDuration,
      results: results,
    };
  } catch (err) {
    console.error(`Error running test script: ${err.message}`);
    return {
      error: err.message,
      scriptPath: scriptNameOrPath,
    };
  }
}
