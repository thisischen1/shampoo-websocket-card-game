// The card table: opponents, the pile, your cards, and the action bar.
//
// Everything this screen draws comes from the redacted view. It never infers
// what an opponent holds, never tracks the pile's contents, and never decides
// legality for itself — `me.playableCardIds` is the single source of truth.

import { cardEl, backEl, syncRow } from './card.js';
import { createSelection } from '../selection.js';
import { createLog } from './log.js';
import { createFx, rectOf, landingIn, buzz } from '../fx.js';

const MAX_PLAY = 4;

// An opponent's fan is a volume cue, not a tally — the count beside their name
// is the truth. Past a dozen backs the fan stops meaning anything and starts
// smearing the pod across the screen, so it is capped rather than scaled.
const MAX_FAN = 12;

// How far apart the faces of a multi-card play sit on the pile: a fraction of
// a card width, and degrees. Enough to count them at a glance, not enough to
// hide the top card. In card-widths rather than pixels so the fan keeps its
// proportions from a 58px phone pile up to a 104px desktop one.
const FAN_SHIFT = 0.18;
const FAN_TILT = 7;

export function createTable({ onPlay, onPickUp, onFlip, onPickUpFor, onForfeit }) {
  const el = document.createElement('section');
  el.className = 'screen table';
  el.innerHTML = `
    <div class="table-grid">
      <div class="pods" id="table-pods"></div>

      <div class="table-centre">
        <div class="slot slot-stock">
          <div class="stack" id="table-stock"></div>
          <span class="slot-label" id="table-stock-label">stock</span>
        </div>

        <div class="slot slot-pile">
          <div class="stack" id="table-pile"></div>
          <span class="slot-label" id="table-pile-label">0</span>
        </div>

        <div class="slot slot-burn">
          <div class="stack is-burn" id="table-burn"></div>
          <span class="slot-label" id="table-burn-label">burned</span>
        </div>
      </div>

      <div class="you">
        <p class="turn-banner" id="table-turn" aria-live="polite"></p>
        <div class="your-table">
          <div class="card-row" id="table-facedown"></div>
          <div class="card-row" id="table-faceup"></div>
        </div>
        <div class="card-row hand" id="table-hand"></div>
      </div>

      <div class="rescue" id="table-rescue" hidden>
        <p class="rescue-text" id="table-rescue-text"></p>
        <div class="rescue-row">
          <button class="btn btn-small" id="table-rescue-pickup">Pick up for them</button>
          <button class="btn btn-small btn-danger" id="table-rescue-forfeit">Remove them</button>
        </div>
      </div>

      <div class="action-bar">
        <button class="btn" id="table-pickup">Pick up</button>
        <button class="btn btn-primary" id="table-play">Play</button>
      </div>
    </div>
  `;

  const log = createLog();
  el.querySelector('.pods').after(log.el);

  const podWrap = el.querySelector('#table-pods');
  const stockStack = el.querySelector('#table-stock');
  const stockLabel = el.querySelector('#table-stock-label');
  const pileStack = el.querySelector('#table-pile');
  const pileLabel = el.querySelector('#table-pile-label');
  const burnStack = el.querySelector('#table-burn');
  const burnLabel = el.querySelector('#table-burn-label');
  const turnBanner = el.querySelector('#table-turn');
  const faceDownRow = el.querySelector('#table-facedown');
  const faceUpRow = el.querySelector('#table-faceup');
  const handRow = el.querySelector('#table-hand');
  const pickUpButton = el.querySelector('#table-pickup');
  const playButton = el.querySelector('#table-play');
  const rescue = el.querySelector('#table-rescue');
  const rescueText = el.querySelector('#table-rescue-text');
  const rescuePickUp = el.querySelector('#table-rescue-pickup');
  const rescueForfeit = el.querySelector('#table-rescue-forfeit');

  const selection = createSelection();
  const fx = createFx();
  const pods = new Map();
  let view = null;

  // The faces the pile is currently showing. The redacted view only carries the
  // top card, so a multi-card play would otherwise collapse to a single face;
  // the `played` event is where the other faces come from, and they are public
  // from the moment they land.
  let pileFaces = [];

  playButton.addEventListener('click', () => {
    if (selection.size === 0) return;
    onPlay(selection.ids, view.turnSeq);
    selection.clear();
  });

  pickUpButton.addEventListener('click', () => {
    selection.clear();
    onPickUp(view.turnSeq);
  });

  rescuePickUp.addEventListener('click', () => {
    if (view?.stuckSeat !== null) onPickUpFor(view.stuckSeat, view.turnSeq);
  });

  rescueForfeit.addEventListener('click', () => {
    if (view?.stuckSeat !== null) onForfeit(view.stuckSeat);
  });

  /** The cards you may actually touch right now, per the rules' zone lock. */
  const openCards = () => {
    if (!view) return [];
    const me = view.players.find((p) => p.seatId === view.you);
    if (!me) return [];
    return view.me.zone === 'hand' ? me.hand ?? [] : view.me.zone === 'faceUp' ? me.faceUp : [];
  };

  function tapCard(card) {
    if (!view?.me.yourTurn) return;
    if (!view.me.playableCardIds.includes(card.id)) {
      shake(el.querySelector(`[data-card-id="${card.id}"]`));
      return;
    }
    selection.toggle(card, { max: MAX_PLAY });
    paint();
  }

  // --------------------------------------------------------------- painting

  function paintPods() {
    const others = view.players.filter((p) => p.seatId !== view.you);
    const seen = new Set();
    for (const player of others) {
      seen.add(player.seatId);
      let pod = pods.get(player.seatId);
      if (!pod) {
        pod = buildPod();
        pods.set(player.seatId, pod);
      }
      pod.name.textContent = player.name;
      pod.el.classList.toggle('is-turn', view.current === player.seatId && view.phase === 'playing');
      pod.el.classList.toggle('is-away', !player.connected);
      pod.el.classList.toggle('is-out', player.out);

      // Opponent hands are a count and a fan of backs — never identities.
      pod.count.textContent = player.handCount;
      syncCount(pod.hand, Math.min(player.handCount, MAX_FAN), () => backEl());
      syncCount(pod.down, player.faceDownCount, () => backEl());
      syncRow(pod.up, player.faceUp, (card) => cardEl(card));

      pod.status.textContent = player.out
        ? `out — ${ordinal(player.place)}`
        : player.connected ? '' : 'away';

      podWrap.append(pod.el);
    }
    for (const [seatId, pod] of pods) {
      if (!seen.has(seatId)) {
        pod.el.remove();
        pods.delete(seatId);
      }
    }
  }

  function paintCentre() {
    syncCount(stockStack, Math.min(view.stock.count, 6), () => backEl());
    stockStack.classList.toggle('is-empty', view.stock.count === 0);
    stockLabel.textContent = view.stock.count === 0 ? 'no more draws' : `stock ${view.stock.count}`;

    // The pile shows the last play's faces over a suggestion of depth. The
    // cards beneath are backs because the client is never told what they are.
    const depth = Math.min(Math.max(view.pile.count - pileFaces.length, 0), 4);
    pileStack.replaceChildren();
    for (let i = 0; i < depth; i++) {
      const back = backEl();
      back.className = 'card is-back pile-under';
      // Deterministic jitter, seeded off the index, so a re-render never shuffles.
      back.style.rotate = `${((i * 37) % 11) - 5}deg`;
      pileStack.append(back);
    }
    // Several cards of a rank land as several faces, fanned — never a "×2".
    pileFaces.forEach((card, i) => {
      const node = cardEl(card);
      const spread = fanSpread(i, pileFaces.length);
      node.style.translate = `calc(var(--card-w) * ${spread * FAN_SHIFT})`;
      node.style.rotate = `${spread * FAN_TILT}deg`;
      pileStack.append(node);
    });
    pileStack.classList.toggle('is-empty', view.pile.count === 0);
    pileLabel.textContent = String(view.pile.count);

    // The burn pile is a dim ghost stack with a count. No card detail, ever.
    syncCount(burnStack, Math.min(view.burnedCount, 5), () => backEl());
    burnLabel.textContent = `burned ${view.burnedCount}`;
  }

  function paintYou() {
    const me = view.players.find((p) => p.seatId === view.you);
    if (!me) return;
    const { zone, playableCardIds, bombCardIds, mustFlip, yourTurn } = view.me;

    // Face-down: tappable only when they are all that is left.
    syncCount(faceDownRow, me.faceDownCount, () => {
      const node = backEl({ selectable: true, label: 'Flip a face-down card' });
      node.addEventListener('click', () => {
        const index = [...faceDownRow.children].indexOf(node);
        if (view.me.mustFlip) onFlip(index, view.turnSeq);
      });
      return node;
    });
    for (const node of faceDownRow.children) {
      node.classList.toggle('is-flippable', mustFlip);
      node.disabled = !mustFlip;
    }

    paintRow(faceUpRow, me.faceUp, 'faceUp');
    paintRow(handRow, me.hand ?? [], 'hand');
    handRow.classList.toggle('is-wide', (me.hand?.length ?? 0) > 7);

    function paintRow(row, cards, rowZone) {
      const nodes = syncRow(row, cards, (card) => {
        const node = cardEl(card, { selectable: true });
        node.addEventListener('click', () => tapCard(card));
        return node;
      });
      nodes.forEach((node, i) => {
        const card = cards[i];
        const active = rowZone === zone;
        const playable = active && yourTurn && playableCardIds.includes(card.id);
        node.classList.toggle('is-selected', selection.has(card.id));
        // Locked: either the wrong zone entirely, or too low to play.
        node.classList.toggle('is-locked', !active || (yourTurn && !playable));
        // Muted: legal, but a different rank is already selected.
        node.classList.toggle(
          'is-muted',
          selection.size > 0 && selection.rank !== card.rank && playable,
        );
        node.classList.toggle('is-bomb', bombCardIds.includes(card.id));
        node.disabled = !active;
      });
    }
  }

  function paintActions() {
    const { yourTurn, canPickUp, mustFlip } = view.me;
    const currentName = view.players.find((p) => p.seatId === view.current)?.name ?? 'someone';

    turnBanner.textContent = view.phase !== 'playing'
      ? ''
      : yourTurn
        ? mustFlip ? 'Your turn — flip a card' : 'Your turn'
        : `${currentName}'s turn`;
    turnBanner.classList.toggle('is-you', yourTurn);
    el.classList.toggle('is-your-turn', yourTurn);

    playButton.hidden = mustFlip;
    playButton.disabled = !yourTurn || selection.size === 0;
    playButton.textContent = selection.size > 1
      ? `Play ${selection.size} × ${selection.rank}`
      : 'Play';

    pickUpButton.disabled = !canPickUp;
    pickUpButton.textContent = view.pile.count > 0 ? `Pick up (${view.pile.count})` : 'Pick up';

    if (!yourTurn) {
      playButton.disabled = true;
      pickUpButton.disabled = true;
    }

    paintRescue();
  }

  /**
   * The host's two knowledge-free ways out of a stalled turn. Shown only once
   * the server says the seat is stuck, because the server owns that clock — the
   * client has no idea how long the turn has been sitting there.
   *
   * Taking the pile needs an unempty pile; on an empty one the only move left
   * requires seeing their cards, so removing the seat is all that is offered.
   */
  function paintRescue() {
    const stuck = view.stuckSeat ?? null;
    const iAmHost = view.hostSeatId === view.you;
    rescue.hidden = stuck === null || !iAmHost;
    if (rescue.hidden) return;

    const name = view.players.find((p) => p.seatId === stuck)?.name ?? 'That player';
    rescueText.textContent = `${name} has dropped out mid-turn.`;
    rescuePickUp.hidden = view.pile.count === 0;
    rescuePickUp.textContent = `Pick up (${view.pile.count}) for ${name}`;
    rescueForfeit.textContent = `Remove ${name}`;
  }

  function paint() {
    if (!view) return;
    paintPods();
    paintCentre();
    paintYou();
    paintActions();
  }

  /**
   * Decide which faces the pile shows, from this frame's events.
   *
   * The authoritative top card is the arbiter: if the faces we were holding no
   * longer end at it, they are stale and get dropped. That is what makes a
   * reconnect mid-pile heal itself on the very next frame instead of needing
   * burns and pick-ups to be tracked and undone by hand.
   */
  function adoptPileFaces() {
    const played = (view.events ?? []).filter((e) => e.e === 'played').at(-1);
    if (played) pileFaces = played.cards;

    const top = view.pile.top;
    if (!top || pileFaces.at(-1)?.id !== top.id) pileFaces = top ? [top] : [];
    if (pileFaces.length > view.pile.count) pileFaces = pileFaces.slice(-view.pile.count);
  }

  /**
   * The rects of everything that is about to move, captured *before* the board
   * is repainted. Sources have to be measured here because paint() is what
   * removes them; destinations are measured after, live.
   */
  function snapshot() {
    const cards = new Map();
    for (const node of el.querySelectorAll('[data-card-id]')) {
      const rect = rectOf(node);
      if (rect) cards.set(node.dataset.cardId, rect);
    }
    return {
      cards,
      pile: rectOf(pileStack),
      faceDown: [...faceDownRow.children].map((n) => rectOf(n)),
      pods: new Map([...pods].map(([seat, pod]) => [seat, rectOf(pod.el)])),
    };
  }

  /** Where a seat's cards come from and go to: your hand row, or their pod. */
  const seatRect = (seat) =>
    seat === view.you ? rectOf(handRow) : rectOf(pods.get(seat)?.el);

  function animate(prev, snap) {
    const events = view.events ?? [];
    if (!events.length) return;

    const pileRect = rectOf(pileStack);
    const stockRect = rectOf(stockStack);
    const burnRect = rectOf(burnStack);

    for (const event of events) {
      switch (event.e) {
        case 'played':
          flyPlay(event, snap, pileRect);
          break;

        case 'drew':
          flyDraw(event, stockRect);
          break;

        case 'pickedUp':
          flyToHand(event.seat, event.count, pileRect, prev.pile.top);
          break;

        case 'burned':
          flyBurn(event, events, prev, pileRect, burnRect);
          break;

        case 'flipped':
          flyFlip(event, events, snap, pileRect);
          break;

        case 'turn':
          // A 2 gets its own, lighter beat. A 10 and a bomb already shouted
          // during the burn, and stacking a second cue on them would blur the
          // one distinction this whole animation exists to draw.
          if (event.extraReason === 'two' && pileRect) {
            fx.run(() => fx.ripple(pileRect));
            fx.run(() => fx.shout(pileRect, 'Play again!', { kind: 'two', ms: 900 }));
          }
          break;

        case 'playerOut': {
          const rect = seatRect(event.seat);
          if (rect) {
            const text = event.seat === view.you ? "You're out!" : 'Out!';
            fx.run(() => fx.shout(rect, text, { kind: 'out', ms: 1100 }));
          }
          break;
        }

        default:
          break;
      }
    }
  }

  function flyPlay(event, snap, pileRect) {
    if (!pileRect) return;
    const flights = [];
    event.cards.forEach((card, i) => {
      // Your own card flies from exactly where you tapped it. An opponent's
      // comes out of their pod at pod scale — the client never knew where in
      // their hand it was, and pretending otherwise would be a fiction.
      const from =
        snap.cards.get(card.id) ??
        (snap.pods.get(event.seat) ? landingIn(pileRect, snap.pods.get(event.seat), 0.45) : null);
      if (!from) return;
      // The pile stack's layout box is exactly one card wide, so its rect is
      // the card-width the renderer's calc() resolves against.
      const spread = fanSpread(i, event.cards.length);
      flights.push({
        node: cardEl(card),
        from,
        to: { ...pileRect, left: pileRect.left + pileRect.width * spread * FAN_SHIFT },
        opts: { ms: 300, rotate: spread * FAN_TILT },
      });
    });
    if (flights.length) fx.run(() => fx.flock(flights, { stagger: 60 }));
  }

  function flyDraw(event, stockRect) {
    const to = seatRect(event.seat);
    if (!stockRect || !to) return;
    // The real cards are already painted, so the ghosts fade out as they land
    // rather than piling a second copy on top of them.
    const flights = Array.from({ length: Math.min(event.count, 3) }, () => ({
      node: backEl(),
      from: stockRect,
      to: landingIn(stockRect, to, 0.85),
      opts: { ms: 260, fade: 0.1 },
    }));
    fx.run(() => fx.flock(flights, { stagger: 45 }));
  }

  /** The pile fanning into somebody's hand: a pick-up, or a failed flip. */
  function flyToHand(seat, count, pileRect, topCard) {
    const to = seatRect(seat);
    if (!pileRect || !to) return;
    const flights = Array.from({ length: Math.min(count, 6) }, (_, i) => ({
      node: i === 0 && topCard ? cardEl(topCard) : backEl(),
      from: pileRect,
      to: landingIn(pileRect, to, 0.7),
      opts: { ms: 320, rotate: i % 2 ? 9 : -9, fade: 0.15 },
    }));
    fx.run(() => fx.flock(flights, { stagger: 38 }));
  }

  function flyBurn(event, events, prev, pileRect, burnRect) {
    if (!pileRect || !burnRect) return;

    // A 10 burns the *whole* pile, not just itself, so the whole pile has to be
    // seen leaving. The cards that were underneath fly as backs — the client was
    // never told what they are — but they must fly, or the burn reads as though
    // only the played card went anywhere and the rest silently evaporated.
    const played = events.find((e) => e.e === 'played');
    const flipped = events.find((e) => e.e === 'flipSuccess');
    const cards = played?.cards ?? (flipped ? [flipped.card] : [prev.pile.top].filter(Boolean));
    const total = Math.min(Math.max(event.count, cards.length, 1), 7);

    fx.run(() => fx.flash(pileRect, { ms: 380 }));
    fx.run(() => {
      // Faces first, backs behind them: the eye follows the card it just played
      // and then watches the stack it took with it.
      const nodes = Array.from({ length: total }, (_, i) =>
        i < cards.length ? cardEl(cards[i]) : backEl(),
      );
      return Promise.all(
        nodes.map((node, i) =>
          fx.fly(node, pileRect, landingIn(pileRect, burnRect, 0.4), {
            ms: 520,
            rotate: 25 + i * 7,
            fade: 0.2,
            delay: i * 40,
          }),
        ),
      );
    });
    const text = event.reason === 'fourOfAKind' ? 'Bomb! Go again' : 'Burn! Go again';
    fx.run(() => fx.shout(pileRect, text, { kind: 'burn', ms: 1000 }));
  }

  function flyFlip(event, events, snap, pileRect) {
    const from = snap.faceDown[event.index] ?? snap.faceDown.find(Boolean) ?? pileRect;
    if (!from) return;

    // Held still first. A blind flip is the one moment where the card matters
    // more than the move, and without this beat it is gone before the player's
    // eye has landed on it.
    fx.run(() => fx.hold(cardEl(event.card), from, 800));

    const fail = events.find((e) => e.e === 'flipFail');
    if (fail) {
      const to = seatRect(event.seat);
      if (!to) return;
      fx.run(() =>
        fx.flock(
          [
            {
              node: cardEl(event.card),
              from,
              to: landingIn(from, to, 0.7),
              opts: { ms: 320, fade: 0.15 },
            },
            // `taken` counts the flipped card, so the pile contributed the rest.
            ...Array.from({ length: Math.min(fail.taken - 1, 5) }, (_, i) => ({
              node: backEl(),
              from: pileRect ?? from,
              to: landingIn(pileRect ?? from, to, 0.7),
              opts: { ms: 320, rotate: i % 2 ? 9 : -9, fade: 0.15 },
            })),
          ],
          { stagger: 40 },
        ),
      );
    } else if (pileRect) {
      fx.run(() => fx.fly(cardEl(event.card), from, pileRect, { ms: 300 }));
    }
  }

  return {
    el,

    update(state) {
      if (!state.view || state.view.phase !== 'playing') return;

      // The store notifies on every change, not only on a new frame — flipping
      // `busy` on a tap arrives here too. Without this the same events would be
      // logged and animated twice, which is how a log strip starts lying.
      if (state.view === view) {
        paint();
        return;
      }

      const prev = view;
      // A new game is a new board; anything still queued describes the old one.
      if (prev && prev.gameId !== state.view.gameId) fx.reset();

      const snap = prev ? snapshot() : null;
      view = state.view;
      // The cards may have moved underneath the selection — drop anything gone.
      selection.prune(openCards());
      adoptPileFaces();
      paint();
      log.update(view);

      if (snap && prev.gameId === view.gameId) animate(prev, snap);
      // Turn indicator #4, and the only one that works with the phone face down.
      if (view.me.yourTurn && !prev?.me?.yourTurn) buzz(30);
    },
  };
}

