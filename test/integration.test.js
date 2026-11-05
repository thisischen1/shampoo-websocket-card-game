// End-to-end over a real socket: a real server on an ephemeral port, real `ws`
// clients, a full three-player game driven entirely from the redacted views.
//
// The engine tests prove the rules. This file proves the *protocol*: that a
// client can play a game knowing only what the wire tells it, that cheating is
// refused, and that nothing hidden ever crosses the wire. Every frame every
// client receives is kept and audited.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../src/server/index.js';
import { C, S, PERR, LIMITS } from '../src/shared/protocol.js';
import { ERR } from '../src/game/engine.js';
import { POWER } from '../src/shared/cards.js';

const DEADLINE = 5000;

// A bot plays a 100-move game in milliseconds and would trip the per-second
// message cap that exists to stop a runaway browser. Games are driven with the
// cap lifted; the cap itself is proven by its own test, at the real default.
const UNTHROTTLED = { maxMsgsPerSec: 10_000 };

/** Boot the real server on port 0 so tests never collide with a dev instance. */
async function harness(options = {}) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const open = [];

  const connect = async (label) => {
    const client = new Client(url, label);
    open.push(client);
    await once(client.ws, 'open');
    return client;
  };

  const close = async () => {
    for (const c of open) c.ws.close();
    server.close();
    server.sockets.close();
    await once(server, 'close');
  };

  return { url, connect, close, allClients: open };
}

class Client {
  constructor(url, label) {
    this.label = label;
    this.ws = new WebSocket(url);
    this.frames = [];       // raw text of everything received, for leak audits
    this.violations = [];   // redaction breaches caught as the frames arrive
    this.waiters = [];
    this.state = null;
    this.room = null;
    this.welcome = null;
    this.notices = [];
    this.errors = [];
    this.closed = false;

    this.ws.on('message', (raw) => {
      const text = raw.toString('utf8');
      this.frames.push(text);
      const msg = JSON.parse(text);
      if (msg.t === S.STATE) {
        this.state = msg;
        this.audit(msg);
      }
      if (msg.t === S.ROOM) this.room = msg;
      if (msg.t === S.WELCOME) this.welcome = msg;
      if (msg.t === S.NOTICE) this.notices.push(msg);
      if (msg.t === S.ERROR) this.errors.push(msg);
      for (const w of this.waiters.splice(0)) w(msg);
    });

    this.ws.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  /**
   * Checked on every single state frame, for the whole game — a leak that only
   * happens on one turn in forty still fails the run.
   */
  audit(view) {
    const withHand = view.players.filter((p) => 'hand' in p).map((p) => p.seatId);
    if (withHand.length !== 1 || withHand[0] !== view.you) {
      this.violations.push(`hand keys ${JSON.stringify(withHand)} but you=${view.you}`);
    }
    for (const p of view.players) {
      if ('faceDown' in p) this.violations.push(`seat ${p.seatId} shipped faceDown contents`);
      if (typeof p.faceDownCount !== 'number') this.violations.push(`seat ${p.seatId} has no count`);
    }
    if ('cards' in view.pile) this.violations.push('pile shipped its contents');
    if (view.pile.count > 1 && view.pile.top === null) this.violations.push('pile top missing');
  }

  raw(obj) { this.ws.send(JSON.stringify(obj)); }
  send(t, body = {}) { this.raw({ t, ...body }); }

  nextFrame() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `${this.label}: no frame within ${DEADLINE}ms`
        + ` (last error: ${JSON.stringify(this.lastError() ?? null)})`,
      )), DEADLINE);
      this.waiters.push((m) => { clearTimeout(timer); resolve(m); });
    });
  }

  /** Settle once `pred` holds. Checks the current snapshot first, so no races. */
  async until(pred, what = 'a condition') {
    const started = Date.now();
    while (!pred(this)) {
      if (Date.now() - started > DEADLINE) throw new Error(`${this.label}: timeout on ${what}`);
      await this.nextFrame();
    }
    return this;
  }

  lastError() { return this.errors[this.errors.length - 1]; }
}

