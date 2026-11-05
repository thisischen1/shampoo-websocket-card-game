import assert from 'node:assert/strict';
import { makeDeck, parseCards } from '../src/shared/cards.js';
import { applyAction, legalActions } from '../src/game/engine.js';
import { assertStateSane, assertDeckIntegrity } from '../src/game/invariants.js';

/**
 * Build an exact game state from readable card notation. Every card not named
 * is dumped into the stock (or `burned`, if you want an empty stock) so deck
 * integrity always holds.
 *
 *   makeState({
 *     hands:    ['7H 7S 9D', '3C 4C 5C'],
 *     faceUp:   ['KH QH JH', '2S 2D 2C'],
 *     faceDown: ['AH AS AD', '6H 6S 6C'],
 *     pile:     '7D 7C',
 *     stock:    '',          // '' => empty stock, leftovers go to burned
 *     current:  0,
 *   })
 */
export function makeState({
  hands = [],
  faceUp = [],
  faceDown = [],
  pile = '',
  stock = null,
  burned = '',
  current = 0,
  phase = 'playing',
  turnSeq = 1,
  gameId = 1,
  seed = 1,
} = {}) {
  const n = Math.max(hands.length, faceUp.length, faceDown.length);
  const seatOrder = Array.from({ length: n }, (_, i) => i);

  const players = {};
  const used = new Set();
  const take = (spec) => {
    const cards = parseCards(spec);
    for (const c of cards) {
      if (used.has(c.id)) throw new Error(`card ${c.id} used twice in fixture`);
      used.add(c.id);
    }
    return cards;
  };

  for (const seat of seatOrder) {
    players[seat] = {
      seatId: seat,
      hand: take(hands[seat] ?? ''),
      faceUp: take(faceUp[seat] ?? ''),
      faceDown: take(faceDown[seat] ?? ''),
      out: false,
      place: null,
      forfeited: false,
    };
  }

  const pileCards = take(pile);
  const burnedCards = take(burned);
  const leftovers = makeDeck().filter((c) => !used.has(c.id));

  let stockCards;
  if (stock === null) {
    stockCards = leftovers; // default: everything unnamed is still in the stock
  } else {
    stockCards = take(stock);
    burnedCards.push(...leftovers.filter((c) => !used.has(c.id)));
  }

  const state = {
    gameId,
    seed,
    phase,
    seatOrder,
    players,
    stock: stockCards,
    pile: pileCards,
    burned: burnedCards,
    current,
    turnSeq,
    loser: null,
    finishedOrder: [],
    startingSeat: current,
    startReason: 'fixture',
    log: [],
  };

  // Mark anyone dealt no cards at all as already out.
  for (const seat of seatOrder) {
    const p = state.players[seat];
    if (!p.hand.length && !p.faceUp.length && !p.faceDown.length) {
      p.out = true;
      state.finishedOrder.push(seat);
      p.place = state.finishedOrder.length;
    }
  }

  assertDeckIntegrity(state);
  return state;
}

/** Apply an action, assert it succeeded, and re-check invariants. */
export function act(state, action) {
  const res = applyAction(state, action);
  assert.ok(res.ok, `action ${action.type} failed: ${res.error} ${res.detail ?? ''}`);
  assertStateSane(state);
  return res;
}

/** Apply an action expected to be rejected with `code`. */
export function rejects(state, action, code) {
  const before = snapshot(state);
  const res = applyAction(state, action);
  assert.equal(res.ok, false, `expected ${action.type} to fail`);
  if (code) assert.equal(res.error, code);
  assert.deepEqual(snapshot(state), before, 'a rejected action must not mutate state');
  return res;
}

export function snapshot(state) {
  return JSON.stringify({
    phase: state.phase,
    current: state.current,
    turnSeq: state.turnSeq,
    loser: state.loser,
    pile: ids(state.pile),
    stock: ids(state.stock),
    burned: [...ids(state.burned)].sort(),
    players: state.seatOrder.map((s) => ({
      hand: ids(state.players[s].hand),
      faceUp: ids(state.players[s].faceUp),
      faceDown: ids(state.players[s].faceDown),
      out: state.players[s].out,
      place: state.players[s].place,
    })),
  });
}

export function ids(cards) {
  return cards.map((c) => c.id);
}

export function findEvent(res, kind) {
  return res.events.find((e) => e.e === kind);
}

export function eventKinds(res) {
  return res.events.map((e) => e.e);
}

export function turnEvent(res) {
  return [...res.events].reverse().find((e) => e.e === 'turn');
}

export { legalActions, assertStateSane, assertDeckIntegrity };
