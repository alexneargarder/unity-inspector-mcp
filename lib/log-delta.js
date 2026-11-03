import fs from 'fs/promises';
import path from 'path';

export const LOG_READ_MAX_BYTES = 4 * 1024 * 1024;
export const FLOOD_MIN_COUNT = 50;
export const LOG_PAYLOAD_MAX_CHARS = 12000;
const TEXT_MAX_CHARS = 300;

const LOG_KEYS = ['umm', 'player'];
const ENGINE_SOURCE = 'Unity (engine)';
const UNPREFIXED_SOURCE = '(unprefixed)';
const FRAMEWORK_ROOTS = new Set(['System', 'Mono', 'UnityEngine', 'HarmonyLib', 'MonoMod', 'Microsoft']);

const PAYLOAD_LEVELS = [
  { samples: 2, groups: 8, sources: 20 },
  { samples: 1, groups: 5, sources: 15 },
  { samples: 0, groups: 3, sources: 10 },
  { samples: 0, groups: 1, sources: 8 },
];

const PLAYER_LOG_NAMES = new Set(['player.log', 'player-prev.log', 'output_log.txt']);

export function isPlayerLogName(filePath) {
  return PLAYER_LOG_NAMES.has(path.basename(filePath).toLowerCase());
}

const fileIdOf = (stat) => `${stat.dev}:${stat.ino}`;

async function statFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

export async function snapshotLogs(paths) {
  const snapshot = {};
  for (const key of LOG_KEYS) {
    const filePath = paths?.[key] ?? null;
    const stat = filePath ? await statFile(filePath) : null;
    snapshot[key] = { path: filePath, size: stat ? stat.size : 0, fileId: stat ? fileIdOf(stat) : null };
  }
  return snapshot;
}

export async function readDelta(base, { maxBytes = LOG_READ_MAX_BYTES } = {}) {
  const missing = { info: { path: base?.path ?? null, missing: true }, text: null };
  if (!base?.path) return missing;

  const stat = await statFile(base.path);
  if (!stat) return missing;

  const rotated = base.fileId !== null && (fileIdOf(stat) !== base.fileId || stat.size < base.size);
  const fromByte = rotated || base.fileId === null ? 0 : base.size;
  const bytes = stat.size - fromByte;

  let readFrom = fromByte;
  if (bytes > maxBytes) readFrom = stat.size - maxBytes;

  let text;
  try {
    const handle = await fs.open(base.path, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - readFrom);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, readFrom);
      text = buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err.code === 'ENOENT') return missing;
    throw err;
  }

  let skippedBytes = readFrom - fromByte;
  if (skippedBytes > 0) {
    const newline = text.indexOf('\n');
    const dropped = newline === -1 ? text : text.slice(0, newline + 1);
    skippedBytes += Buffer.byteLength(dropped, 'utf-8');
    text = text.slice(dropped.length);
  }

  const info = { path: base.path, fromByte, bytes };
  if (rotated) info.rotated = true;
  if (skippedBytes > 0) info.skippedBytes = skippedBytes;
  return { info, text };
}

const COLOR_TAG = /<\/?color(=[^>]*)?>/g;

function splitLines(text) {
  return text.split(/\r?\n/).map((line) => line.replace(COLOR_TAG, ''));
}

const isBlank = (line) => line.trim() === '';
const isAtFrame = (line) => /^\s*at\s/.test(line);
const isUnityFrame = (line) => /^[\w.`<>+]+:[\w.`<>+]+\s*\(.*\)\s*$/.test(line.trim());

const SEVERITY_TAGS = { Error: 'error', Critical: 'error', Exception: 'error', Warning: 'warning' };

export function parsePrefixed(line) {
  const head = line.match(/^\[([^\]]+)\]/);
  if (!head) return null;

  let source = head[1];
  // BroMakerLib's logger stamps its own time straight after the tag
  let rest = line.slice(head[0].length).replace(/^\[\d{1,2}:\d{2}:\d{2}(\.\d+)?\]/, '').trimStart();
  let severity = null;
  for (let pass = 0; pass < 2; pass++) {
    const tag = rest.match(/^\[(Error|Critical|Exception|Warning)\]\s?/);
    if (tag && !severity) {
      severity = SEVERITY_TAGS[tag[1]];
      rest = rest.slice(tag[0].length);
      continue;
    }
    const script = rest.match(/^\[(Script:[^\]]+)\]\s?/);
    if (script && !source.includes(' › ')) {
      source = `${source} › ${script[1]}`;
      rest = rest.slice(script[0].length);
    }
  }
  return { source, message: rest, severity };
}