// ------------------------------------------------------------------- the bot

/**
 * Decides a move from a redacted view and nothing else — no access to server
 * state. If this can finish a game, a browser can.
 *
 * It plays its lowest legal rank, and every copy of it. Greedy-low drains hands
 * instead of hoarding, so games end in a couple of hundred moves rather than
 * the thousands a uniform random bot takes.
 */
function chooseAction(view) {
  const { me, turnSeq } = view;
  if (me.mustFlip) return { t: C.FLIP_FACE_DOWN, index: 0, turnSeq };

  const mine = view.players.find((p) => p.seatId === view.you);
  const open = me.zone === 'hand' ? mine.hand : me.zone === 'faceUp' ? mine.faceUp : [];
  const playable = open.filter((c) => me.playableCardIds.includes(c.id));
  if (playable.length === 0) return { t: C.PICK_UP_PILE, turnSeq };

  let lowest = playable[0];
  for (const card of playable) {
    if (POWER[card.rank] < POWER[lowest.rank]) lowest = card;
  }
  const cardIds = open.filter((c) => c.rank === lowest.rank).map((c) => c.id).slice(0, 4);
  return { t: C.PLAY_CARDS, cardIds, turnSeq };
}

// --------------------------------------------------------------- choreography

async function createRoom(h, name = 'Ana', maxPlayers = 3) {
  const host = await h.connect(name);
  host.send(C.CREATE_ROOM, { name, maxPlayers });
  await host.until((c) => c.welcome, 'welcome');
  return host;
}

async function joinRoom(h, code, name) {
  const client = await h.connect(name);
  client.send(C.JOIN_ROOM, { code, name });
  await client.until((c) => c.welcome, 'welcome');
  return client;
}

/** Everyone plays what they were dealt, so starting is just waiting for the deal. */
async function awaitDeal(clients) {
  for (const c of clients) await c.until((x) => x.state?.phase === 'playing', 'play to begin');
}

/** Drive the game to its end, one action at a time, from the views only. */
async function playOut(clients, cap = 600) {
  let actions = 0;
  while (clients[0].state.phase !== 'gameover') {
    assert.ok(++actions <= cap, `game did not finish within ${cap} actions`);
    const turn = clients.find((c) => c.state?.me?.yourTurn);
    assert.ok(turn, `nobody is on turn at action ${actions} (current=${clients[0].state.current})`);

    const before = turn.state.turnSeq;
    turn.raw(chooseAction(turn.state));
    await turn.until((c) => c.state.turnSeq > before, 'the turn to advance');
    const reached = turn.state.turnSeq;
    for (const c of clients) await c.until((x) => x.state.turnSeq >= reached, 'everyone to sync');
  }
  return actions;
}

// --------------------------------------------------------------------- tests

test('three real clients play a whole game over the wire', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 3);
    const code = ana.welcome.roomCode;
    assert.equal(ana.welcome.protocolVersion, 1);
    assert.equal(ana.welcome.you, 0);
    assert.equal(ana.welcome.isHost, true);
    assert.match(ana.welcome.resumeToken, /^[0-9a-f]{32}$/);

    const bob = await joinRoom(h, code, 'Bob');
    const cy = await joinRoom(h, code, 'Cy');
    const clients = [ana, bob, cy];

    await ana.until((c) => c.room?.seats.length === 3, 'a full lobby');
    assert.deepEqual(ana.room.seats.map((s) => s.name), ['Ana', 'Bob', 'Cy']);
    assert.equal(ana.room.canStart, true);
    assert.equal(ana.room.phase, 'lobby');

    // The lobby must never carry card data — the game has not even dealt yet.
    assert.equal(JSON.stringify(ana.room).includes('"rank"'), false);

    ana.send(C.START_GAME);
    await awaitDeal(clients);

    // Exactly one player starts, and the notice names them without the card.
    const start = ana.notices.find((n) => n.kind === 'start');
    assert.ok(start, 'a start notice is announced');
    assert.match(start.text, /^(Ana|Bob|Cy) (has the lowest card and starts|starts)$/);

    const onTurn = clients.filter((c) => c.state.me.yourTurn);
    assert.equal(onTurn.length, 1, 'exactly one seat is on turn');

    const actions = await playOut(clients);
    assert.ok(actions > 10, `a real game takes more than a handful of moves (got ${actions})`);

    // Everyone agrees on the outcome, and the loser is the one still holding cards.
    const views = clients.map((c) => c.state);
    const losers = new Set(views.map((v) => v.loser));
    assert.equal(losers.size, 1, 'all three clients name the same loser');
    const loser = views[0].loser;
    assert.equal(typeof loser, 'number');
    assert.deepEqual(views[0].finishedOrder.includes(loser), false);
    assert.equal(views[0].finishedOrder.length, 2, 'two of three got out');

    const loserView = clients[loser].state;
    const own = loserView.players.find((p) => p.seatId === loser);
    assert.ok(
      own.hand.length + own.faceUp.length + own.faceDownCount > 0,
      'the loser is still holding cards',
    );

    for (const c of clients) {
      assert.deepEqual(c.violations, [], `${c.label} saw a redaction breach`);
      assert.deepEqual(c.errors, [], `${c.label} hit a protocol error`);
    }
  } finally {
    await h.close();
  }
});

