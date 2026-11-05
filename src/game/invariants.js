// Development/test assertions. Cheap enough to run after every action in tests;
// the server runs them too, behind a flag, so a desync surfaces immediately.

import { makeDeck, BURN_RANK } from '../shared/cards.js';
import { topOf, activeZone } from '../shared/rules.js';

const DECK_IDS = makeDeck().map((c) => c.id).sort();

export class InvariantError extends Error {}

function fail(msg) {
  throw new InvariantError(msg);
}

/** Every one of the 52 cards is in exactly one place. */
export function assertDeckIntegrity(state) {
  const seen = [];
  for (const seat of state.seatOrder) {
    const p = state.players[seat];
    seen.push(...p.hand, ...p.faceUp, ...p.faceDown);
  }
  seen.push(...state.stock, ...state.pile, ...state.burned);

  const ids = seen.map((c) => c.id).sort();
  if (ids.length !== 52) fail(`expected 52 cards, found ${ids.length}`);

  const dupes = ids.filter((id, i) => id === ids[i + 1]);
  if (dupes.length) fail(`duplicate cards: ${[...new Set(dupes)].join(', ')}`);

  for (let i = 0; i < 52; i++) {
    if (ids[i] !== DECK_IDS[i]) fail(`card set mismatch at ${i}: ${ids[i]} vs ${DECK_IDS[i]}`);
  }
}

/** Structural truths that must hold between actions. */
export function assertStateSane(state) {
  assertDeckIntegrity(state);

  const top = topOf(state.pile);
  if (top && top.rank === BURN_RANK) {
    fail('a 10 is sitting on the pile — it should always have burned on landing');
  }

  for (const seat of state.seatOrder) {
    const p = state.players[seat];

    // Draw-up guarantees this: you can only be empty-handed once the stock is dry.
    if (state.phase === 'playing' && p.hand.length === 0 && state.stock.length > 0 && !p.out) {
      fail(`seat ${seat} has an empty hand while ${state.stock.length} cards remain in stock`);
    }
    // Face-up cards sit on face-down cards, never the reverse.
    if (p.faceDown.length > p.faceUp.length && p.faceUp.length > 0 && p.hand.length === 0) {
      // allowed: face-up can be consumed independently. No assertion.
    }
    if (p.out && activeZone(p) !== null) {
      fail(`seat ${seat} is marked out but still holds cards`);
    }
    if (!p.out && state.phase === 'gameover' && seat !== state.loser) {
      fail(`seat ${seat} is neither out nor the loser at game over`);
    }
  }

  if (state.phase === 'playing') {
    const cur = state.players[state.current];
    if (!cur) fail(`current seat ${state.current} does not exist`);
    if (cur.out) fail(`current seat ${state.current} is already out`);
  }
}
