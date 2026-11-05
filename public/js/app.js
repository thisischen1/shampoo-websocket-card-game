// Entry point. Owns the socket, the screen switch, and nothing else.
//
// The loop is deliberately one-way: a frame arrives, it goes into the store,
// every screen re-reads the store. Screens never talk to each other and never
// mutate state directly — they only send messages.

import { C, S } from '/shared/protocol.js';
import { createNet } from './net.js';
import { get, set, subscribe, pushNotice, screenFor, remembered, seatMemory } from './store.js';
import { createHome } from './render/home.js';
import { createLobby } from './render/lobby.js';
import { createTable } from './render/table.js';
import { createGameOver } from './render/gameover.js';

const app = document.getElementById('app');
const banner = document.getElementById('banner');
const connection = document.getElementById('connection');

// ------------------------------------------------------------------- socket

const net = createNet({
  onStatus: (status) => set({ status }),
  onFrame: handleFrame,
  onOpen: () => {
    // A reconnect must reclaim the seat before anything else, otherwise the
    // server sees a brand-new client and the old seat sits there disconnected.
    const saved = seatMemory.load();
    if (saved) net.send(C.RESUME, { code: saved.code, resumeToken: saved.token });
  },
});

function handleFrame(frame) {
  switch (frame.t) {
    case S.WELCOME:
      seatMemory.save(frame.roomCode, frame.resumeToken);
      set({ welcome: frame, error: null });
      break;

    case S.ROOM:
      if (frame.left) {
        seatMemory.clear();
        set({ welcome: null, room: null, view: null, notices: [] });
      } else {
        // A `room` frame is only ever sent when the server holds no game, so
        // its arrival is what retires the last one. Without this the finished
        // view would linger and keep the postgame screen up after the host has
        // already taken everyone back to the lobby.
        set({ room: frame, view: null });
      }
      break;

    case S.STATE:
      set({ view: frame, busy: false });
      break;

    case S.NOTICE:
      pushNotice(frame);
      break;

    case S.ERROR:
      // A refused resume means the seat is gone for good; holding the token
      // would just make every future reconnect fail the same way.
      if (frame.code === 'ERR_BAD_TOKEN' || frame.code === 'ERR_NO_ROOM') seatMemory.clear();
      if (frame.fatal) set({ welcome: null, room: null, view: null });
      set({ error: frame, busy: false });
      break;

    default:
      break;
  }
}

/** Send, and remember that we are waiting, so the UI can stop double-taps. */
const act = (type, body) => {
  set({ busy: true, error: null });
  if (!net.send(type, body)) set({ busy: false });
};

// ------------------------------------------------------------------ screens

const screens = {
  home: createHome({
    onCreate: ({ name, maxPlayers }) => {
      remembered.name = name;
      seatMemory.clear(); // a new room means a new seat
      act(C.CREATE_ROOM, { name, maxPlayers });
    },
    onJoin: ({ code, name }) => {
      remembered.name = name;
      seatMemory.clear();
      act(C.JOIN_ROOM, { code, name });
    },
  }),

  lobby: createLobby({
    onStart: () => {
      const { room } = get();
      act(room?.gamesStarted > 0 ? C.START_NEXT_GAME : C.START_GAME);
    },
    onSetMaxPlayers: (maxPlayers) => act(C.SET_MAX_PLAYERS, { maxPlayers }),
    onLeave: () => {
      seatMemory.clear();
      act(C.LEAVE_ROOM);
    },
  }),

  table: createTable({
    onPlay: (cardIds, turnSeq) => act(C.PLAY_CARDS, { cardIds, turnSeq }),
    onPickUp: (turnSeq) => act(C.PICK_UP_PILE, { turnSeq }),
    onFlip: (index, turnSeq) => act(C.FLIP_FACE_DOWN, { index, turnSeq }),
    onPickUpFor: (seatId, turnSeq) => act(C.PICK_UP_FOR_SEAT, { seatId, turnSeq }),
    onForfeit: (seatId) => act(C.FORFEIT_SEAT, { seatId }),
  }),

  gameover: createGameOver({
    onPlayAgain: () => act(C.START_NEXT_GAME),
    onReady: (ready) => act(C.PLAY_AGAIN_READY, { ready }),
    onBackToLobby: () => act(C.BACK_TO_LOBBY),
    onLeave: () => {
      seatMemory.clear();
      act(C.LEAVE_ROOM);
    },
  }),
};

for (const screen of Object.values(screens)) {
  screen.el.hidden = true;
  app.append(screen.el);
}

// --------------------------------------------------------------- the render

const STATUS_TEXT = {
  connecting: 'Connecting…',
  retrying: 'Reconnecting…',
  fatal: 'Out of date — please reload',
};

let lastScreen = null;

subscribe((state) => {
  const next = screenFor(state);

  for (const [name, screen] of Object.entries(screens)) {
    screen.el.hidden = name !== next;
  }
  // A phase with no screen of its own falls back to the lobby, which is
  // truthful because the room data behind it is real.
  if (!screens[next]) screens.lobby.el.hidden = false;

  screens[next]?.update(state);
  if (next !== lastScreen) {
    lastScreen = next;
    window.scrollTo(0, 0);
  }

  // Connection pill: only shown when something is wrong, so it is never noise.
  const statusText = STATUS_TEXT[state.status];
  connection.hidden = !statusText;
  connection.textContent = statusText ?? '';
  connection.classList.toggle('is-fatal', state.status === 'fatal');

  // Error banner.
  banner.hidden = !state.error;
  if (state.error) {
    banner.textContent = state.error.message ?? 'Something went wrong.';
    banner.classList.toggle('is-fatal', !!state.error.fatal);
  }
});

banner.addEventListener('click', () => set({ error: null }));

// ---------------------------------------------------------------- deep link

// `/?r=K7QM` lets the host share one URL instead of a URL plus a code. The
// parameter is stripped afterwards so a refresh does not re-trigger the join
// panel once the player is already seated.
const params = new URLSearchParams(location.search);
const invite = params.get('r');

set({}); // first paint

// After the first paint, never before: prefill focuses a field, and focus()
// does nothing on a screen that is still hidden.
if (invite) {
  screens.home.prefill(invite.toUpperCase().slice(0, 8));
  history.replaceState(null, '', location.pathname);
}

net.connect();