test('nothing hidden crosses the wire, audited over every frame of a game', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 3);
    const bob = await joinRoom(h, ana.welcome.roomCode, 'Bob');
    const cy = await joinRoom(h, ana.welcome.roomCode, 'Cy');
    const clients = [ana, bob, cy];

    ana.send(C.START_GAME);
    await awaitDeal(clients);

    // Snapshot what is secret right now, then check it never reached anyone else.
    const secrets = new Map();
    for (const c of clients) {
      const mine = c.state.players.find((p) => p.seatId === c.state.you);
      secrets.set(c.state.you, mine.hand.map((card) => card.id));
    }
    const upTo = new Map(clients.map((c) => [c, c.frames.length]));

    for (const viewer of clients) {
      const seen = viewer.frames.slice(0, upTo.get(viewer)).join('\n');
      for (const [seat, ids] of secrets) {
        if (seat === viewer.state.you) continue;
        for (const id of ids) {
          assert.equal(
            seen.includes(`"${id}"`), false,
            `${viewer.label} was sent seat ${seat}'s hand card ${id}`,
          );
        }
      }
    }

    await playOut(clients);

    // Face-down contents are never serialized for anybody, including the owner,
    // for the entire life of the game. A flip reveals via an event instead.
    for (const c of clients) {
      const all = c.frames.join('\n');
      assert.equal(all.includes('"faceDown":['), false, `${c.label} received faceDown contents`);
      assert.equal(all.includes('"stock":['), false, `${c.label} received the stock`);
      assert.deepEqual(c.violations, []);
    }
  } finally {
    await h.close();
  }
});

