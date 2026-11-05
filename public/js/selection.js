// Which of your cards are currently picked, and what that implies.
//
// The same-rank rule is enforced here as *presentation*, not as an error: the
// moment one card is selected, every different-rank card is muted, so the rule
// becomes visually obvious instead of something you learn by being rejected.
//
// Legality always comes from the server's `me.playableCardIds`. This module
// never decides what is legal — it only decides what is selected.

export function createSelection() {
  let ids = [];
  let rank = null;

  const api = {
    get ids() { return [...ids]; },
    get rank() { return rank; },
    get size() { return ids.length; },

    has: (id) => ids.includes(id),

    clear() {
      ids = [];
      rank = null;
    },

    /** Tap a card: select it, deselect it, or start a new same-rank group. */
    toggle(card, { max = 4 } = {}) {
      if (api.has(card.id)) {
        ids = ids.filter((id) => id !== card.id);
        if (ids.length === 0) rank = null;
        return;
      }
      // A different rank replaces the selection rather than refusing it — the
      // player clearly wants the card they just tapped.
      if (rank !== null && card.rank !== rank) {
        ids = [card.id];
        rank = card.rank;
        return;
      }
      if (ids.length >= max) return;
      ids.push(card.id);
      rank = card.rank;
    },

    /** Select every matching card at once (long-press, or the "all" chip). */
    selectAll(cards, card, { max = 4 } = {}) {
      rank = card.rank;
      ids = cards.filter((c) => c.rank === card.rank).slice(0, max).map((c) => c.id);
    },

    /**
     * Drop anything that is no longer in the open zone.
     *
     * After a play or a pickup the cards move, and a selection that outlived
     * them would send ids the server will reject.
     */
    prune(cards) {
      const live = new Set(cards.map((c) => c.id));
      ids = ids.filter((id) => live.has(id));
      if (ids.length === 0) rank = null;
    },

    /** How many more of this rank could still be added. */
    moreAvailable(cards, { max = 4 } = {}) {
      if (rank === null) return 0;
      const matching = cards.filter((c) => c.rank === rank).length;
      return Math.min(matching, max) - ids.length;
    },
  };

  return api;
}