function parsePrefixedLines(lines, orphanSource) {
  const entries = [];
  let current = null;
  let inStack = false;

  for (const line of lines) {
    if (isBlank(line)) {
      current = null;
      inStack = false;
      continue;
    }

    const prefixed = parsePrefixed(line);
    if (prefixed) {
      const previous = entries[entries.length - 1];
      // The Utility Mod logs an entry's stack as a separate `[Source] Stack trace:` entry after it
      if (prefixed.message.trim() === 'Stack trace:' && previous && previous.source === prefixed.source) {
        previous.lineCount++;
        current = previous;
        inStack = true;
        continue;
      }
      current = { source: prefixed.source, message: prefixed.message, severity: prefixed.severity, frames: [], lineCount: 1, prefixed: true };
      entries.push(current);
      inStack = false;
      continue;
    }

    if (current) {
      current.lineCount++;
      if (inStack || isAtFrame(line)) current.frames.push(line.trim());
      continue;
    }

    entries.push({ source: orphanSource, message: line, severity: null, frames: [], lineCount: 1, prefixed: false });
  }
  return entries;
}

export function parseUmmLog(text) {
  return parsePrefixedLines(splitLines(text), UNPREFIXED_SOURCE);
}

const TRAILER = /^\(Filename:.*Line:\s*-?\d+\)\s*$/;

const MIRROR_SEVERITY = { red: 'error', yellow: 'warning' };

function mirrorSeverities(text) {
  const severities = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    severities.push(pending);
    // Player.log omits a call's log type; only the colour of the Utility Mod's [Unity] mirror above it carries it
    const colour = raw.startsWith('[Unity]') ? raw.match(/<color=(red|yellow)>/)?.[1] : undefined;
    if (colour) pending = MIRROR_SEVERITY[colour];
    if (TRAILER.test(raw.replace(COLOR_TAG, ''))) pending = null;
  }
  return severities;
}

export function parsePlayerLog(text, { includePrefixed = false } = {}) {
  const lines = splitLines(text);
  const mirrored = mirrorSeverities(text);
  const owned = new Array(lines.length).fill(false);
  const calls = [];

  for (let i = 0; i < lines.length; i++) {
    // Unity writes a log call as its message, any frames, a line holding one space, then this trailer
    if (!TRAILER.test(lines[i])) continue;

    const block = [];
    let sawMessage = false;
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j];
      if (line === '' || owned[j] || TRAILER.test(line)) break;
      const frame = isAtFrame(line) || isUnityFrame(line);
      if (line.startsWith('[')) {
        // A Debug.Log call whose text opens with a tag, unless a message already sits below it
        if (sawMessage) break;
        block.unshift(j);
        break;
      }
      if (!frame && !isBlank(line)) sawMessage = true;
      block.unshift(j);
    }

    owned[i] = true;
    for (const j of block) owned[j] = true;

    const body = block.map((j) => lines[j]).filter((line) => !isBlank(line));
    const frames = body.filter((line) => isAtFrame(line) || isUnityFrame(line)).map((line) => line.trim());
    const messageLine = body.find((line) => !isAtFrame(line) && !isUnityFrame(line)) ?? body[0] ?? '';
    const prefixed = parsePrefixed(messageLine);
    calls.push({
      source: prefixed ? prefixed.source : 'Unity',
      message: prefixed ? prefixed.message : messageLine,
      severity: mirrored[block[0] ?? i] ?? prefixed?.severity ?? null,
      frames,
      lineCount: block.length + 1,
      prefixed: false,
      unityCall: true,
    });
  }

  const rest = parsePrefixedLines(lines.map((line, i) => (owned[i] ? '' : line)), ENGINE_SOURCE)
    .filter((entry) => !entry.prefixed || (includePrefixed && entry.source !== 'Unity'));
  return [...calls, ...rest];
}

function frameName(frame) {
  const body = frame.replace(/^\s*at\s+/, '').replace(/^\(wrapper [^)]*\)\s*/, '');
  const beforeArgs = body.split('(')[0].trim();
  const tokens = beforeArgs.split(/\s+/);
  return tokens[tokens.length - 1] || null;
}

function frameRoot(frame) {
  const name = frameName(frame);
  if (!name) return null;
  const parts = name.replace(/<.*>/, '').replace(/:+/g, '.').split('.').filter(Boolean);
  if (parts.length >= 3) return parts[0];
  // The game's own types carry no namespace
  if (parts.length === 2) return 'Broforce';
  return null;
}

export function frameOrigin(frames) {
  let fallback = null;
  for (const frame of frames) {
    const root = frameRoot(frame);
    if (!root) continue;
    if (!FRAMEWORK_ROOTS.has(root)) return root;
    fallback ??= root;
  }
  return fallback;
}

export function classifyEntry(entry) {
  if (entry.severity) return entry.severity;
  if (entry.frames.some(isAtFrame) || /\w+Exception\b/.test(entry.message)) return 'error';
  if (/\b(error|failed)\b/i.test(entry.message)) return 'error';
  if (/\bwarn/i.test(entry.message)) return 'warning';
  return 'info';
}