test('cheating is refused: foreign cards, out of turn, stale taps, locked zones', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 2);
    const bob = await joinRoom(h, ana.welcome.roomCode, 'Bob');
    const clients = [ana, bob];

    ana.send(C.START_GAME);
    await awaitDeal(clients);

    const onTurn = clients.find((c) => c.state.me.yourTurn);
    const waiting = clients.find((c) => !c.state.me.yourTurn);

    // 1. Playing out of turn, in the middle of a live game.
    const mineWaiting = waiting.state.players.find((p) => p.seatId === waiting.state.you);
    waiting.send(C.PLAY_CARDS, {
      cardIds: [mineWaiting.hand[0].id],
      turnSeq: waiting.state.turnSeq,
    });
    await waiting.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(waiting.lastError().code, ERR.NOT_YOUR_TURN);

    // 2. Claiming a card from somebody else's hand. The id is a guess from the
    //    cheat's own view, which is exactly the information an attacker has.
    const held = new Set([
      ...mineWaiting.hand.map((c) => c.id),
      ...onTurn.state.players.find((p) => p.seatId === onTurn.state.you).hand.map((c) => c.id),
    ]);
    const foreign = ['3H', '4H', '5H', '6H', '7H', '8H', '9H', '10H', 'JH']
      .find((id) => !held.has(id));
    assert.ok(foreign, 'a card the cheat demonstrably does not hold');

    const statesBefore = onTurn.frames.filter((f) => f.includes(`"t":"${S.STATE}"`)).length;
    onTurn.send(C.PLAY_CARDS, { cardIds: [foreign], turnSeq: onTurn.state.turnSeq });
    await onTurn.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(onTurn.lastError().code, ERR.CARD_NOT_IN_ZONE);
    // A rejected id means the client's board was wrong, so it is resynced too.
    await onTurn.until(
      (c) => c.frames.filter((f) => f.includes(`"t":"${S.STATE}"`)).length > statesBefore,
      'a fresh snapshot',
    );

    // 3. A stale turnSeq — the double-tap guard.
    onTurn.errors.length = 0;
    const mineTurn = onTurn.state.players.find((p) => p.seatId === onTurn.state.you);
    const playable = mineTurn.hand.find((c) => onTurn.state.me.playableCardIds.includes(c.id));
    onTurn.send(C.PLAY_CARDS, {
      cardIds: [(playable ?? mineTurn.hand[0]).id],
      turnSeq: onTurn.state.turnSeq - 1,
    });
    await onTurn.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(onTurn.lastError().code, ERR.STALE);

    // 4. Face-up cards are locked while hand cards remain.
    onTurn.errors.length = 0;
    onTurn.send(C.PLAY_CARDS, {
      cardIds: [mineTurn.faceUp[0].id],
      turnSeq: onTurn.state.turnSeq,
    });
    await onTurn.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(onTurn.lastError().code, ERR.CARD_NOT_IN_ZONE);

    // 5. A non-host cannot start, stop or reconfigure anything.
    bob.errors.length = 0;
    bob.send(C.SET_MAX_PLAYERS, { maxPlayers: 5 });
    await bob.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(bob.lastError().code, PERR.NOT_HOST);

    // 6. Taking the pile for another seat is refused until that seat is stuck.
    ana.errors.length = 0;
    ana.send(C.PICK_UP_FOR_SEAT, { seatId: 1, turnSeq: ana.state.turnSeq });
    await ana.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(ana.lastError().code, PERR.TOO_SOON);

    // None of that moved the game on.
    assert.equal(onTurn.state.phase, 'playing');
    assert.ok(onTurn.state.me.yourTurn, 'the turn never changed hands');
  } finally {
    await h.close();
  }
});

test('malformed and oversized frames are refused, and a huge one drops the socket', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const c = await h.connect('probe');

    c.send('noSuchMessage');
    await c.until((x) => x.errors.length > 0, 'a rejection');
    assert.equal(c.lastError().code, PERR.BAD_MESSAGE);

    c.ws.send('{not json');
    await c.until((x) => x.errors.length > 1, 'a rejection');
    assert.equal(c.lastError().code, PERR.BAD_MESSAGE);

    c.send(C.JOIN_ROOM, { code: 'ZZZZ', name: 'Nobody' });
    await c.until((x) => x.errors.length > 2, 'a rejection');
    assert.equal(c.lastError().code, PERR.NO_ROOM);

    c.send(C.PLAY_CARDS, { cardIds: ['7H'], turnSeq: 0 });
    await c.until((x) => x.errors.length > 3, 'a rejection');
    assert.equal(c.lastError().code, PERR.NOT_IN_ROOM);

    // A megabyte never reaches the router: `maxPayload` kills the connection at
    // the framing layer, which is the cheapest possible place to stop it.
    const flood = await h.connect('flood');
    flood.ws.send(JSON.stringify({ t: C.SET_NAME, name: 'x'.repeat(1024 * 1024) }));
    await once(flood.ws, 'close');
    assert.equal(flood.closed, true, 'the socket is dropped, not merely answered');
    assert.deepEqual(flood.errors, [], 'nothing is even parsed');
  } finally {
    await h.close();
  }
});

