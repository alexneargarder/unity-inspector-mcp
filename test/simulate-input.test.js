import './support/session.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UnityInspectorClient,
  commandTimeout,
  simulateInputProblem,
  DEFAULT_COMMAND_TIMEOUT_MS,
  INPUT_PRESS_ALLOWANCE_MS,
  INPUT_PLAN_CANCEL_BUDGET_MS,
} from '../lib/unity-client.js';
import { startStubServer, reply } from './support/stub-server.js';

const MARGIN_MS = 2000;

function connectedClient(port) {
  return new UnityInspectorClient({ host: '127.0.0.1', port, connectTimeoutMs: 2000 });
}

test('simulate_input budgets the planned time, a frame allowance per press and the transport margin', () => {
  assert.equal(
    commandTimeout('simulate_input', { action: 'fire', count: 40, interval: 200, duration: 120 }),
    39 * 200 + 40 * 120 + 40 * INPUT_PRESS_ALLOWANCE_MS + MARGIN_MS,
  );
  assert.equal(
    commandTimeout('simulate_input', { action: 'fire', count: 40 }),
    39 * 200 + 40 * 50 + 40 * INPUT_PRESS_ALLOWANCE_MS + MARGIN_MS,
    'a press with no duration is held for 50ms and the interval defaults to 200ms',
  );
  assert.equal(
    commandTimeout('simulate_input', { action: 'fire', count: 40, interval: 0 }),
    40 * 50 + 40 * INPUT_PRESS_ALLOWANCE_MS + MARGIN_MS,
    'an interval of 0 is budgeted as 0, as the game runs it',
  );
  assert.equal(
    commandTimeout('simulate_input', { action: 'right', duration: 30000 }),
    30000 + INPUT_PRESS_ALLOWANCE_MS + MARGIN_MS,
    'a single hold replies when it ends, so its budget covers the hold',
  );
  assert.equal(commandTimeout('simulate_input', { action: 'fire' }), DEFAULT_COMMAND_TIMEOUT_MS);
  assert.equal(
    commandTimeout('simulate_input', { binding: 'Furibrosa/Switch Weapon', count: 40, interval: 200, duration: 120 }),
    39 * 200 + 40 * 120 + 40 * INPUT_PRESS_ALLOWANCE_MS + MARGIN_MS,
    'a binding is budgeted as an action is',
  );

  const sequence = [
    { action: 'right', duration: 4000, wait: 1000 },
    { action: 'jump', duration: 0 },
    { wait: 250 },
  ];
  assert.equal(
    commandTimeout('simulate_input', { sequence }),
    4000 + 1000 + 50 + 250 + 2 * INPUT_PRESS_ALLOWANCE_MS + MARGIN_MS,
    'a pause step costs only its wait and gets no press allowance',
  );

  const bindingSteps = [
    { binding: 'Furibrosa/Switch Weapon', duration: 4000, wait: 1000 },
    { binding: 'Utility Mod/Pause/Unpause Game' },
  ];
  assert.equal(
    commandTimeout('simulate_input', { sequence: bindingSteps }),
    4000 + 1000 + 50 + 2 * INPUT_PRESS_ALLOWANCE_MS + MARGIN_MS,
    'a binding step is a press: its hold and a press allowance are budgeted',
  );
});

test('a simulate_input budget is a number a timer can hold, whatever the arguments', () => {
  const strings = commandTimeout('simulate_input', {
    sequence: [{ action: 'right', duration: '500' }, { action: 'jump', duration: '500' }],
  });
  assert.equal(strings, DEFAULT_COMMAND_TIMEOUT_MS, 'numeric strings are added as numbers, not concatenated');

  const huge = commandTimeout('simulate_input', { action: 'fire', count: 1e9, interval: 1e9 });
  assert.ok(huge <= 2 ** 31 - 1, `${huge} would be clamped to 1ms by setTimeout`);

  const nonsense = commandTimeout('simulate_input', { action: 'fire', duration: 'x', count: 'y' });
  assert.ok(Number.isFinite(nonsense) && nonsense >= DEFAULT_COMMAND_TIMEOUT_MS);
});

test('simulateInputProblem accepts every well-formed plan', () => {
  for (const args of [
    { action: 'fire' },
    { action: 'fire', duration: 120, count: 3, interval: 0, player: 3 },
    { action: 'jump', sequence: [] },
    { sequence: [{ action: 'right', duration: 200, wait: 100 }, { wait: 300 }], player: 1 },
    { binding: 'Utility Mod/Pause/Unpause Game' },
    { binding: 'Furibrosa/Switch Weapon', duration: 120, count: 3, interval: 0, player: 2 },
    { binding: 'Furibrosa/Switch Weapon', sequence: [] },
    { sequence: [{ binding: 'Furibrosa/Switch Weapon', duration: 100, wait: 50 }, { action: 'jump' }] },
  ]) {
    assert.equal(simulateInputProblem(args), null, JSON.stringify(args));
  }
});

