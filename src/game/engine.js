// The authoritative Shampoo engine.
//
// Pure and server-only: no sockets, no clock, no Math.random(). Randomness
// arrives as a seed, which is what makes the fuzz test reproducible.
//
// applyAction() validates completely before mutating, so a rejected action can
// never leave the state half-changed.

import { makeDeck, POWER } from '../shared/cards.js';
import {
  canPlayOn, sameRank, topOf, burnReason, extraTurnReason,
  activeZone, isOut, compareStartingHands, HAND_SIZE, MAX_PLAY,
} from '../shared/rules.js';
import { mulberry32, shuffle } from './rng.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
const LOG_LIMIT = 30;

export const ERR = {
  WRONG_PHASE: 'ERR_WRONG_PHASE',
  NOT_YOUR_TURN: 'ERR_NOT_YOUR_TURN',
  STALE: 'ERR_STALE',
  PLAYER_OUT: 'ERR_PLAYER_OUT',
  NO_SEAT: 'ERR_NO_SEAT',
  MUST_FLIP: 'ERR_MUST_FLIP',
  NOT_FLIP_TIME: 'ERR_NOT_FLIP_TIME',
  NO_CARDS: 'ERR_NO_CARDS',
  TOO_MANY_CARDS: 'ERR_TOO_MANY_CARDS',
  DUPLICATE_CARDS: 'ERR_DUPLICATE_CARDS',
  CARD_NOT_IN_ZONE: 'ERR_CARD_NOT_IN_ZONE',
  MIXED_RANKS: 'ERR_MIXED_RANKS',
  TOO_LOW: 'ERR_TOO_LOW',
  EMPTY_PILE: 'ERR_EMPTY_PILE',
  BAD_INDEX: 'ERR_BAD_INDEX',
};

const ok = (events) => ({ ok: true, events });
const err = (code, detail) => ({ ok: false, error: code, detail, events: [] });

// ---------------------------------------------------------------- setup

export function createGame({ seatOrder, seed, gameId = 1 }) {
  if (seatOrder.length < MIN_PLAYERS || seatOrder.length > MAX_PLAYERS) {
    throw new Error(`need ${MIN_PLAYERS}-${MAX_PLAYERS} players, got ${seatOrder.length}`);
  }

  const rng = mulberry32(seed);
  const deck = shuffle(makeDeck(), rng);
  let i = 0;

  const players = {};
  for (const seat of seatOrder) {
    players[seat] = {
      seatId: seat,
      hand: [],
      faceUp: [],
      faceDown: [],
      out: false,
      place: null,
      forfeited: false,
    };
  }

  // Deal round-robin in three passes, matching how you'd deal it by hand.
  for (const key of ['faceDown', 'faceUp', 'hand']) {
    for (let n = 0; n < HAND_SIZE; n++) {
      for (const seat of seatOrder) players[seat][key].push(deck[i++]);
    }
  }

  const state = {
    gameId,
    seed,
    phase: 'playing',
    seatOrder: [...seatOrder],
    players,
    stock: deck.slice(i),
    pile: [],
    burned: [],
    current: seatOrder[0],
    turnSeq: 0,
    loser: null,
    finishedOrder: [],
    startingSeat: null,
    startReason: null,
    log: [],
  };

  // You play what you were dealt: the deal runs straight into the first turn.
  // beginPlay still logs its `gameStart`, so callers that want to announce the
  // starter read it back off `startingSeat` / `startReason`.
  beginPlay(state, []);
  return state;
}

// ---------------------------------------------------------------- helpers

function logEvent(state, event) {
  state.log.push(event);
  if (state.log.length > LOG_LIMIT) state.log.shift();
}

function emit(state, events, event) {
  events.push(event);
  logEvent(state, event);
  return event;
}

function activeSeats(state) {
  return state.seatOrder.filter((s) => !state.players[s].out);
}

function nextActiveSeat(state, from) {
  const order = state.seatOrder;
  const start = order.indexOf(from);
  for (let n = 1; n <= order.length; n++) {
    const seat = order[(start + n) % order.length];
    if (!state.players[seat].out) return seat;
  }
  return from;
}

function removeCards(zoneCards, cards) {
  for (const card of cards) {
    const idx = zoneCards.findIndex((c) => c.id === card.id);
    zoneCards.splice(idx, 1);
  }
}

function drawUp(state, player, events) {
  let n = 0;
  while (player.hand.length < HAND_SIZE && state.stock.length > 0) {
    player.hand.push(state.stock.pop());
    n++;
  }
  if (n > 0) emit(state, events, { e: 'drew', seat: player.seatId, count: n });
  return n;
}

function burnPile(state, seat, reason, events) {
  const count = state.pile.length;
  state.burned.push(...state.pile);
  state.pile = [];
  emit(state, events, { e: 'burned', seat, reason, count });
}

/**
 * Shared tail for every card-playing action.
 * The ordering here is the whole game — see the comments.
 */