test('a dropped client resumes its exact seat and hand mid-game', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 2);
    const code = ana.welcome.roomCode;
    const bob = await joinRoom(h, code, 'Bob');

    ana.send(C.START_GAME);
    await awaitDeal([ana, bob]);

    const token = bob.welcome.resumeToken;
    const before = bob.state.players.find((p) => p.seatId === 1);
    const handBefore = before.hand.map((c) => c.id);
    const seqBefore = bob.state.turnSeq;

    bob.ws.close();
    await once(bob.ws, 'close');
    await ana.until((c) => c.state.players[1].connected === false, 'bob to go grey');

    const bob2 = await h.connect('Bob-again');
    bob2.send(C.RESUME, { code, resumeToken: token });
    await bob2.until((c) => c.state?.phase === 'playing', 'a full snapshot');

    assert.equal(bob2.welcome.you, 1, 'the same seat');
    assert.equal(bob2.state.turnSeq, seqBefore, 'the same turn');
    const after = bob2.state.players.find((p) => p.seatId === 1);
    assert.deepEqual(after.hand.map((c) => c.id), handBefore, 'the same hand');
    assert.deepEqual(bob2.violations, []);
    await ana.until((c) => c.state.players[1].connected === true, 'bob to come back');

    // A bad token is fatal, so the client clears storage and goes home.
    const impostor = await h.connect('impostor');
    impostor.send(C.RESUME, { code, resumeToken: 'f'.repeat(32) });
    await impostor.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(impostor.lastError().code, PERR.BAD_TOKEN);

    // And the game is still playable afterwards.
    await playOut([ana, bob2]);
    assert.equal(ana.state.phase, 'gameover');
  } finally {
    await h.close();
  }
});

test('the lobby gates joins, and three games in a row accumulate scores', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 2);
    const code = ana.welcome.roomCode;
    const bob = await joinRoom(h, code, 'Bob');
    const clients = [ana, bob];

    // A third player cannot squeeze into a two-seat room.
    const spare = await h.connect('Spare');
    spare.send(C.JOIN_ROOM, { code, name: 'Spare' });
    await spare.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(spare.lastError().code, PERR.ROOM_FULL);

    const losses = [];
    for (let game = 1; game <= 3; game++) {
      if (game === 1) ana.send(C.START_GAME);
      else ana.send(C.START_NEXT_GAME);

      await awaitDeal(clients);
      assert.equal(ana.state.gameId, game, 'the game id counts up');

      // Nobody may join once the cards are out.
      spare.errors.length = 0;
      spare.send(C.JOIN_ROOM, { code, name: 'Spare' });
      await spare.until((c) => c.errors.length > 0, 'a rejection');
      assert.equal(spare.lastError().code, PERR.GAME_IN_PROGRESS);

      await playOut(clients);
      losses.push(ana.state.loser);

      const board = ana.state.scores;
      assert.equal(board[0].games, game, 'every seat played every game');
      assert.equal(board[1].games, game);
      assert.equal(
        board[0].losses + board[1].losses, game,
        'exactly one loss is recorded per game',
      );
      assert.equal(board[0].wins, board[0].games - board[0].losses);
    }

    // Seats and names survived three games; the tally matches the results.
    assert.deepEqual(ana.state.players.map((p) => p.name), ['Ana', 'Bob']);
    const tally = [0, 1].map((seat) => losses.filter((l) => l === seat).length);
    assert.deepEqual([ana.state.scores[0].losses, ana.state.scores[1].losses], tally);

    for (const c of clients) assert.deepEqual(c.violations, []);
  } finally {
    await h.close();
  }
});