export function normalizeMessage(message) {
  return message
    .replace(/\[\d{1,2}:\d{2}:\d{2}(\.\d+)?\]/g, '')
    .replace(/\[f:\d+ t:[\d.]+\]/g, '')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\b[0-9a-f-]{8,}\b/gi, (id) => (/\d/.test(id) ? '#' : id))
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (text) => (text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}…` : text);

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

export function groupEntries(entries, { floodMin = FLOOD_MIN_COUNT } = {}) {
  const sources = new Map();

  for (const entry of entries) {
    const origin = entry.unityCall && entry.frames.length > 0 ? frameOrigin(entry.frames) : null;
    const key = `${entry.source}\u0000${origin ?? ''}`;
    let source = sources.get(key);
    if (!source) {
      source = { source: entry.source, origin, lines: 0, errors: 0, warnings: 0, groups: new Map() };
      sources.set(key, source);
    }

    const severity = classifyEntry(entry);
    source.lines += entry.lineCount;
    if (severity === 'error') source.errors++;
    if (severity === 'warning') source.warnings++;

    const groupKey = `${severity}\u0000${normalizeMessage(entry.message)}`;
    let group = source.groups.get(groupKey);
    if (!group) {
      group = { severity, count: 0, message: clip(entry.message.trim()), variants: [] };
      if (entry.frames.length > 0) group.frame = clip(frameName(entry.frames[0]) ?? entry.frames[0]);
      source.groups.set(groupKey, group);
    }
    group.count++;
    const raw = clip(entry.message.trim());
    if (raw !== group.message && group.variants.length < 3 && !group.variants.includes(raw)) {
      group.variants.push(raw);
    }
  }

  const summary = { lines: 0, errors: 0, warnings: 0, floods: 0 };
  const bySource = [];
  for (const source of sources.values()) {
    const groups = [...source.groups.values()];
    for (const group of groups) {
      if (group.count >= floodMin) group.flood = true;
    }
    const floods = groups.filter((group) => group.flood).length;
    summary.lines += source.lines;
    summary.errors += source.errors;
    summary.warnings += source.warnings;
    summary.floods += floods;

    const notable = groups
      .filter((group) => group.severity !== 'info' || group.flood)
      .sort((a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        || Number(Boolean(b.flood)) - Number(Boolean(a.flood))
        || b.count - a.count);
    bySource.push({ ...source, floods, groups: notable });
  }

  bySource.sort((a, b) => b.errors - a.errors || b.floods - a.floods || b.lines - a.lines);
  return { summary, bySource };
}

function shapeSources(bySource, level) {
  let cut = false;
  const shaped = bySource.slice(0, level.sources).map((source) => {
    const out = { source: source.source };
    if (source.origin) out.origin = source.origin;
    out.lines = source.lines;
    out.errors = source.errors;
    if (source.warnings > 0) out.warnings = source.warnings;
    out.groups = source.groups.slice(0, level.groups).map((group) => {
      const g = { severity: group.severity, count: group.count };
      if (group.flood) g.flood = true;
      g.message = group.message;
      if (group.frame) g.frame = group.frame;
      const samples = group.variants.slice(0, level.samples);
      if (samples.length < group.variants.length) cut = true;
      if (samples.length > 0) g.samples = samples;
      return g;
    });
    if (source.groups.length > level.groups) {
      out.omittedGroups = source.groups.length - level.groups;
      cut = true;
    }
    return out;
  });
  const omittedSources = Math.max(0, bySource.length - level.sources);
  if (omittedSources > 0) cut = true;
  return { bySource: shaped, omittedSources, cut };
}

export function capPayload(files, { summary, bySource }, { maxChars = LOG_PAYLOAD_MAX_CHARS } = {}) {
  let payload = null;
  for (const level of PAYLOAD_LEVELS) {
    const shaped = shapeSources(bySource, level);
    payload = { ...files, summary, bySource: shaped.bySource };
    if (shaped.omittedSources > 0) payload.omittedSources = shaped.omittedSources;
    if (shaped.cut) payload.truncated = true;
    if (JSON.stringify(payload).length <= maxChars) return payload;
  }
  return payload;
}

export async function collectLogDelta(snapshot, { maxBytes, floodMin, maxChars } = {}) {
  const umm = await readDelta(snapshot.umm, { maxBytes });
  const player = await readDelta(snapshot.player, { maxBytes });

  const entries = [];
  if (umm.text !== null) {
    entries.push(...parseUmmLog(umm.text).filter((entry) => player.text === null || entry.source !== 'Unity'));
  }
  if (player.text !== null) {
    entries.push(...parsePlayerLog(player.text, { includePrefixed: umm.text === null }));
  }

  return capPayload({ umm: umm.info, player: player.info }, groupEntries(entries, { floodMin }), { maxChars });
}