function finishTurn(state, seat, { playedRank, events, allowExtra = true }) {
  const player = state.players[seat];

  // 1. Burn (the cards are already on the pile).
  const burned = playedRank === null ? null : burnReason(state.pile, playedRank);
  if (burned) burnPile(state, seat, burned, events);

  // 2. Extra turn: a 2 earns one *without* burning; a 10 or a bomb earns one with.
  let extra = allowExtra ? extraTurnReason(playedRank, burned) : null;

  // 3. Going out. Checked after the draw-up (a refill keeps you in) and after
  //    the burn (burning your last card still counts) — and it cancels the
  //    extra turn, otherwise we would hand a turn to a player with no cards.
  if (isOut(player) && !player.out) {
    player.out = true;
    state.finishedOrder.push(seat);
    player.place = state.finishedOrder.length;
    emit(state, events, { e: 'playerOut', seat, place: player.place });
    extra = null;
  }

  // 4. Game over: the last player still holding cards loses.
  const remaining = activeSeats(state);
  if (remaining.length <= 1) {
    state.phase = 'gameover';
    state.loser = remaining[0] ?? null;
    state.turnSeq++;
    emit(state, events, {
      e: 'gameOver',
      loser: state.loser,
      order: [...state.finishedOrder],
    });
    return;
  }

  // 5. Advance.
  if (!extra) state.current = nextActiveSeat(state, seat);
  state.turnSeq++;
  emit(state, events, { e: 'turn', seat: state.current, extra: !!extra, extraReason: extra });
}

/**
 * Decide who starts: the lowest card in hand, ties broken by the next-lowest,
 * then the next, then deterministically by the seed.
 */
function beginPlay(state, events) {
  const seats = state.seatOrder.filter((s) => !state.players[s].forfeited);
  const ranked = [...seats].sort((a, b) =>
    compareStartingHands(state.players[a].hand, state.players[b].hand),
  );

  const best = ranked[0];
  const tied = ranked.filter(
    (s) => compareStartingHands(state.players[s].hand, state.players[best].hand) === 0,
  );

  let starter = best;
  let reason = 'lowestCard';
  if (tied.length > 1) {
    // Hands are rank-identical; pick one from the seed so it stays reproducible.
    const rng = mulberry32(state.seed ^ 0x5bf03635);
    starter = tied[Math.floor(rng() * tied.length)];
    reason = 'randomTieBreak';
  }

  state.phase = 'playing';
  state.current = starter;
  state.startingSeat = starter;
  state.startReason = reason;
  state.turnSeq = 1;
  emit(state, events, { e: 'gameStart', startingSeat: starter, reason });
}

// ---------------------------------------------------------------- playing

function guardTurn(state, action) {
  if (state.phase !== 'playing') return err(ERR.WRONG_PHASE);
  const player = state.players[action.seat];
  if (!player) return err(ERR.NO_SEAT);
  // turnSeq is the double-tap / replay guard, and it is checked before seat
  // ownership on purpose: a client acting on an out-of-date board gets STALE
  // ("re-sync") rather than the misleading NOT_YOUR_TURN. Omitting it is
  // allowed for server-internal actions only; clients always send it.
  if (action.turnSeq !== undefined && action.turnSeq !== state.turnSeq) return err(ERR.STALE);
  if (player.out) return err(ERR.PLAYER_OUT);
  if (state.current !== action.seat) return err(ERR.NOT_YOUR_TURN);
  return null;
}

function handlePlay(state, action) {
  const bad = guardTurn(state, action);
  if (bad) return bad;

  const player = state.players[action.seat];
  const zone = activeZone(player);
  if (zone === 'faceDown') return err(ERR.MUST_FLIP);

  const ids = action.cardIds ?? [];
  if (ids.length === 0) return err(ERR.NO_CARDS);
  if (ids.length > MAX_PLAY) return err(ERR.TOO_MANY_CARDS);
  if (new Set(ids).size !== ids.length) return err(ERR.DUPLICATE_CARDS);

  // Resolve ids against our own state — never trust a client-supplied card.
  const zoneCards = player[zone];
  const cards = [];
  for (const id of ids) {
    const card = zoneCards.find((c) => c.id === id);
    if (!card) return err(ERR.CARD_NOT_IN_ZONE, id);
    cards.push(card);
  }

  if (!sameRank(cards)) return err(ERR.MIXED_RANKS);

  const rank = cards[0].rank;
  if (!canPlayOn(rank, topOf(state.pile))) return err(ERR.TOO_LOW);

  // ---- validation complete; mutate from here ----
  const events = [];
  removeCards(zoneCards, cards);
  state.pile.push(...cards);
  emit(state, events, { e: 'played', seat: action.seat, cards: cards.map((c) => ({ ...c })), zone });

  // Draw up *before* the extra-turn and out checks, so a 2 or a 10 refills your
  // hand before you make the follow-up play.
  if (zone === 'hand') drawUp(state, player, events);

  finishTurn(state, action.seat, { playedRank: rank, events });
  return ok(events);
}

