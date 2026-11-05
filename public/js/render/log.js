// The log strip: one tappable line that expands to the last ten.
//
// This exists because on a phone an animation you looked away from is
// unrecoverable — you come back to a pile that is simply different, with no
// record of why. The strip is the record.
//
// It accumulates, because each frame carries only its own events. Nothing here
// is derived or inferred: every line is one server event, rendered.

import { SUIT_GLYPH } from '/shared/cards.js';

const KEEP = 10;

export function createLog() {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'log';
  el.setAttribute('aria-label', 'Game log');

  const lines = [];
  let lastGameId = null;

  el.addEventListener('click', () => el.classList.toggle('is-open'));

  function paint() {
    // Newest first: the collapsed strip shows only the first child, and an
    // open list that reads top-down newest-first matches it.
    el.replaceChildren(
      ...lines.map(({ text, mine }) => {
        const line = document.createElement('span');
        line.className = mine ? 'log-line is-you' : 'log-line';
        line.textContent = text;
        return line;
      }),
    );
    el.hidden = lines.length === 0;
  }

  return {
    el,

    update(view) {
      // A new game starts a new history — carrying the old one over would have
      // the strip explaining a board that has been dealt from scratch.
      if (view.gameId !== lastGameId) {
        lastGameId = view.gameId;
        lines.length = 0;
      }

      let added = false;
      for (const event of view.events ?? []) {
        const text = describe(event, view);
        if (!text) continue;
        lines.unshift({ text, mine: event.seat === view.you });
        added = true;
      }
      if (!added) return;

      lines.length = Math.min(lines.length, KEEP);
      paint();
    },
  };
}

// --------------------------------------------------------------------- text

const nameOf = (view, seat) =>
  seat === view.you ? 'You' : view.players.find((p) => p.seatId === seat)?.name ?? 'Someone';

const label = (card) => `${card.rank}${SUIT_GLYPH[card.suit]}`;

/** Past tense reads wrong for "You": "You played" not "You plays". */
const verb = (view, seat, you, them) => (seat === view.you ? you : them);

function describe(event, view) {
  const who = nameOf(view, event.seat);

  switch (event.e) {
    case 'gameStart':
      return `${nameOf(view, event.startingSeat)} ${
        event.startingSeat === view.you ? 'start' : 'starts'
      } — lowest card`;

    case 'played':
      return `${who} played ${event.cards.map(label).join(' ')}`;

    case 'burned':
      return event.reason === 'fourOfAKind'
        ? `${who} bombed the pile — ${event.count} gone`
        : `${who} burned the pile — ${event.count} gone`;

    case 'pickedUp':
      return `${who} picked up ${event.count}`;

    case 'flipped':
      return `${who} flipped ${label(event.card)}`;

    case 'flipFail':
      return `${label(event.card)} was too low — ${who} ${verb(
        view, event.seat, 'take', 'takes',
      )} ${event.taken}`;

    case 'playerOut':
      return `${who} ${verb(view, event.seat, 'are', 'is')} out — ${ordinal(event.place)}`;

    case 'forfeit':
      return `${who} forfeited`;

    case 'gameOver':
      return `${nameOf(view, event.loser)} ${
        event.loser === view.you ? 'lose' : 'loses'
      }`;

    // `drew`, `turn`, `flipSuccess` and `dealt` are either
    // already visible on the board or pure noise in a one-line strip.
    default:
      return null;
  }
}

function ordinal(place) {
  if (!place) return 'out';
  const teen = place % 100 >= 11 && place % 100 <= 13;
  const suffix = ['th', 'st', 'nd', 'rd'][teen || place % 10 > 3 ? 0 : place % 10];
  return `${place}${suffix}`;
}
