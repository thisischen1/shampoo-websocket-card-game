// The wire contract. Imported by the server and, via the /shared/ static mount,
// by the browser — so the two can never drift.
//
// One JSON object per frame, discriminated by `t`.
//
// Bump PROTOCOL_VERSION on any breaking change: the server rejects a mismatched
// client with a fatal error telling it to hard-reload, which is what saves a
// stale tab left open across a deploy.

export const PROTOCOL_VERSION = 1;

// Client -> Server
export const C = {
  CREATE_ROOM: 'createRoom',       // { name, maxPlayers }
  JOIN_ROOM: 'joinRoom',           // { code, name }
  RESUME: 'resume',                // { code, resumeToken }
  SET_NAME: 'setName',             // { name }
  SET_MAX_PLAYERS: 'setMaxPlayers', // { maxPlayers }            host only
  START_GAME: 'startGame',         // {}                         host only
  PLAY_CARDS: 'playCards',         // { cardIds[], turnSeq }
  PICK_UP_PILE: 'pickUpPile',      // { turnSeq }
  FLIP_FACE_DOWN: 'flipFaceDown',  // { index, turnSeq }
  PLAY_AGAIN_READY: 'playAgainReady', // { ready }
  START_NEXT_GAME: 'startNextGame', // {}                        host only
  BACK_TO_LOBBY: 'backToLobby',    // {}                         host only
  FORFEIT_SEAT: 'forfeitSeat',     // { seatId }                 host only
  PICK_UP_FOR_SEAT: 'pickUpForSeat', // { seatId, turnSeq }      host only
  LEAVE_ROOM: 'leaveRoom',         // {}
  PING: 'ping',                    // {}
};

// Server -> Client
export const S = {
  WELCOME: 'welcome', // { protocolVersion, roomCode, you, resumeToken, isHost }
  ROOM: 'room',       // lobby / postgame snapshot. No card data.
  STATE: 'state',     // the redacted game view, with events[] inside it
  ERROR: 'error',     // { code, message, fatal? }
  NOTICE: 'notice',   // { text, kind }
  PONG: 'pong',
};

// Protocol-level errors. Game-rule errors come from engine.js ERR.
export const PERR = {
  BAD_VERSION: 'ERR_BAD_VERSION',
  BAD_MESSAGE: 'ERR_BAD_MESSAGE',
  TOO_LARGE: 'ERR_TOO_LARGE',
  RATE_LIMIT: 'ERR_RATE_LIMIT',
  NO_ROOM: 'ERR_NO_ROOM',
  ROOM_FULL: 'ERR_ROOM_FULL',
  GAME_IN_PROGRESS: 'ERR_GAME_IN_PROGRESS',
  NOT_IN_ROOM: 'ERR_NOT_IN_ROOM',
  NOT_HOST: 'ERR_NOT_HOST',
  BAD_TOKEN: 'ERR_BAD_TOKEN',
  BAD_NAME: 'ERR_BAD_NAME',
  BAD_PLAYER_COUNT: 'ERR_BAD_PLAYER_COUNT',
  NOT_ENOUGH_PLAYERS: 'ERR_NOT_ENOUGH_PLAYERS',
  TOO_SOON: 'ERR_TOO_SOON',
  SEAT_CONNECTED: 'ERR_SEAT_CONNECTED',
};

export const LIMITS = {
  MAX_FRAME_BYTES: 8 * 1024,
  MAX_MSGS_PER_SEC: 25,
  MAX_NAME_LEN: 16,
  CODE_LEN: 4,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 5,
  // A stalled current player can be nudged along by the host after this.
  STUCK_SEAT_MS: 60_000,
  // Keepalive, kept under the ~30 s idle timeout most platform proxies impose.
  HEARTBEAT_MS: 25_000,
  // Room garbage collection.
  IDLE_ROOM_MS: 30 * 60_000,
  UNSTARTED_ROOM_MS: 10 * 60_000,
};

export const ERROR_TEXT = {
  [PERR.BAD_VERSION]: 'This page is out of date. Please reload.',
  [PERR.BAD_MESSAGE]: 'That request did not make sense.',
  [PERR.TOO_LARGE]: 'That request was too large.',
  [PERR.RATE_LIMIT]: 'Slow down a moment.',
  [PERR.NO_ROOM]: 'No room with that code.',
  [PERR.ROOM_FULL]: 'That room is full.',
  [PERR.GAME_IN_PROGRESS]: 'That game has already started — join after this round.',
  [PERR.NOT_IN_ROOM]: 'You are not in a room.',
  [PERR.NOT_HOST]: 'Only the host can do that.',
  [PERR.BAD_TOKEN]: 'Could not restore your seat.',
  [PERR.BAD_NAME]: 'Please pick a shorter name.',
  [PERR.BAD_PLAYER_COUNT]: 'Pick between 2 and 5 players.',
  [PERR.NOT_ENOUGH_PLAYERS]: 'You need at least 2 players.',
  [PERR.TOO_SOON]: 'Not yet — give them a moment.',
  [PERR.SEAT_CONNECTED]: 'That player is still connected.',

  // Rule rejections from engine.js. Spelled as literals rather than imported:
  // `shared/` sits underneath `game/` and must not depend on it, and these are
  // wire constants anyway. Without them every illegal move would surface to the
  // player as a generic failure.
  ERR_WRONG_PHASE: 'Not right now.',
  ERR_NOT_YOUR_TURN: 'It is not your turn.',
  ERR_STALE: 'The board moved on — try again.',
  ERR_PLAYER_OUT: 'You are already out.',
  ERR_NO_SEAT: 'You are not in this game.',
  ERR_MUST_FLIP: 'Only your face-down cards are left — flip one.',
  ERR_NOT_FLIP_TIME: 'You still have cards you can play.',
  ERR_NO_CARDS: 'Pick a card first.',
  ERR_TOO_MANY_CARDS: 'Four cards at most.',
  ERR_DUPLICATE_CARDS: 'That card was listed twice.',
  ERR_CARD_NOT_IN_ZONE: 'You cannot play that card.',
  ERR_MIXED_RANKS: 'Cards played together must match.',
  ERR_TOO_LOW: 'Too low — play higher, or pick up the pile.',
  ERR_EMPTY_PILE: 'There is nothing to pick up.',
  ERR_BAD_INDEX: 'No card there.',
  ERR_UNKNOWN_ACTION: 'That request did not make sense.',
};
