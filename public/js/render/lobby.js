// The waiting room: the code to share, who is here, and the host's controls.

import { LIMITS } from '/shared/protocol.js';

export function createLobby({ onStart, onSetMaxPlayers, onLeave }) {
  const el = document.createElement('section');
  el.className = 'screen lobby';
  el.innerHTML = `
    <div class="lobby-inner">
      <header class="lobby-head">
        <p class="field-label">Room code</p>
        <button class="room-code" id="lobby-code" title="Copy the join link">
          <span id="lobby-code-text">····</span>
          <span class="room-code-hint" id="lobby-copy-hint">tap to share</span>
        </button>
      </header>

      <ul class="seat-list" id="lobby-seats"></ul>

      <div class="lobby-controls">
        <div class="host-only" id="lobby-count-row">
          <span class="field-label">Room size</span>
          <div class="segmented" id="lobby-count" role="group" aria-label="Room size"></div>
        </div>
        <p class="hint" id="lobby-hint"></p>
        <button class="btn btn-primary" id="lobby-start">Start game</button>
        <button class="btn btn-quiet" id="lobby-leave">Leave room</button>
      </div>

      <section class="scoreboard" id="lobby-scores" hidden>
        <h2 class="field-label">This session</h2>
        <table>
          <thead><tr><th>Player</th><th>Games</th><th>Wins</th><th>Losses</th></tr></thead>
          <tbody id="lobby-score-rows"></tbody>
        </table>
      </section>
    </div>
  `;

  const codeButton = el.querySelector('#lobby-code');
  const codeText = el.querySelector('#lobby-code-text');
  const copyHint = el.querySelector('#lobby-copy-hint');
  const seatList = el.querySelector('#lobby-seats');
  const countRow = el.querySelector('#lobby-count-row');
  const countGroup = el.querySelector('#lobby-count');
  const startButton = el.querySelector('#lobby-start');
  const hint = el.querySelector('#lobby-hint');
  const scores = el.querySelector('#lobby-scores');
  const scoreRows = el.querySelector('#lobby-score-rows');

  for (let n = LIMITS.MIN_PLAYERS; n <= LIMITS.MAX_PLAYERS; n++) {
    const button = document.createElement('button');
    button.className = 'seg';
    button.textContent = String(n);
    button.dataset.count = String(n);
    button.addEventListener('click', () => onSetMaxPlayers(n));
    countGroup.append(button);
  }

  startButton.addEventListener('click', onStart);
  el.querySelector('#lobby-leave').addEventListener('click', onLeave);

  codeButton.addEventListener('click', () => share(codeText.textContent, copyHint));

  // Keyed by seatId so a re-render reuses the row — otherwise every frame from
  // the server would restart the connection-dot transition on every player.
  const rows = new Map();

  return {
    el,

    update(state) {
      const room = state.room;
      if (!room || !room.code) return;
      const youAreHost = room.hostSeatId === state.welcome?.you;

      codeText.textContent = room.code;

      // ---- seats
      const seen = new Set();
      for (const seat of room.seats) {
        seen.add(seat.seatId);
        let row = rows.get(seat.seatId);
        if (!row) {
          row = buildSeatRow();
          rows.set(seat.seatId, row);
        }
        row.name.textContent = seat.name;
        row.dot.classList.toggle('is-away', !seat.connected);
        row.crown.hidden = !seat.isHost;
        row.you.hidden = seat.seatId !== state.welcome?.you;
        seatList.append(row.el); // append also reorders, which is what we want
      }
      for (const [seatId, row] of rows) {
        if (!seen.has(seatId)) {
          row.el.remove();
          rows.delete(seatId);
        }
      }

      // ---- empty seats, so the room visibly has room
      // Re-append every empty, not just the new ones: the loop above moved each
      // occupied row to the end of the list, so an empty left in place would
      // float above the players who just sat down.
      const empties = [...seatList.querySelectorAll('.seat-row.is-empty')];
      const wanted = Math.max(0, room.maxPlayers - room.seats.length);
      for (let i = 0; i < wanted; i++) seatList.append(empties[i] ?? buildEmptyRow());
      for (let i = wanted; i < empties.length; i++) empties[i].remove();

      // ---- host controls
      countRow.hidden = !youAreHost;
      for (const seg of countGroup.children) {
        const n = Number(seg.dataset.count);
        seg.setAttribute('aria-pressed', String(n === room.maxPlayers));
        // Shrinking below the number of people already seated is meaningless.
        seg.disabled = n < room.seats.length;
      }

      startButton.hidden = !youAreHost;
      startButton.disabled = !room.canStart;
      startButton.textContent = room.gamesStarted > 0 ? 'Start next game' : 'Start game';

      if (room.seats.length < LIMITS.MIN_PLAYERS) {
        hint.textContent = 'Share the code — you need at least 2 players.';
      } else if (youAreHost) {
        hint.textContent = `Ready when you are — ${room.seats.length} in.`;
      } else {
        const host = room.seats.find((s) => s.isHost);
        hint.textContent = `Waiting for ${host?.name ?? 'the host'} to start.`;
      }

      // ---- session scores, from the second game on
      const board = room.scoreboard ?? [];
      const played = board.some((r) => r.games > 0);
      scores.hidden = !played;
      if (played) {
        scoreRows.replaceChildren(...board.map((r) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td></td><td>${r.games}</td><td>${r.wins}</td><td>${r.losses}</td>`;
          tr.firstElementChild.textContent = r.name;
          return tr;
        }));
      }
    },
  };
}

function buildSeatRow() {
  const el = document.createElement('li');
  el.className = 'seat-row';
  el.innerHTML = `
    <span class="dot"></span>
    <span class="seat-name"></span>
    <span class="tag" hidden>host</span>
    <span class="tag tag-you" hidden>you</span>
  `;
  return {
    el,
    dot: el.querySelector('.dot'),
    name: el.querySelector('.seat-name'),
    crown: el.querySelectorAll('.tag')[0],
    you: el.querySelectorAll('.tag')[1],
  };
}

function buildEmptyRow() {
  const el = document.createElement('li');
  el.className = 'seat-row is-empty';
  el.innerHTML = '<span class="dot"></span><span class="seat-name">Empty seat</span>';
  return el;
}

/**
 * Share the join link, not the bare code: on a phone the share sheet puts it
 * into any messaging app, and the link prefills the code on arrival.
 */
async function share(code, hintEl) {
  const url = `${location.origin}/?r=${code}`;
  const flash = (text) => {
    hintEl.textContent = text;
    clearTimeout(share.timer);
    share.timer = setTimeout(() => { hintEl.textContent = 'tap to share'; }, 1800);
  };

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Shampoo', text: `Join my game: ${code}`, url });
      return;
    } catch {
      // Dismissed, or unavailable despite the feature check. Fall through.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    flash('link copied');
  } catch {
    flash(url);
  }
}
