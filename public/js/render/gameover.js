// The postgame screen: who placed where, the session scoreboard, and the way
// back into another game.
//
// It reads the `state` frame rather than the `room` frame, because once a game
// exists the server only broadcasts `state` — the finished game is still there,
// with its placements intact, until the host drops it.

import { createSplash } from './splash.js';

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];

export function createGameOver({ onPlayAgain, onReady, onBackToLobby, onLeave }) {
  const el = document.createElement('section');
  el.className = 'screen over';
  el.innerHTML = `
    <div class="over-inner">
      <header class="over-head">
        <p class="field-label" id="over-kicker">Game over</p>
        <h1 class="over-title" id="over-title"></h1>
      </header>

      <ol class="placements" id="over-places"></ol>

      <section class="scoreboard" id="over-scores">
        <h2 class="field-label">This session</h2>
        <table>
          <thead><tr><th>Player</th><th>Games</th><th>Wins</th><th>Losses</th></tr></thead>
          <tbody id="over-score-rows"></tbody>
        </table>
      </section>

      <div class="over-controls">
        <p class="hint" id="over-hint"></p>
        <button class="btn btn-primary" id="over-again">Play again</button>
        <button class="btn" id="over-ready">I'm ready</button>
        <button class="btn btn-quiet" id="over-lobby">Back to lobby</button>
        <button class="btn btn-quiet" id="over-leave">Leave room</button>
      </div>
    </div>
  `;

  const title = el.querySelector('#over-title');
  const kicker = el.querySelector('#over-kicker');
  const places = el.querySelector('#over-places');
  const scoreRows = el.querySelector('#over-score-rows');
  const hint = el.querySelector('#over-hint');
  const again = el.querySelector('#over-again');
  const ready = el.querySelector('#over-ready');
  const lobby = el.querySelector('#over-lobby');

  const splash = createSplash();
  document.body.append(splash.el);

  again.addEventListener('click', onPlayAgain);
  lobby.addEventListener('click', onBackToLobby);
  el.querySelector('#over-leave').addEventListener('click', onLeave);
  ready.addEventListener('click', () => onReady(!amReady));

  let amReady = false;
  // The splash fires once per finished game. Keyed on gameId rather than a
  // boolean so a rematch gets its own splash, and so the reconnect snapshot of
  // an already-finished game does not replay it.
  let splashed = null;

  return {
    el,

    update(state) {
      const view = state.view;
      if (!view || view.phase !== 'gameover') return;

      const you = view.you;
      const bySeat = new Map(view.players.map((p) => [p.seatId, p]));
      const youLost = view.loser === you;
      const loser = bySeat.get(view.loser);

      // ---- headline
      title.textContent = youLost
        ? 'You lose'
        : `${loser?.name ?? 'Nobody'} loses`;
      title.classList.toggle('is-lose', youLost);
      kicker.textContent = youLost ? 'Last one holding cards' : 'Game over';

      // ---- placements: everyone who went out, in order, then the loser last
      const order = [...view.finishedOrder, ...(view.loser !== null ? [view.loser] : [])];
      places.replaceChildren(...order.map((seatId, i) => {
        const player = bySeat.get(seatId);
        const last = seatId === view.loser;
        const li = document.createElement('li');
        li.className = 'place-row';
        li.classList.toggle('is-last', last);
        li.classList.toggle('is-you', seatId === you);
        li.innerHTML = `
          <span class="place-rank"></span>
          <span class="place-name"></span>
          <span class="tag tag-you" hidden>you</span>
          <span class="place-note"></span>
        `;
        li.querySelector('.place-rank').textContent = last ? 'Last' : ORDINALS[i] ?? `${i + 1}th`;
        li.querySelector('.place-name').textContent = player?.name ?? `Seat ${seatId}`;
        li.querySelector('.tag-you').hidden = seatId !== you;
        li.querySelector('.place-note').textContent = player?.forfeited ? 'left' : '';
        return li;
      }));

      // ---- session scoreboard
      // Sorted here, not taken as given: `scores` arrives as an object keyed by
      // seat, and JS iterates integer-like keys in numeric order, which throws
      // away whatever order the server put them in.
      const board = Object.values(view.scores ?? {}).sort(
        (a, b) => a.losses - b.losses || b.games - a.games || a.seatId - b.seatId,
      );
      scoreRows.replaceChildren(...board.map((row) => {
        const tr = document.createElement('tr');
        tr.classList.toggle('is-you', row.seatId === you);
        tr.innerHTML = `<td></td><td>${row.games}</td><td>${row.wins}</td><td>${row.losses}</td>`;
        tr.firstElementChild.textContent = row.name;
        return tr;
      }));

      // ---- controls
      const me = bySeat.get(you);
      const youAreHost = me?.isHost === true;
      amReady = me?.playAgainReady === true;

      const waiting = view.players.filter((p) => p.connected);
      const readyCount = waiting.filter((p) => p.playAgainReady).length;

      again.hidden = !youAreHost;
      lobby.hidden = !youAreHost;
      ready.hidden = youAreHost;
      ready.textContent = amReady ? "Ready — waiting" : "I'm ready";
      ready.classList.toggle('btn-primary', !amReady);

      if (youAreHost) {
        hint.textContent = `${readyCount} of ${waiting.length} ready for another game.`;
      } else {
        const host = view.players.find((p) => p.isHost);
        hint.textContent = `Waiting for ${host?.name ?? 'the host'} to deal again.`;
      }

      // ---- the splash, last: everything above is already on screen beneath it
      if (splashed !== view.gameId) {
        splashed = view.gameId;
        splash.play(youLost ? 'lose' : 'win', splashText(view, bySeat, youLost));
      }
    },
  };
}

function splashText(view, bySeat, youLost) {
  if (youLost) {
    return {
      kicker: 'Everyone else got out',
      title: 'YOU LOSE',
      sub: 'Left holding the cards.',
    };
  }
  const place = bySeat.get(view.you)?.place;
  const first = place === 1;
  return {
    kicker: place ? `${ORDINALS[place - 1] ?? `${place}th`} out` : 'Safe',
    title: first ? 'YOU WIN' : "YOU'RE SAFE",
    sub: first ? 'First one out — cleanest hands at the table.' : 'Out and safe.',
  };
}
