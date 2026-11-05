// The client's single source of truth, plus the bits of it that outlive a tab.
//
// Nothing here derives game state. Every frame from the server replaces what we
// hold, so the client can never drift into its own opinion of the board — on a
// reconnect we simply take the snapshot the server sends.

const listeners = new Set();

const state = {
  screen: 'home',          // home | lobby | table | gameover
  status: 'connecting',    // connecting | open | retrying | fatal
  welcome: null,           // { protocolVersion, roomCode, you, resumeToken, isHost }
  room: null,              // last `room` frame — lobby and postgame
  view: null,              // last `state` frame — the redacted game view
  notices: [],             // newest last, capped
  error: null,             // { code, message, fatal } for the banner
  busy: false,             // an action is in flight; used to dim the action bar
};

export function get() {
  return state;
}

export function set(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const MAX_NOTICES = 12;

export function pushNotice(notice) {
  state.notices = [...state.notices, { ...notice, at: Date.now() }].slice(-MAX_NOTICES);
  set({});
}

/**
 * Which screen the current frames imply. Derived rather than stored so a
 * reconnect mid-game lands on the right screen with no extra bookkeeping.
 */
export function screenFor(s = state) {
  if (!s.welcome || (s.room && s.room.left)) return 'home';
  if (!s.view) return 'lobby';
  if (s.view.phase === 'gameover') return 'gameover';
  if (s.view.phase === 'playing') return 'table';
  return 'lobby';
}

// ------------------------------------------------------------------ storage

// localStorage can be unavailable (Safari private mode, embedded webviews) and
// throws on access rather than returning null, so every touch is guarded.
const safe = (fn, fallback = null) => {
  try { return fn(); } catch { return fallback; }
};

export const remembered = {
  get name() {
    return safe(() => localStorage.getItem('shampoo:name')) ?? '';
  },
  set name(value) {
    safe(() => localStorage.setItem('shampoo:name', value));
  },
};

/**
 * The resume token lives in both stores on purpose.
 *
 * sessionStorage is per-tab, so two tabs on one laptop each keep their own
 * seat instead of fighting over one. localStorage survives the tab being killed
 * outright — an iOS Safari background purge, or a force-quit — which is the
 * case resuming exists for. Reading prefers the session copy, so this tab's own
 * seat always wins over whatever another tab wrote last.
 */
export const seatMemory = {
  save(code, token) {
    const payload = JSON.stringify({ code, token });
    safe(() => sessionStorage.setItem('shampoo:seat', payload));
    safe(() => localStorage.setItem('shampoo:seat', payload));
  },

  load() {
    const raw = safe(() => sessionStorage.getItem('shampoo:seat'))
      ?? safe(() => localStorage.getItem('shampoo:seat'));
    if (!raw) return null;
    const parsed = safe(() => JSON.parse(raw));
    return parsed?.code && parsed?.token ? parsed : null;
  },

  clear() {
    safe(() => sessionStorage.removeItem('shampoo:seat'));
    safe(() => localStorage.removeItem('shampoo:seat'));
  },
};
