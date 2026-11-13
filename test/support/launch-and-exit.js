import './session.js';
import fs from 'fs/promises';

const [command, replyFile] = process.argv.slice(2);
const { handleToolCall } = await import('../../index.js');
const { setProcReader } = await import('../../lib/game-process.js');
const { fakeProcReader } = await import('./fake-proc.js');

process.on('SIGHUP', () => process.exit(0));
setProcReader(fakeProcReader({}));
process.env.BROFORCE_LAUNCH_CMD = command;
const response = await handleToolCall({ params: { name: 'launch_game', arguments: { vanilla: true } } });
await fs.writeFile(replyFile, JSON.stringify(response));
setInterval(() => {}, 1000);
