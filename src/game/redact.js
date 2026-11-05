// The only function allowed to serialize game state for the wire.
//
// Funnelling every byte through one place is what makes the hidden-information
// guarantee testable: test/redact.test.js stringifies the output and searches
// for card ids that must never appear.
//
// Three deliberate redactions:
//   1. Face-down cards are never sent — not even to their owner. If the client
//      never has the bytes, no DevTools poke and no screen-share can leak them.
//      The reveal happens here, server-side, as a `flipped` event.
//   2. Opponent hands are counts only.
//   3. The pile sends its top card and total count, nothing underneath.
//
// `bombCardIds` is the payoff of doing this server-side: the client learns which
// of *its own* cards would complete a four-of-a-kind without ever learning the
// pile's composition.

import { topOf, activeZone, playableCards, bombCards } from '../shared/rules.js';

const cloneCard = (c) => ({ id: c.id, rank: c.rank, suit: c.suit });
const cloneCards = (cards) => cards.map(cloneCard);

/**
 * Build the view one seat is allowed to see.
 *
 * @param state   authoritative game state
 * @param seatId  the viewer's seat, or null for a spectator-grade view
 * @param meta    room-level decoration: { seats, scores, events }
 *                seats: { [seatId]: { name, connected, isHost, playAgainReady } }
 */
export function viewFor(state, seatId, { seats = {}, scores = {}, events = [] } = {}) {
  const you = state.players[seatId] ? seatId : null;
  const top = topOf(state.pile);

  const players = state.seatOrder.map((seat) => {
    const p = state.players[seat];
    const info = seats[seat] ?? {};
    const view = {
      seatId: seat,
      name: info.name ?? `Seat ${seat}`,
      connected: info.connected !== false,
      isHost: info.isHost === true,
      out: p.out,
      place: p.place,
      forfeited: p.forfeited,
      handCount: p.hand.length,
      // Room-level, not game-level, but it has to ride on this frame: once a
      // game exists the server only broadcasts `state`, so the postgame screen
      // would have no other way to show "3 of 4 ready".
      playAgainReady: info.playAgainReady === true,
      // Face-up cards are public by the rules.
      faceUp: cloneCards(p.faceUp),
      // Contents never, for anyone — only how many are left to flip.
      faceDownCount: p.faceDown.length,
      zone: activeZone(p),
    };
    // Your own hand, and nobody else's. The absence of the key is the test.
    if (seat === you) view.hand = cloneCards(p.hand);
    return view;
  });

  const view = {
    t: 'state',
    gameId: state.gameId,
    phase: state.phase,
    you,
    current: state.current,
    turnSeq: state.turnSeq,
    startingSeat: state.startingSeat,
    startReason: state.startReason,
    loser: state.loser,
    finishedOrder: [...state.finishedOrder],
    pile: { count: state.pile.length, top: top ? cloneCard(top) : null },
    stock: { count: state.stock.length },
    burnedCount: state.burned.length,
    players,
    scores: { ...scores },
    events: events.map((e) => ({ ...e })),
  };

  if (you !== null) view.me = meFor(state, you, top);
  return view;
}

function meFor(state, seat, top) {
  const player = state.players[seat];
  const zone = activeZone(player);
  const yourTurn = state.phase === 'playing' && state.current === seat && !player.out;
  const open = zone === 'hand' || zone === 'faceUp' ? player[zone] : [];

  return {
    zone,
    yourTurn,
    // Legality is computed here so the client can never disagree with the server.
    playableCardIds: playableCards(open, top).map((c) => c.id),
    // The private bomb hint. Derived from the pile's run length, which is not
    // itself transmitted.
    bombCardIds: bombCards(open, state.pile).map((c) => c.id),
    canPickUp: yourTurn && state.pile.length > 0,
    mustFlip: yourTurn && zone === 'faceDown',
    faceDownCount: player.faceDown.length,
  };
}

/** The lobby/postgame view: seats and scores, never any card data. */
export function roomView(room) {
  return {
    t: 'room',
    code: room.code,
    maxPlayers: room.maxPlayers,
    hostSeatId: room.hostSeatId,
    phase: room.phase,
    seats: room.seats.map((s) => ({
      seatId: s.seatId,
      name: s.name,
      connected: s.connected,
      isHost: s.seatId === room.hostSeatId,
      playAgainReady: s.playAgainReady === true,
    })),
    scores: { ...room.scores },
  };
}