// --------------------------------------------------------------------- bits

function buildPod() {
  const el = document.createElement('div');
  el.className = 'pod';
  el.innerHTML = `
    <div class="pod-head">
      <span class="pod-name"></span>
      <span class="pod-count"></span>
    </div>
    <div class="pod-hand"></div>
    <div class="pod-table">
      <div class="pod-down"></div>
      <div class="pod-up"></div>
    </div>
    <span class="pod-status"></span>
  `;
  return {
    el,
    name: el.querySelector('.pod-name'),
    count: el.querySelector('.pod-count'),
    hand: el.querySelector('.pod-hand'),
    down: el.querySelector('.pod-down'),
    up: el.querySelector('.pod-up'),
    status: el.querySelector('.pod-status'),
  };
}

/**
 * How far the i-th of `n` fanned faces sits from the stack's centre, in card
 * widths. Shared by the renderer and the flight so a card lands exactly where
 * paint() has already drawn it — any disagreement reads as a visible jump.
 */
function fanSpread(i, n) {
  return n <= 1 ? 0 : i - (n - 1) / 2;
}

/** Keep exactly `n` anonymous children — used for backs, which have no id. */
function syncCount(container, n, build) {
  while (container.children.length > n) container.lastElementChild.remove();
  while (container.children.length < n) container.append(build());
}

function ordinal(place) {
  if (!place) return 'out';
  const suffix = ['th', 'st', 'nd', 'rd'][place % 10 > 3 || (place % 100 >= 11 && place % 100 <= 13) ? 0 : place % 10];
  return `${place}${suffix}`;
}

function shake(node) {
  if (!node) return;
  node.classList.remove('shake');
  void node.offsetWidth;
  node.classList.add('shake');
}
