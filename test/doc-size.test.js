import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_DOC_CHARS = 40000;
const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(repo + file, 'utf8');
const rules = readdirSync(repo + '.claude/rules').filter((f) => f.endsWith('.md')).map((f) => `.claude/rules/${f}`);
const agentsFiles = (dir = '') =>
  readdirSync(repo + dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : agentsFiles(`${dir}${entry.name}/`);
    return entry.name === 'AGENTS.md' ? [`${dir}${entry.name}`] : [];
  });

test('every AGENTS.md and rules file stays within what an agent reads on demand', () => {
  const docs = agentsFiles();
  assert.ok(docs.includes('AGENTS.md'), 'the root AGENTS.md is missing');
  for (const file of [...docs, ...rules]) {
    const chars = [...read(file)].length;
    assert.ok(chars < MAX_DOC_CHARS, `${file} is ${chars} characters, limit ${MAX_DOC_CHARS}`);
  }
});

test('every rules file opens with paths: frontmatter', () => {
  for (const file of rules) {
    assert.match(read(file), /^---\npaths:\n/, `${file} does not open with paths: frontmatter`);
  }
});
