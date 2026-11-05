import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { countInstances, warnIfNotAlone, INSTANCE_ID } from '../src/server/instance.js';
import { createApp } from '../src/server/index.js';

// Fly answers `<app>.internal` with one AAAA record per running machine, so a
// fake resolver is the whole test surface. No network, no Fly account.
const resolverFor = (addresses) => ({
  resolve6: async (name) => {
    assert.equal(name, 'shampoo.internal', 'asks Fly for its own app, not something else');
    return addresses;
  },
});

const FLY = { FLY_APP_NAME: 'shampoo' };

test('the instance id is stable within a process', () => {
  assert.equal(typeof INSTANCE_ID, 'string');
  assert.ok(INSTANCE_ID.length > 0);
});

test('one record means one instance, which is the only healthy answer', async () => {
  const count = await countInstances({ env: FLY, dns: resolverFor(['fdaa::1']) });
  assert.equal(count, 1);
});

test('several records mean several instances', async () => {
  const count = await countInstances({ env: FLY, dns: resolverFor(['fdaa::1', 'fdaa::2', 'fdaa::3']) });
  assert.equal(count, 3);
});

test('off Fly there is nothing to ask, and null says so rather than guessing', async () => {
  const dns = { resolve6: async () => assert.fail('must not look anything up without an app name') };
  assert.equal(await countInstances({ env: {}, dns }), null);
});

test('a DNS failure is not an outage — the diagnostic gives up, the server lives', async () => {
  const dns = { resolve6: async () => { throw new Error('ENOTFOUND'); } };
  assert.equal(await countInstances({ env: FLY, dns }), null);
});

test('being alone says nothing at all', async () => {
  const lines = [];
  await warnIfNotAlone({ env: FLY, dns: resolverFor(['fdaa::1']), log: (m) => lines.push(m) });
  assert.deepEqual(lines, [], 'the healthy case must be silent or the warning is worthless');
});

test('being one of several says so, loudly, and names the fix', async () => {
  const lines = [];
  const count = await warnIfNotAlone({
    env: FLY,
    dns: resolverFor(['fdaa::1', 'fdaa::2']),
    log: (m) => lines.push(m),
  });

  assert.equal(count, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 INSTANCES/);
  assert.match(lines[0], /fly scale count 1/, 'a warning without the remedy is just alarm');
  // The lie this whole module exists to explain.
  assert.match(lines[0], /No room with that code/);
});

test('warning is never fatal, because half a game beats no game', async () => {
  // A throwing logger stands in for anything going wrong downstream of the
  // check; the server must still be standing.
  await assert.doesNotReject(() => warnIfNotAlone({ env: {}, dns: { resolve6: async () => [] } }));
});

// --------------------------------------------------------------- the real thing

const boot = async () => {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    stop: async () => { server.close(); server.sockets.close(); await once(server, 'close'); },
  };
};

test('/healthz publishes the instance id, so one machine can be told from two', async () => {
  const s = await boot();
  try {
    const body = await (await fetch(`${s.origin}/healthz`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.instance, INSTANCE_ID, 'the id on the wire is the id we booted with');
  } finally {
    await s.stop();
  }
});

// This is the bug that forces the single-instance rule, pinned as a test so the
// README's claim can never drift from what the code actually does. Two servers
// here stand in for two machines behind one load balancer.
test('a room code minted on one instance does not exist on another', async () => {
  const a = await boot();
  const b = await boot();

  const talk = async (url, msg) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d)));
    await once(ws, 'open');
    ws.send(JSON.stringify(msg));
    await new Promise((r) => setTimeout(r, 120));
    ws.close();
    return frames;
  };

  try {
    const made = await talk(a.wsUrl, { t: 'createRoom', name: 'Ana', maxPlayers: 2 });
    const code = made.find((f) => f.t === 'welcome').roomCode;

    const joined = await talk(b.wsUrl, { t: 'joinRoom', code, name: 'Bob' });
    const error = joined.find((f) => f.t === 'error');

    assert.equal(error?.code, 'ERR_NO_ROOM');
    // And note what the player is actually told. The code is perfectly valid;
    // they are simply talking to the wrong machine. Nothing the server can see
    // distinguishes the two cases, which is exactly why the deploy must pin the
    // instance count rather than try to recover here.
    assert.match(error.message, /No room with that code/);
  } finally {
    await a.stop();
    await b.stop();
  }
});
