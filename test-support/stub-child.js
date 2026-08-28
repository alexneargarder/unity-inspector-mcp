#!/usr/bin/env node

// Stand-in for index.js when testing wrapper.js.
// Speaks just enough MCP to exercise the wrapper's respawn machinery.
//
//   initialize        -> handshake result
//   tools/list        -> a one-tool list (so the wrapper can inject restart_server)
//   test/echo         -> immediate result
//   test/hang         -> never answered, modelling a request in flight
//   test/die          -> exits immediately without answering
//
// STUB_CHILD_DIE_ON_START=1 makes it exit before answering anything, which
// drives the crash-loop guard.

if (process.env.STUB_CHILD_DIE_ON_START === '1') {
  process.exit(7);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    const { id, method } = request;

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-child', version: '1.0.0' },
        },
      });
    } else if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: [{ name: 'stub_tool', description: 'stub', inputSchema: { type: 'object', properties: {} } }] },
      });
    } else if (method === 'test/echo') {
      send({ jsonrpc: '2.0', id, result: { echo: request.params ?? null } });
    } else if (method === 'test/die') {
      process.exit(9);
    } else if (method === 'test/hang') {
      // deliberately no reply
    } else if (id !== undefined && id !== null) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  }
});

process.stdin.on('end', () => process.exit(0));
