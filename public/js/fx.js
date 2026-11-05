// The animation layer.
//
// Every animation here is a *decoration*. The board is painted from the
// authoritative view the instant it arrives and is never held back; fx only
// draws throwaway clones into a fixed overlay above it. That is what makes a
// slow, dropped or interrupted animation harmless — there is no intermediate
// DOM state for it to get stuck in, so the worst case is the player seeing a
// correct board without the flourish that would have explained it.
//
// The flights are FLIP: measure both rects, start a clone at the source, let
// the compositor transition it to the destination, throw the clone away.

const BUDGET = 2500;
const EASE = 'cubic-bezier(.32,.78,.32,1)';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** A plain object copy of a rect, so it survives the DOM node being removed. */
export function rectOf(node) {
  if (!node) return null;
  const { left, top, width, height } = node.getBoundingClientRect();
  if (!width || !height) return null; // hidden, or not laid out yet
  return { left, top, width, height };
}

/**
 * Where a clone the size of `from` has to end up to sit centred inside `slot`
 * at `scale`. Returned as a rect rather than a scale factor because fly()
 * derives its own scale from the width ratio — one source of truth.
 */
export function landingIn(from, slot, scale = 1) {
  const width = from.width * scale;
  const height = from.height * scale;
  return {
    left: slot.left + slot.width / 2 - width / 2,
    top: slot.top + slot.height / 2 - height / 2,
    width,
    height,
  };
}

export function createFx() {
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);

  const queue = [];
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    // One deadline per drain, not per step: a burn followed by four card
    // flights should cost the player one budget, not five.
    const deadline = performance.now() + BUDGET;
    while (queue.length) {
      const step = queue.shift();
      // Over budget, the rest are dropped rather than queued behind the next
      // frame. A backlog is exactly how an animation layer falls behind the
      // board and starts narrating a position that no longer exists.
      if (performance.now() > deadline) continue;
      try {
        await step();
      } catch {
        // A failed decoration is never worth propagating.
      }
    }
    layer.replaceChildren();
    draining = false;
  }

  function enqueue(step) {
    if (reduced.matches) return;
    queue.push(step);
    drain();
  }

  function place(node, rect) {
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
    node.style.translate = `${rect.left}px ${rect.top}px`;
  }

  /** Fly one node from rect to rect. Resolves when it lands. */
  async function fly(node, from, to, opts = {}) {
    const { ms = 300, rotate = 0, scale = null, fade = null, delay = 0 } = opts;
    node.classList.add('fx-ghost');
    place(node, from);
    layer.append(node);

    if (delay) await wait(delay);
    // Two frames, not one: the browser will happily coalesce the start and end
    // styles into a single recalc, and the card teleports with no transition.
    await nextFrame();
    await nextFrame();

    node.style.transition =
      `translate ${ms}ms ${EASE}, rotate ${ms}ms ${EASE}, ` +
      `scale ${ms}ms ${EASE}, opacity ${ms}ms linear`;
    node.style.translate = `${to.left}px ${to.top}px`;
    node.style.rotate = `${rotate}deg`;
    node.style.scale = `${scale ?? (from.width ? to.width / from.width : 1)}`;
    if (fade !== null) node.style.opacity = `${fade}`;

    await wait(ms);
    node.remove();
  }

  return {
    /** Queue a step. Steps run strictly one at a time, in order. */
    run: enqueue,

    /** Drop everything pending — the board has moved on without us. */
    reset() {
      queue.length = 0;
      layer.replaceChildren();
    },

    fly,

    /** Several flights at once, staggered. Resolves when the last one lands. */
    flock(flights, { stagger = 55 } = {}) {
      return Promise.all(
        flights.map((f, i) => fly(f.node, f.from, f.to, { ...f.opts, delay: i * stagger })),
      );
    },

    /** A radial burst centred on a rect. The first beat of the burn. */
    async flash(rect, { ms = 400, kind = 'burn' } = {}) {
      const size = Math.max(rect.width, rect.height) * 2.6;
      const el = document.createElement('div');
      el.className = `fx-flash fx-flash-${kind}`;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.translate =
        `${rect.left + rect.width / 2 - size / 2}px ${rect.top + rect.height / 2 - size / 2}px`;
      el.style.animationDuration = `${ms}ms`;
      layer.append(el);
      await wait(ms);
      el.remove();
    },

    /**
     * A ring sweeping outward from a rect. This is the 2's whole visual
     * identity: it has to read as "go again" without reading as "burn", so it
     * is cool, thin and quiet where the burn is hot, solid and loud.
     */
    async ripple(rect, { ms = 520 } = {}) {
      const el = document.createElement('div');
      el.className = 'fx-ripple';
      place(el, rect);
      el.style.animationDuration = `${ms}ms`;
      layer.append(el);
      await wait(ms);
      el.remove();
    },

    /** Floating text above a rect — "BURN!", "Play again!". */
    async shout(rect, text, { kind = 'burn', ms = 900 } = {}) {
      const el = document.createElement('div');
      el.className = `fx-shout fx-shout-${kind}`;
      el.textContent = text;
      el.style.translate = `${rect.left + rect.width / 2}px ${rect.top}px`;
      el.style.animationDuration = `${ms}ms`;
      layer.append(el);
      await wait(ms);
      el.remove();
    },

    /** Hold a card still so the player can actually read it. */
    async hold(node, rect, ms) {
      node.classList.add('fx-ghost', 'fx-reveal');
      place(node, rect);
      layer.append(node);
      await wait(ms);
      node.remove();
    },

    wait,
  };
}

/**
 * Haptics. Silent everywhere it is unsupported, which is most desktops and all
 * of iOS Safari — so it can only ever be an extra cue, never the only one.
 */
export function buzz(pattern) {
  if (reduced.matches) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Unsupported. Not worth knowing about.
  }
}