// Everything the postgame screen draws from, proven over the wire: the
// placements, the readiness tally, and the two ways out of the finished game.
test('the postgame view carries placements and readiness, and the host can reset', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 3);
    const code = ana.welcome.roomCode;
    const bob = await joinRoom(h, code, 'Bob');
    const cy = await joinRoom(h, code, 'Cy');
    const clients = [ana, bob, cy];

    ana.send(C.START_GAME);
    await awaitDeal(clients);
    await playOut(clients);

    // ---- placements: everyone who got out, in order, and nobody twice. The
    // loser is deliberately absent from finishedOrder — they never went out.
    const view = ana.state;
    assert.equal(view.phase, 'gameover');
    assert.equal(view.finishedOrder.length, 2, 'two of three got out');
    assert.equal(new Set(view.finishedOrder).size, 2);
    assert.ok(!view.finishedOrder.includes(view.loser), 'the loser never went out');

    const bySeat = new Map(view.players.map((p) => [p.seatId, p]));
    for (const [i, seat] of view.finishedOrder.entries()) {
      assert.equal(bySeat.get(seat).place, i + 1, 'place matches the finish order');
      assert.equal(bySeat.get(seat).out, true);
    }
    assert.equal(bySeat.get(view.loser).out, false);
    assert.equal(bySeat.get(view.loser).place, null);

    // ---- readiness. It is room state, but the postgame screen only ever sees
    // `state` frames, so it has to ride on those.
    for (const c of clients) assert.equal(bySeat.get(c.welcome.you).playAgainReady, false);

    bob.send(C.PLAY_AGAIN_READY, { ready: true });
    await ana.until(
      (c) => c.state.players.find((p) => p.seatId === bob.welcome.you).playAgainReady,
      "Bob's readiness reaching the host",
    );
    assert.equal(
      ana.state.players.filter((p) => p.playAgainReady).length, 1,
      'one ready, and only the one who said so',
    );

    // ---- back to the lobby: the game goes, the scoreboard does not.
    cy.send(C.BACK_TO_LOBBY);
    await cy.until((c) => c.errors.length > 0, 'a non-host rejection');
    assert.equal(cy.lastError().code, PERR.NOT_HOST);

    ana.send(C.BACK_TO_LOBBY);
    // Waiting on gamesStarted, not on phase: the pre-game lobby frame is also
    // phase 'lobby', so that predicate would match the stale one and pass
    // without the reset ever having happened.
    await ana.until((c) => c.room?.gamesStarted === 1, 'the lobby after one game');
    assert.equal(ana.room.phase, 'lobby');
    assert.equal(ana.room.seats.length, 3, 'nobody lost their seat');
    assert.equal(ana.room.canStart, true);
    assert.equal(
      ana.room.scoreboard.reduce((n, r) => n + r.losses, 0), 1,
      'the session tally survived the reset',
    );
    // Readiness is cleared, or the next postgame screen opens pre-ready.
    assert.deepEqual(ana.room.seats.map((s) => s.playAgainReady), [false, false, false]);
    assert.equal(JSON.stringify(ana.room).includes('"rank"'), false);

    for (const c of clients) assert.deepEqual(c.violations, []);
  } finally {
    await h.close();
  }
});

test('the room empties and is collected when everybody leaves', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 3);
    const code = ana.welcome.roomCode;
    const bob = await joinRoom(h, code, 'Bob');

    bob.send(C.LEAVE_ROOM);
    await bob.until((c) => c.room?.left === true, 'a goodbye');
    await ana.until((c) => c.room?.seats.length === 1, 'bob to vanish');

    // Having left, the connection holds no seat and can join afresh.
    bob.errors.length = 0;
    bob.send(C.JOIN_ROOM, { code, name: 'Bob' });
    await bob.until((c) => c.welcome?.you === 1, 'a new seat');
    assert.deepEqual(bob.errors, []);

    // Ping/pong keeps working regardless of room membership.
    ana.send(C.PING);
    await ana.until((c) => c.frames.some((f) => f.includes(`"${S.PONG}"`)), 'a pong');

    ana.ws.close();
    bob.ws.close();
    await once(bob.ws, 'close');
  } finally {
    await h.close();
  }
});

