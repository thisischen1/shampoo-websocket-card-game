// The highest-value test in the project.
//
// A bot that knows only what a real player knows plays thousands of complete
// games, and after *every* action we re-assert every structural truth the
// engine promises. This is what catches the turn-ordering bugs that
// hand-written tests miss — infinite extra-turn loops, a turn handed to a
// player with no cards, a card escaping the deck, a 10 stranded on the pile.
//
// Seeds are explicit, so any failure prints a seed that reproduces it exactly.
//   FUZZ_SEEDS=5000 npm test   runs the full gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, legalActions } from '../src/game/engine.js';
import { assertStateSane } from '../src/game/invariants.js';
import { mulberry32 } from '../src/game/rng.js';
import { activeZone } from '../src/shared/rules.js';

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 400);

// Random play is slow play: taking the pile is always legal, so a uniform bot
// retrieves it constantly and games average ~700 actions with a tail into the
// low thousands. That is a property of the game, not a bug — Shampoo has no
// finite length bound if players keep picking up. The cap is set an order of
// magnitude above the observed tail so it only ever fires on a true loop.
const ACTION_CAP = 50_000;

const pickOne = (rng, list) => list[Math.floor(rng() * list.length)];

/**
 * Play one whole game with random-but-legal choices, asserting as we go.
 * Returns a summary so the caller can check the games aren't degenerate.
 */
function playGame(seed, playerCount) {
  const where = `seed ${seed}, ${playerCount}p`;
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const seatOrder = Array.from({ length: playerCount }, (_, i) => i);
  const state = createGame({ seatOrder, seed });

  // The deal runs straight into the first turn — there is nothing in between.
  assert.equal(state.phase, 'playing', `${where}: the deal did not start the game`);
  assert.ok(seatOrder.includes(state.startingSeat), `${where}: bogus starting seat`);
  assertStateSane(state);

  // ---- play
  let actions = 0;
  let lastSeq = state.turnSeq;
  let burnedCount = state.burned.length;

  while (state.phase === 'playing') {
    assert.ok(actions < ACTION_CAP, `${where}: did not terminate within ${ACTION_CAP} actions`);

    const seat = state.current;
    const options = legalActions(state, seat);
    assert.ok(options.length > 0, `${where}: seat ${seat} has no legal action at all`);

    const action = pickOne(rng, options);
    const res = applyAction(state, action);
    assert.ok(res.ok, `${where}: legal action ${action.type} was rejected (${res.error})`);
    actions++;

    // Structural truths, re-checked after every single action.
    assertStateSane(state);
    assert.ok(state.turnSeq > lastSeq, `${where}: turnSeq went ${lastSeq} -> ${state.turnSeq}`);
    lastSeq = state.turnSeq;
    assert.ok(state.burned.length >= burnedCount, `${where}: burned cards came back into play`);
    burnedCount = state.burned.length;

    if (state.phase === 'playing') {
      assert.equal(state.players[state.current].out, false, `${where}: turn given to an out player`);
      assert.ok(activeZone(state.players[state.current]) !== null, `${where}: current seat has no cards`);
    }
  }

  // ---- the game ended cleanly
  assert.equal(state.phase, 'gameover', where);
  assert.ok(seatOrder.includes(state.loser), `${where}: no single loser`);
  assert.equal(state.players[state.loser].out, false, `${where}: the loser must still hold cards`);
  assert.ok(activeZone(state.players[state.loser]) !== null, `${where}: the loser holds nothing`);

  assert.equal(state.finishedOrder.length, playerCount - 1, `${where}: wrong number finished`);
  assert.equal(new Set(state.finishedOrder).size, playerCount - 1, `${where}: duplicate placement`);
  state.finishedOrder.forEach((s, i) => {
    assert.equal(state.players[s].place, i + 1, `${where}: seat ${s} placed wrong`);
    assert.equal(state.players[s].out, true, `${where}: seat ${s} finished but is not out`);
  });
  assert.ok(!state.finishedOrder.includes(state.loser), `${where}: the loser is in finishedOrder`);

  return { actions, burned: state.burned.length };
}

for (const playerCount of [2, 3, 4, 5]) {
  test(`${playerCount} players: ${SEEDS} random games all terminate cleanly`, () => {
    let totalActions = 0;
    let longest = 0;

    for (let seed = 1; seed <= SEEDS; seed++) {
      const { actions } = playGame(seed, playerCount);
      totalActions += actions;
      longest = Math.max(longest, actions);
    }

    // Guard against the test silently degenerating into "the game ends in four
    // moves" — the games have to actually be substantial to be worth anything.
    const mean = totalActions / SEEDS;
    assert.ok(mean > 50, `games are suspiciously short (mean ${mean.toFixed(1)} actions)`);
  });
}

test('a seed replays identically, so any failure is reproducible', () => {
  assert.deepEqual(playGame(12345, 4), playGame(12345, 4));
});
