// The one place a card becomes DOM. Every screen draws through here, so a card
// looks and behaves identically in the hand, the pile and a pod.
//
// Cards are pure CSS — no images, no SVG. See cards.css.

import { SUIT_GLYPH, SUIT_NAME, isRed } from '/shared/cards.js';

/**
 * A face-up card.
 *
 * `data-card-id` is the reconciliation key and the handle fx.js uses to find a
 * card's rect before animating it, so it is set on every card, always.
 */
export function cardEl(card, { selectable = false } = {}) {
  const el = document.createElement(selectable ? 'button' : 'div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.dataset.rank = card.rank;
  el.dataset.suit = card.suit;
  el.style.setProperty('--suit-color', isRed(card) ? 'var(--suit-red)' : 'var(--suit-black)');

  if (selectable) el.type = 'button';
  else el.setAttribute('aria-hidden', 'true'); // the label below is the readable copy

  // The rank is a real element rather than a ::before so the pips can sit in
  // the middle without a third layer; the corner is mirrored in CSS.
  el.innerHTML = `
    <span class="card-corner">
      <span class="card-rank"></span>
      <span class="card-pip"></span>
    </span>
    <span class="card-face"></span>
  `;
  el.querySelector('.card-rank').textContent = card.rank;
  el.querySelector('.card-pip').textContent = SUIT_GLYPH[card.suit];
  el.querySelector('.card-face').textContent = SUIT_GLYPH[card.suit];

  if (selectable) el.setAttribute('aria-label', `${card.rank} of ${SUIT_NAME[card.suit]}`);
  return el;
}

/** A face-down card. No identity is passed in — the client must not know it. */
export function backEl({ selectable = false, label = 'Face-down card' } = {}) {
  const el = document.createElement(selectable ? 'button' : 'div');
  el.className = 'card is-back';
  if (selectable) {
    el.type = 'button';
    el.setAttribute('aria-label', label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  return el;
}

/**
 * Reconcile a row of cards in place, keyed by card id.
 *
 * Rebuilding from scratch would restart every CSS transition and drop the
 * selected state mid-tap, so existing nodes are reused and only moved.
 * Returns the live nodes in order, which callers use to apply per-card state.
 */
export function syncRow(container, cards, build) {
  const existing = new Map();
  for (const node of container.children) {
    if (node.dataset.cardId) existing.set(node.dataset.cardId, node);
  }

  const nodes = cards.map((card) => existing.get(card.id) ?? build(card));
  for (const node of nodes) container.append(node); // append moves, not clones

  for (const [id, node] of existing) {
    if (!cards.some((card) => card.id === id)) node.remove();
  }
  return nodes;
}