test('you play the hand you were dealt, and rearranging it is not a thing', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 2);
    const bob = await joinRoom(h, ana.welcome.roomCode, 'Bob');

    // Straight from the lobby to a live turn: no phase sits between them.
    ana.send(C.START_GAME);
    await ana.until((c) => c.state?.phase === 'playing', 'play to begin');

    const mine = ana.state.players.find((p) => p.seatId === 0);
    const hand = mine.hand.map((c) => c.id);
    const faceUp = mine.faceUp.map((c) => c.id);
    assert.equal(hand.length, 3);
    assert.equal(faceUp.length, 3);
    assert.equal(mine.faceDownCount, 3);

    // The old rearrange message is gone from the protocol, so asking to trade a
    // hand card for a face-up one is now simply not a request the server knows.
    ana.errors.length = 0;
    ana.raw({
      t: 'setSwap',
      hand: [faceUp[0], hand[1], hand[2]],
      faceUp: [hand[0], faceUp[1], faceUp[2]],
    });
    await ana.until((c) => c.errors.length > 0, 'a rejection');
    assert.equal(ana.lastError().code, PERR.BAD_MESSAGE);

    // And the cards sat exactly where they were dealt.
    const after = ana.state.players.find((p) => p.seatId === 0);
    assert.deepEqual(after.hand.map((c) => c.id), hand);
    assert.deepEqual(after.faceUp.map((c) => c.id), faceUp);
    assert.deepEqual(ana.violations, []);
    assert.deepEqual(bob.violations, []);
  } finally {
    await h.close();
  }
});

test('the rate limiter clamps a runaway client without killing the room', async () => {
  const h = await harness(); // the real production cap, deliberately
  try {
    const ana = await createRoom(h, 'Ana', 2);
    for (let i = 0; i < LIMITS.MAX_MSGS_PER_SEC + 15; i++) ana.send(C.PING);
    await ana.until((c) => c.errors.length > 0, 'a clamp');
    assert.equal(ana.lastError().code, PERR.RATE_LIMIT);

    // The socket survives, and the room is intact.
    assert.equal(ana.closed, false);
    await new Promise((r) => setTimeout(r, 1100));
    ana.errors.length = 0;
    ana.send(C.SET_NAME, { name: 'Ana B' });
    await ana.until((c) => c.room?.seats[0].name === 'Ana B', 'the rename');
    assert.deepEqual(ana.errors, []);
  } finally {
    await h.close();
  }
});

