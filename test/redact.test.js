import test from 'node:test';
import assert from 'node:assert/strict';
import { viewFor, roomView } from '../src/game/redact.js';
import { makeState, act, ids } from './helpers.js';

// No card id is a substring of any other ('10H' is the longest, and neither 'H'
// nor '0H' is an id), so a plain string search over the serialized view is a
// sound leak test.
const serialize = (view) => JSON.stringify(view);

const assertAbsent = (json, forbidden, why) => {
  for (const id of forbidden) {
    assert.equal(json.includes(`"${id}"`), false, `${why}: ${id} leaked onto the wire`);
  }
};

const table = () => makeState({
  hands: ['7H 8H 9H', '4C 5C 6C', '4D 5D 6D'],
  faceUp: ['AH AS AD', '3S 7S 8S', '3C 7C 8C'],
  faceDown: ['QH QS QD', '9S JS 10S', '9C JC QC'],
  pile: '5S 6S KS',
  stock: 'KH KD',
  current: 0,
});

const SEATS = {
  0: { name: 'Ana', connected: true, isHost: true },
  1: { name: 'Bob', connected: true },
  2: { name: 'Cy', connected: false },
};

test('a view never carries an opponent hand card', () => {
  const s = table();
  const json = serialize(viewFor(s, 0, { seats: SEATS }));
  assertAbsent(json, [...ids(s.players[1].hand), ...ids(s.players[2].hand)], 'opponent hand');
  // and your own hand *is* there, so the test above is actually proving something
  for (const id of ids(s.players[0].hand)) assert.ok(json.includes(`"${id}"`));
});

test('face-down cards are never sent — not even to their owner', () => {
  const s = table();
  for (const seat of [0, 1, 2]) {
    const json = serialize(viewFor(s, seat, { seats: SEATS }));
    for (const owner of [0, 1, 2]) {
      assertAbsent(json, ids(s.players[owner].faceDown), `seat ${seat} seeing seat ${owner}`);
    }
  }
});

test('the pile sends its top card and a count, never what is underneath', () => {
  const s = table();
  const view = viewFor(s, 0, { seats: SEATS });
  assert.equal(view.pile.count, 3);
  assert.equal(view.pile.top.id, 'KS');
  assertAbsent(serialize(view), ['5S', '6S'], 'buried pile card');
});

test('the stock and the burn pile are counts only', () => {
  const s = table();
  const view = viewFor(s, 0, { seats: SEATS });
  assert.equal(view.stock.count, 2);
  assert.equal(view.burnedCount, s.burned.length);
  assertAbsent(serialize(view), [...ids(s.stock), ...ids(s.burned)], 'face-down stack');
});

test('exactly one player object carries a hand, and it is yours', () => {
  const s = table();
  for (const seat of [0, 1, 2]) {
    const view = viewFor(s, seat, { seats: SEATS });
    const withHand = view.players.filter((p) => 'hand' in p);
    assert.equal(withHand.length, 1);
    assert.equal(withHand[0].seatId, seat);
    for (const p of view.players) {
      assert.equal(typeof p.handCount, 'number', 'every seat still exposes a count');
    }
  }
});

test('face-up cards and counts are public, because the rules say so', () => {
  const s = table();
  const view = viewFor(s, 0, { seats: SEATS });
  assert.deepEqual(ids(view.players[1].faceUp), ['3S', '7S', '8S']);
  assert.equal(view.players[1].handCount, 3);
  assert.equal(view.players[1].faceDownCount, 3);
});

test('room metadata decorates the seats without touching the cards', () => {
  const s = table();
  const view = viewFor(s, 0, { seats: SEATS, scores: { 0: { games: 2, losses: 1 } } });
  assert.equal(view.players[0].name, 'Ana');
  assert.equal(view.players[0].isHost, true);
  assert.equal(view.players[2].connected, false);
  assert.equal(view.players[1].isHost, false);
  assert.deepEqual(view.scores, { 0: { games: 2, losses: 1 } });
});

test('a missing seat gives a spectator-grade view with no `me` block', () => {
  const s = table();
  const view = viewFor(s, 9, { seats: SEATS });
  assert.equal(view.you, null);
  assert.equal(view.me, undefined);
  assert.equal(view.players.every((p) => !('hand' in p)), true);
  assertAbsent(serialize(view), ids(s.players[0].hand), 'spectator view');
});

test('mutating a view cannot reach back into the state', () => {
  const s = table();
  const view = viewFor(s, 0, { seats: SEATS });

  view.players[0].hand[0].rank = '2';
  view.players[0].hand.push({ id: 'XX', rank: '2', suit: 'H' });
  view.players[1].faceUp.length = 0;
  view.pile.top.id = 'ZZ';
  view.me.playableCardIds.push('4C');

  assert.equal(s.players[0].hand[0].rank, '7');
  assert.equal(s.players[0].hand.length, 3);
  assert.equal(s.players[1].faceUp.length, 3);
  assert.equal(s.pile[s.pile.length - 1].id, 'KS');
});

