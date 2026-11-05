// The win / lose splash: the one moment the game is allowed to shout.
//
// It is a pure overlay. It never gates anything — the game-over screen is
// already painted and interactive underneath, so a splash that is skipped,
// never shown, or cut short by reduced-motion costs the player nothing.

import { buzz } from '../fx.js';

const HOLD_MS = 3500;
const CONFETTI = 80;
// Teal, gold and white — the table's own palette, so the burst reads as part of
// the game rather than a stock effect pasted on top.
const CONFETTI_COLORS = ['#35d6a4', '#f2c14e', '#ffffff', '#7ef0c8', '#ffd98a'];

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

export function createSplash() {
  const el = document.createElement('div');
  el.className = 'splash';
  el.hidden = true;
  // Decorative: the game-over screen beneath carries the same result as real
  // text, so there is nothing here a screen reader needs to hear twice.
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="splash-wash"></div>
    <div class="splash-rays" aria-hidden="true"></div>
    <div class="splash-confetti" aria-hidden="true"></div>
    <div class="splash-lockup">
      <p class="splash-kicker"></p>
      <h1 class="splash-title"></h1>
      <p class="splash-sub"></p>
    </div>
  `;

  const confetti = el.querySelector('.splash-confetti');
  const kicker = el.querySelector('.splash-kicker');
  const title = el.querySelector('.splash-title');
  const sub = el.querySelector('.splash-sub');

  let timer = null;

  function hide() {
    clearTimeout(timer);
    timer = null;
    el.hidden = true;
    el.classList.remove('is-win', 'is-lose');
    // Dropping the nodes rather than leaving them paused: 80 animated elements
    // that outlive the splash would keep compositing behind the next game.
    confetti.replaceChildren();
  }

  // Tap anywhere to skip. Pointerdown, not click, so the splash gets out of the
  // way on the first touch instead of waiting for the tap to complete.
  el.addEventListener('pointerdown', hide);

  return {
    el,

    /**
     * @param kind  'win' | 'lose'
     * @param text  { kicker, title, sub }
     */
    play(kind, text) {
      hide();
      kicker.textContent = text.kicker ?? '';
      title.textContent = text.title ?? '';
      sub.textContent = text.sub ?? '';
      el.classList.add(kind === 'win' ? 'is-win' : 'is-lose');
      el.hidden = false;

      if (kind === 'win') {
        if (!reduced.matches) sprinkle(confetti);
        buzz([40, 60, 40]);
      } else {
        buzz(300);
      }

      timer = setTimeout(hide, HOLD_MS);
    },

    hide,
  };
}

/**
 * The confetti shower. Every particle is one div whose whole animation is
 * expressed in custom properties, so the keyframes exist once in CSS and the
 * browser animates all 80 off the compositor with no per-frame JS.
 */
function sprinkle(host) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < CONFETTI; i++) {
    const bit = document.createElement('i');
    bit.className = 'confetti';
    bit.style.left = `${rand(-5, 105)}%`;
    bit.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    bit.style.setProperty('--drift', `${rand(-18, 18)}vw`);
    bit.style.setProperty('--spin', `${rand(-900, 900)}deg`);
    bit.style.setProperty('--fall', `${rand(1900, 3100)}ms`);
    bit.style.setProperty('--delay', `${rand(0, 900)}ms`);
    // Half of them are thin ribbons rather than squares, which is what keeps
    // the shower from reading as a uniform grid of dots.
    if (i % 2) { bit.style.width = '5px'; bit.style.height = '13px'; }
    frag.append(bit);
  }
  host.append(frag);
}

const rand = (min, max) => min + Math.random() * (max - min);
