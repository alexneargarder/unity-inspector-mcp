// Shell-style tokenizing, shared by every setting that holds a command plus arguments
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