test('a stalled seat unlocks the host rescue, but only once and only for the host', async () => {
  // A controllable clock: the stall threshold is a minute of wall time, and the
  // whole point of injecting `now` is that the test does not have to wait it out.
  let clock = Date.now();
  // A fast poll as well as a fake clock: the frame that reveals the rescue is
  // cut by the server's own timer, not by anything a client does, so the test
  // would otherwise sit through a real interval to see it.
  const h = await harness({ ...UNTHROTTLED, now: () => clock, stallPollMs: 20 });
  try {
    const ana = await createRoom(h, 'Ana', 3);
    const code = ana.welcome.roomCode;
    const bob = await joinRoom(h, code, 'Bob');
    const cat = await joinRoom(h, code, 'Cat');

    ana.send(C.START_GAME);
    await awaitDeal([ana, bob, cat]);

    const all = [ana, bob, cat];
    // Put something in the pile, and leave the turn on somebody who is not the
    // host — the host cannot rescue their own seat, and would not need to.
    while (ana.state.current === 0 || ana.state.pile.count === 0) {
      const turn = all.find((c) => c.state.me.yourTurn);
      const before = turn.state.turnSeq;
      turn.raw(chooseAction(turn.state));
      await turn.until((c) => c.state.turnSeq > before, 'the turn to advance');
      for (const c of all) await c.until((x) => x.state.turnSeq >= turn.state.turnSeq, 'sync');
    }

    const stuck = ana.state.current;
    const victim = all[stuck];
    const seq = ana.state.turnSeq;
    const pileCount = ana.state.pile.count;

    // While they are merely connected, there is nothing to rescue them from.
    ana.send(C.FORFEIT_SEAT, { seatId: stuck });
    await ana.until((c) => c.errors.length > 0, 'a refusal');
    assert.equal(ana.lastError().code, PERR.SEAT_CONNECTED);
    ana.errors.length = 0;

    victim.ws.close();
    await once(victim.ws, 'close');
    await ana.until((c) => c.state.players[stuck].connected === false, 'them to go grey');

    // Dropped, but not yet *stalled*. The host must wait out the clock.
    assert.equal(ana.state.stuckSeat, null, 'no rescue the instant they drop');
    ana.send(C.PICK_UP_FOR_SEAT, { seatId: stuck, turnSeq: seq });
    await ana.until((c) => c.errors.length > 0, 'a refusal');
    assert.equal(ana.lastError().code, PERR.TOO_SOON);
    ana.errors.length = 0;

    clock += LIMITS.STUCK_SEAT_MS + 1000;

    // The next frame any action cuts now carries the unlocked seat. Cat asking
    // is enough to produce one, and proves the gate is on the host, not the clock.
    const other = all.find((c) => c !== ana && c !== victim);
    other.send(C.PICK_UP_FOR_SEAT, { seatId: stuck, turnSeq: seq });
    await other.until((c) => c.errors.length > 0, 'a refusal');
    assert.equal(other.lastError().code, PERR.NOT_HOST);

    // Nobody acts here on purpose: this frame can only come from the poll, so
    // reaching it proves a stalled table un-freezes itself without any input.
    await ana.until((c) => c.state.stuckSeat === stuck, 'the poll to unlock the seat');

    ana.send(C.PICK_UP_FOR_SEAT, { seatId: stuck, turnSeq: seq });
    await ana.until((c) => c.state.turnSeq > seq, 'the table to move on');

    assert.equal(ana.state.pile.count, 0, 'the pile went to them');
    assert.equal(ana.state.players[stuck].handCount >= pileCount, true, 'they hold it now');
    assert.notEqual(ana.state.current, stuck, 'and the turn passed');
    assert.equal(ana.state.stuckSeat, null, 'the rescue closes behind itself');
    assert.deepEqual(ana.violations, []);

    // The other half of the rescue: give up on them entirely. Their cards leave
    // play rather than returning to the stock, so the deck stays accounted for.
    ana.send(C.FORFEIT_SEAT, { seatId: stuck });
    await ana.until((c) => c.state.players[stuck].forfeited === true, 'the seat to go');
    assert.equal(ana.state.players[stuck].out, true);
    assert.equal(ana.state.players[stuck].handCount, 0);
    assert.notEqual(ana.state.current, stuck, 'a forfeited seat never holds the turn');
    assert.deepEqual(ana.errors, []);

    // Two players left, so the game is still live and still playable.
    assert.equal(ana.state.phase, 'playing');
    await playOut([ana, other]);
    assert.equal(ana.state.phase, 'gameover');
    assert.deepEqual(ana.violations, []);
  } finally {
    await h.close();
  }
});

test('the host migrates to the next connected seat when the host drops', async () => {
  const h = await harness(UNTHROTTLED);
  try {
    const ana = await createRoom(h, 'Ana', 3);
    const code = ana.welcome.roomCode;
    const bob = await joinRoom(h, code, 'Bob');
    const cat = await joinRoom(h, code, 'Cat');
    await bob.until((c) => c.room?.seats.length === 3, 'everyone seated');
    assert.equal(bob.room.hostSeatId, 0);

    ana.ws.close();
    await once(ana.ws, 'close');
    await bob.until((c) => c.room?.hostSeatId === 1, 'the crown to move');

    // Outside a game a dropped seat is released outright, so Bob is genuinely
    // the host of a two-player room rather than standing in for an absent one.
    assert.equal(bob.room.seats.length, 2);
    assert.deepEqual(bob.room.seats.map((s) => s.seatId), [1, 2]);

    // And the new host can actually exercise the role.
    cat.send(C.START_GAME);
    await cat.until((c) => c.errors.length > 0, 'a refusal');
    assert.equal(cat.lastError().code, PERR.NOT_HOST);

    bob.send(C.START_GAME);
    await bob.until((c) => c.state?.phase === 'playing', 'the game to start');
  } finally {
    await h.close();
  }
});