test('an input plan is polled until it ends, and other commands are answered meanwhile', { timeout: 10000 }, async (t) => {
  let polls = 0;
  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'simulate_input') {
      reply(socket, request.id, { pending: true, planId: 9, remainingMs: 400 });
    } else if (request.method === 'input_plan') {
      polls++;
      reply(socket, request.id, polls < 3
        ? { pending: true, planId: 9, remainingMs: 100 }
        : { success: true, steps: 2, totalMs: 300, player: 0, framesRead: [5, 4] });
    } else {
      reply(socket, request.id, { from: request.method });
    }
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const plan = client.sendCommand('simulate_input', { sequence: [{ action: 'right' }, { action: 'jump' }] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(client.inFlightCommands(), ['simulate_input'], 'a plan between polls is still in flight');

  const ping = await client.sendCommand('ping', {});
  assert.deepEqual(ping, { from: 'ping' }, 'a command sent while the plan runs is answered at once');

  const result = await plan;
  assert.deepEqual(result.framesRead, [5, 4]);
  assert.equal(polls, 3);
  assert.deepEqual(seen.filter((m) => m !== 'ping'), ['simulate_input', 'input_plan', 'input_plan', 'input_plan']);
  assert.deepEqual(client.inFlightCommands(), []);
});

test('a refused plan is answered without polling', { timeout: 10000 }, async (t) => {
  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    reply(socket, request.id, { success: false, error: 'Unknown input action: dance' });
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const result = await client.sendCommand('simulate_input', { action: 'dance' });
  assert.equal(result.error, 'Unknown input action: dance');
  assert.deepEqual(seen, ['simulate_input']);
});

test('a plan the game never finishes times out on its own budget', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer((request, socket) => {
    reply(socket, request.id, { pending: true, planId: 3, remainingMs: 0 });
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(
    client.sendCommand('simulate_input', { action: 'fire' }, 300),
    /Command timeout after 300ms: the game had not finished input plan 3/,
  );
  assert.deepEqual(client.inFlightCommands(), []);
});

test('a poll answered after the default command timeout still counts, inside the plan\'s budget', { timeout: 20000 }, async (t) => {
  const stub = await startStubServer((request, socket) => {
    if (request.method === 'simulate_input') {
      reply(socket, request.id, { pending: true, planId: 5, remainingMs: 0 });
    } else {
      setTimeout(() => reply(socket, request.id, { success: true, action: 'right', player: 0, framesRead: 400 }),
        DEFAULT_COMMAND_TIMEOUT_MS + 500);
    }
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const result = await client.sendCommand('simulate_input', { action: 'right', duration: 10000 }, 15000);
  assert.equal(result.framesRead, 400, 'a poll queued behind a slower command is timed by the plan, not the 6s default');
});

test('the initial request is timed to the plan\'s budget, not the 6s default', { timeout: 20000 }, async (t) => {
  const stub = await startStubServer((request, socket) => {
    if (request.method === 'simulate_input') {
      setTimeout(() => reply(socket, request.id, { pending: true, planId: 6, remainingMs: 0 }), DEFAULT_COMMAND_TIMEOUT_MS + 500);
    } else {
      reply(socket, request.id, { success: true, action: 'right', player: 0, framesRead: 12 });
    }
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const result = await client.sendCommand('simulate_input', { action: 'right', duration: 100 }, 15000);
  assert.equal(result.framesRead, 12, 'an acceptance answered after the 6s default still counts');
});

function pendingPlanServer(planId, seen, answerCancel = (request, socket) => reply(socket, request.id, { cancelled: true })) {
  return startStubServer((request, socket) => {
    seen.push(request);
    if (request.method === 'cancel_input_plan') answerCancel(request, socket);
    else reply(socket, request.id, { pending: true, planId, remainingMs: 5000 });
  });
}

test('a cancelled call stops its plan in the game and returns at once', { timeout: 10000 }, async (t) => {
  const seen = [];
  const stub = await pendingPlanServer(7, seen);
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const controller = new AbortController();
  const plan = client.runCall(controller.signal, () => client.sendCommand('simulate_input', { action: 'right', duration: 5000 }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const abortedAt = Date.now();
  controller.abort();
  await assert.rejects(plan, /simulate_input was cancelled/);
  assert.ok(Date.now() - abortedAt < 250, 'the sleep between polls wakes on the abort');

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(seen.map((r) => r.method), ['simulate_input', 'cancel_input_plan'], 'no poll is sent after the abort');
  assert.deepEqual(seen[1].params, { planId: 7 });
  assert.deepEqual(client.inFlightCommands(), []);
});

test('a cancel the game never answers holds nothing up, and its budget drops the connection the plan is tied to', { timeout: 10000 }, async (t) => {
  const seen = [];
  const stub = await pendingPlanServer(8, seen, () => {});
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const controller = new AbortController();
  const plan = client.runCall(controller.signal, () => client.sendCommand('simulate_input', { action: 'right', duration: 5000 }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const abortedAt = Date.now();
  controller.abort();
  await assert.rejects(plan, /simulate_input was cancelled/);
  assert.ok(Date.now() - abortedAt < 250, 'the cancelled call waits for no answer');
  assert.deepEqual(client.inFlightCommands(), [], 'the cancel blocks no launch or wait');

  await new Promise((resolve) => setTimeout(resolve, INPUT_PLAN_CANCEL_BUDGET_MS + 300));
  assert.equal(client.isConnected(), false);
});

test('a plan already finished, or a cancel the game refuses, is no error', { timeout: 10000 }, async (t) => {
  const seen = [];
  const answers = [
    (request, socket) => reply(socket, request.id, { cancelled: false }),
    (request, socket) => socket.write(JSON.stringify({ id: request.id, success: false, error: 'Unknown method: cancel_input_plan' }) + '\n'),
  ];
  const stub = await pendingPlanServer(9, seen, (request, socket) => answers.shift()(request, socket));
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  for (let run = 0; run < 2; run++) {
    const controller = new AbortController();
    const plan = client.runCall(controller.signal, () => client.sendCommand('simulate_input', { action: 'right', duration: 5000 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(plan, /simulate_input was cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(seen.filter((r) => r.method === 'cancel_input_plan').length, 2);
  assert.equal(client.isConnected(), true);
});

test('a call cancelled with its poll running sends no cancel: the socket it drops stops the plan', { timeout: 10000 }, async (t) => {
  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'simulate_input') reply(socket, request.id, { pending: true, planId: 10, remainingMs: 0 });
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const controller = new AbortController();
  const plan = client.runCall(controller.signal, () => client.sendCommand('simulate_input', { action: 'right', duration: 5000 }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(seen, ['simulate_input', 'input_plan']);
  controller.abort();
  await assert.rejects(plan, /simulate_input was cancelled/);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(seen, ['simulate_input', 'input_plan'], 'no cancel goes out, and nothing reconnects to send one');
  assert.equal(client.isConnected(), false);
  assert.equal(stub.connectionCount, 1);
});

test('a call cancelled with its poll queued behind another command still cancels the plan', { timeout: 10000 }, async (t) => {
  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    if (request.method === 'simulate_input') reply(socket, request.id, { pending: true, planId: 11, remainingMs: 0 });
    else if (request.method === 'execute_code') setTimeout(() => reply(socket, request.id, { resultSet: false }), 400);
    else reply(socket, request.id, { cancelled: true });
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const controller = new AbortController();
  const plan = client.runCall(controller.signal, () => client.sendCommand('simulate_input', { action: 'right', duration: 5000 }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const slow = client.sendCommand('execute_code', { code: 'return;' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(seen.at(-1), 'execute_code', 'the poll is queued behind the slower command');
  controller.abort();
  await assert.rejects(plan, /simulate_input was cancelled/);
  await slow;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(seen.at(-1), 'cancel_input_plan');
  assert.ok(!seen.includes('input_plan'), 'the queued poll was never written');
});

test('a plan past its budget is cancelled too, so the game stops pressing when the caller gives up', { timeout: 10000 }, async (t) => {
  const seen = [];
  const stub = await pendingPlanServer(12, seen);
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  await assert.rejects(client.sendCommand('simulate_input', { action: 'fire' }, 300), /had not finished input plan 12/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(seen.at(-1).method, 'cancel_input_plan');
});

test('a plan that ends by itself sends no cancel', { timeout: 10000 }, async (t) => {
  const seen = [];
  const stub = await startStubServer((request, socket) => {
    seen.push(request.method);
    reply(socket, request.id, request.method === 'simulate_input'
      ? { pending: true, planId: 13, remainingMs: 0 }
      : { success: true, action: 'fire', player: 0, framesRead: 2 });
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  await client.sendCommand('simulate_input', { action: 'fire' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen, ['simulate_input', 'input_plan']);
});

test('a plan queued behind a slower command keeps its whole budget', { timeout: 10000 }, async (t) => {
  const stub = await startStubServer((request, socket) => {
    if (request.method === 'execute_code') {
      setTimeout(() => reply(socket, request.id, { resultSet: false }), 800);
    } else if (request.method === 'simulate_input') {
      reply(socket, request.id, { pending: true, planId: 8, remainingMs: 100 });
    } else {
      reply(socket, request.id, { success: true, action: 'fire', player: 0, framesRead: 2 });
    }
  });
  const client = connectedClient(stub.port);
  t.after(async () => { client.disconnect(); await stub.close(); });

  const slow = client.sendCommand('execute_code', { code: 'return;' });
  const plan = client.sendCommand('simulate_input', { action: 'fire' }, 500);
  await slow;
  const result = await plan;
  assert.equal(result.framesRead, 2, 'the budget counts from the plan being sent, not from its wait in the queue');
});
