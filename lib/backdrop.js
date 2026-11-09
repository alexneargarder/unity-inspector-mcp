import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const BACKDROP_SOURCE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backdrop.cs');
export const BACKDROP_CLASS = 'PlainBackdrop';
export const DEFAULT_BACKDROP = '#FF00FF';
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const INCLUDE_LINE = new RegExp(`^[ \\t]*// #include ${BACKDROP_CLASS}[ \\t]*$`, 'm');

export function backdropColour(value) {
  if (value === undefined || value === null || value === false) return null;
  if (value === true) return DEFAULT_BACKDROP;
  if (typeof value === 'string' && COLOUR.test(value)) return value;
  throw new Error(`backdrop must be true, false or a colour as #RRGGBB, got ${JSON.stringify(value)}`);
}

export function backdropClassSource() {
  return `public class ${BACKDROP_CLASS}\n{\n${readFileSync(BACKDROP_SOURCE_PATH, 'utf-8')}}\n`;
}

export function includeBackdrop(scriptSource) {
  if (!INCLUDE_LINE.test(scriptSource)) {
    throw new Error(`The capture script has no "// #include ${BACKDROP_CLASS}" line to take the backdrop render`);
  }
  const included = backdropClassSource();
  return scriptSource.replace(INCLUDE_LINE, () => included);
}

export function backdropScreenshotCode(colour) {
  return `${backdropClassSource()}return ${BACKDROP_CLASS}.Screenshot("${colour}");\n`;
}

async function localShot(client, gamePath) {
  const local = await client.translateScreenshotPath(gamePath);
  return client.gameConfig?.remote ? { path: local, gamePath } : { path: local };
}

export async function screenshotReply(command, reply, client) {
  if (!command.backdrop) {
    if (reply && reply.path) Object.assign(reply, await localShot(client, reply.path));
    return reply;
  }
  if (reply && reply.mainThreadAnswered === false) return reply;
  if (!reply || reply.success !== true || typeof reply.result !== 'string' || reply.result === '') {
    const cause = reply && reply.error ? reply.error : 'the render returned no path';
    throw new Error(`The backdrop render failed: ${cause}`);
  }
  return { success: true, ...(await localShot(client, reply.result)), backdrop: command.backdrop };
}