function handlePickup(state, action) {
  const bad = guardTurn(state, action);
  if (bad) return bad;
  if (state.pile.length === 0) return err(ERR.EMPTY_PILE);

  const player = state.players[action.seat];
  const count = state.pile.length;

  const events = [];
  player.hand.push(...state.pile); // bottom-to-top order preserved
  state.pile = [];
  emit(state, events, { e: 'pickedUp', seat: action.seat, count });

  // No draw-up, no burn, and you cannot go out by picking up.
  state.current = nextActiveSeat(state, action.seat);
  state.turnSeq++;
  emit(state, events, { e: 'turn', seat: state.current, extra: false, extraReason: null });
  return ok(events);
}

function handleFlip(state, action) {
  const bad = guardTurn(state, action);
  if (bad) return bad;

  const player = state.players[action.seat];
  if (activeZone(player) !== 'faceDown') return err(ERR.NOT_FLIP_TIME);

  const index = action.index ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= player.faceDown.length) {
    return err(ERR.BAD_INDEX);
  }

  // ---- validation complete; mutate from here ----
  const events = [];
  const [card] = player.faceDown.splice(index, 1);
  const top = topOf(state.pile);
  emit(state, events, { e: 'flipped', seat: action.seat, card: { ...card }, index });

  if (canPlayOn(card.rank, top)) {
    state.pile.push(card);
    emit(state, events, { e: 'flipSuccess', seat: action.seat, card: { ...card } });
    // A flipped 2 or 10 earns another flip, exactly like a played one.
    finishTurn(state, action.seat, { playedRank: card.rank, events });
  } else {
    const taken = 1 + state.pile.length;
    player.hand.push(card, ...state.pile);
    state.pile = [];
    emit(state, events, { e: 'flipFail', seat: action.seat, card: { ...card }, taken });
    // No draw (the stock is empty by definition here) and they cannot be out,
    // since they just gained cards.
    state.current = nextActiveSeat(state, action.seat);
    state.turnSeq++;
    emit(state, events, { e: 'turn', seat: state.current, extra: false, extraReason: null });
  }

  return ok(events);
}

/**
 * Remove a seat from the game, sending their cards out of play.
 * Used when a disconnected player is given up on.
 */
function handleForfeit(state, action) {
  const player = state.players[action.seat];
  if (!player) return err(ERR.NO_SEAT);
  if (player.out) return err(ERR.PLAYER_OUT);
  if (state.phase === 'gameover') return err(ERR.WRONG_PHASE);

  const events = [];
  state.burned.push(...player.hand, ...player.faceUp, ...player.faceDown);
  player.hand = [];
  player.faceUp = [];
  player.faceDown = [];
  player.forfeited = true;
  player.out = true;
  state.finishedOrder.push(action.seat);
  player.place = state.finishedOrder.length;
  emit(state, events, { e: 'forfeit', seat: action.seat });

  const remaining = activeSeats(state);
  if (remaining.length <= 1) {
    state.phase = 'gameover';
    state.loser = remaining[0] ?? null;
    state.turnSeq++;
    emit(state, events, { e: 'gameOver', loser: state.loser, order: [...state.finishedOrder] });
    return ok(events);
  }

  if (state.current === action.seat) {
    state.current = nextActiveSeat(state, action.seat);
    state.turnSeq++;
    emit(state, events, { e: 'turn', seat: state.current, extra: false, extraReason: null });
  }
  return ok(events);
}

// ---------------------------------------------------------------- dispatch

const HANDLERS = {
  PLAY: handlePlay,
  PICKUP: handlePickup,
  FLIP: handleFlip,
  FORFEIT: handleForfeit,
};

export function applyAction(state, action) {
  const handler = HANDLERS[action.type];
  if (!handler) return err('ERR_UNKNOWN_ACTION', action.type);
  return handler(state, action);
}

// ---------------------------------------------------------------- queries

/** Legal actions for a seat — used by the test bot and for client hints. */
export function legalActions(state, seat) {
  if (state.phase !== 'playing' || state.current !== seat) return [];
  const player = state.players[seat];
  if (!player || player.out) return [];

  const actions = [];
  const zone = activeZone(player);
  const top = topOf(state.pile);

  if (zone === 'hand' || zone === 'faceUp') {
    const groups = new Map();
    for (const card of player[zone]) {
      if (!canPlayOn(card.rank, top)) continue;
      if (!groups.has(card.rank)) groups.set(card.rank, []);
      groups.get(card.rank).push(card);
    }
    for (const group of groups.values()) {
      for (let n = 1; n <= group.length; n++) {
        actions.push({
          type: 'PLAY',
          seat,
          cardIds: group.slice(0, n).map((c) => c.id),
          turnSeq: state.turnSeq,
        });
      }
    }
  } else if (zone === 'faceDown') {
    for (let i = 0; i < player.faceDown.length; i++) {
      actions.push({ type: 'FLIP', seat, index: i, turnSeq: state.turnSeq });
    }
  }

  if (state.pile.length > 0) {
    actions.push({ type: 'PICKUP', seat, turnSeq: state.turnSeq });
  }

  return actions;
}

export { activeSeats, nextActiveSeat, POWER };