test('me.playableCardIds matches the top card and your active zone', () => {
  const s = table();
  const view = viewFor(s, 0, { seats: SEATS });
  // top is KS, so only the aces (and nothing lower) are legal from hand
  assert.deepEqual(view.me.playableCardIds, []);
  assert.equal(view.me.zone, 'hand');
  assert.equal(view.me.yourTurn, true);
  assert.equal(view.me.canPickUp, true);
  assert.equal(view.me.mustFlip, false);

  const low = makeState({
    hands: ['7H 8H 9H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3S 7S 8S'],
    faceDown: ['QH QS QD', '9S JS 10S'],
    pile: '5S',
    stock: '',
    current: 0,
  });
  const lowView = viewFor(low, 0, { seats: SEATS });
  assert.deepEqual(lowView.me.playableCardIds, ['7H', '8H', '9H']);
});

test('playable ids come from the active zone, so locked face-up cards are excluded', () => {
  const s = table();
  const view = viewFor(s, 0, { seats: SEATS });
  // the aces are legal on a king, but they are face-up behind a full hand
  assert.equal(view.me.playableCardIds.includes('AH'), false);
  assert.equal(view.players[0].faceUp.length, 3, 'still rendered, just locked');
});

test('a face-down-only seat is told to flip and told nothing else', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['', '3S 7S 8S'],
    faceDown: ['QH QS QD', '9S JS 10S'],
    pile: '5S',
    stock: '',
    current: 0,
  });
  const view = viewFor(s, 0, { seats: SEATS });
  assert.equal(view.me.zone, 'faceDown');
  assert.equal(view.me.mustFlip, true);
  assert.equal(view.me.faceDownCount, 3);
  assert.deepEqual(view.me.playableCardIds, []);
  assertAbsent(serialize(view), ['QH', 'QS', 'QD'], 'the cards you are about to flip');
});

test('the bomb hint names your own hot cards without revealing the pile run', () => {
  const s = makeState({
    hands: ['7H 7S 9D', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3S 8S KS'],
    faceDown: ['QH QS QD', '9S JS 10S'],
    pile: '5H 7D 7C',
    stock: '',
    current: 0,
  });
  const view = viewFor(s, 0, { seats: SEATS });
  assert.deepEqual(view.me.bombCardIds, ['7H', '7S'], 'two on the pile plus two in hand');
  assertAbsent(serialize(view), ['7D', '5H'], 'the pile cards that make it a bomb');
  assert.equal(view.pile.top.id, '7C', 'only the top is public');
  assert.equal(view.pile.count, 3);
});

test('events ride inside the state, and a flip reveal is the intended exception', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['', '3S 7S 8S'],
    faceDown: ['QH QS QD', '9S JS 10S'],
    pile: '5S',
    stock: '',
    current: 0,
  });
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });
  const view = viewFor(s, 0, { seats: SEATS, events: res.events });

  assert.equal(view.events[0].e, 'flipped');
  assert.equal(view.events[0].card.id, 'QH');
  // the revealed card is now on the pile, so the face-down redaction still holds
  assertAbsent(serialize({ ...view, events: [] }), ['QS', 'QD'], 'the unflipped cards');
  assert.equal(view.players[0].faceDownCount, 2);
});

test('the redaction holds all the way through a finished game', () => {
  const s = makeState({
    hands: ['AH', '4C 5C 6C'],
    faceUp: ['', '3S 7S 8S'],
    faceDown: ['', '9S JS 10S'],
    pile: '5S',
    stock: '',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['AH'], turnSeq: 1 });
  assert.equal(s.phase, 'gameover');

  const view = viewFor(s, 0, { seats: SEATS });
  assert.equal(view.phase, 'gameover');
  assert.equal(view.loser, 1);
  assert.deepEqual(view.finishedOrder, [0]);
  assertAbsent(serialize(view), [
    ...ids(s.players[1].hand),
    ...ids(s.players[1].faceDown),
  ], 'the loser still keeps their secrets');
});

test('the room view carries seats and scores but no cards at all', () => {
  const view = roomView({
    code: 'K7QM',
    maxPlayers: 4,
    hostSeatId: 0,
    phase: 'lobby',
    seats: [
      { seatId: 0, name: 'Ana', connected: true },
      { seatId: 1, name: 'Bob', connected: false, playAgainReady: true },
    ],
    scores: { 0: { games: 1, losses: 0 } },
  });

  assert.equal(view.t, 'room');
  assert.equal(view.seats[0].isHost, true);
  assert.equal(view.seats[1].isHost, false);
  assert.equal(view.seats[1].playAgainReady, true);
  assert.equal(view.seats[0].playAgainReady, false);
  assert.equal(JSON.stringify(view).includes('rank'), false, 'no card objects anywhere');
});
