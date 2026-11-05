import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, RoomManager } from '../src/server/rooms.js';
import { ALPHABET, makeCode, normalizeCode, uniqueCode } from '../src/server/codes.js';
import { LIMITS, PERR, ERROR_TEXT } from '../src/shared/protocol.js';
import { ERR } from '../src/game/engine.js';
import {
  BadInput, cleanName, parseFrame, makeRateLimiter,
  requireCode, requirePlayerCount, requireToken, requireCardIds,
} from '../src/server/validate.js';

const T0 = 1_700_000_000_000;

const codeOf = (fn) => {
  try { fn(); return null; } catch (e) {
    assert.ok(e instanceof BadInput, `expected BadInput, got ${e}`);
    return e.code;
  }
};

// ------------------------------------------------------------------ protocol

/**
 * Every code the server can send must have something a player can read. Rule
 * errors travel the same wire as protocol errors, and because `shared/` cannot
 * import `game/` their text is written out by hand — so it needs a guard.
 */
test('every error code the server can emit has user-facing text', () => {
  for (const code of [...Object.values(PERR), ...Object.values(ERR), 'ERR_UNKNOWN_ACTION']) {
    assert.equal(typeof ERROR_TEXT[code], 'string', `${code} has no message`);
    assert.ok(ERROR_TEXT[code].length > 3, `${code} has a useless message`);
  }
});

// ------------------------------------------------------------------ codes

test('room codes use only unambiguous characters', () => {
  for (let i = 0; i < 200; i++) {
    const code = makeCode();
    assert.equal(code.length, LIMITS.CODE_LEN);
    for (const ch of code) assert.ok(ALPHABET.includes(ch), `${ch} in ${code}`);
  }
  for (const ch of 'OIL01258SZB') assert.equal(ALPHABET.includes(ch), false, ch);
});

test('code generation retries past collisions and eventually lengthens', () => {
  const taken = new Set();
  for (let i = 0; i < 50; i++) taken.add(uniqueCode((c) => taken.has(c)));
  assert.equal(taken.size, 50);

  // every 4-char code is "taken": it must still return something usable
  const longer = uniqueCode((c) => c.length === LIMITS.CODE_LEN, 5);
  assert.ok(longer.length > LIMITS.CODE_LEN);
});

test('typed codes are normalised: case, spacing and stray punctuation', () => {
  assert.equal(normalizeCode('k7-qm'), 'K7QM');
  assert.equal(normalizeCode('  K7QM  '), 'K7QM');
  assert.equal(normalizeCode('k7 q m'), 'K7QM');
  assert.equal(normalizeCode('K7QM!!'), 'K7QM');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(12345), '');
});

// ------------------------------------------------------------------ validate

test('names are trimmed, capped and stripped of control characters', () => {
  assert.equal(cleanName('  Ana  '), 'Ana');
  assert.equal(cleanName('An\u0000a\u001f'), 'Ana');
  assert.equal(cleanName('Bob\u200bby'), 'Bobby', 'zero-width characters are removed');
  assert.equal(cleanName('a'.repeat(40)).length, LIMITS.MAX_NAME_LEN);
  assert.equal(cleanName('   '), 'Player');
  assert.equal(cleanName(undefined, 'Player 3'), 'Player 3');
  assert.equal(cleanName('Ana\n\nBeth'), 'Ana Beth');
});

test('oversized and malformed frames are rejected before anything else', () => {
  assert.equal(codeOf(() => parseFrame('x'.repeat(LIMITS.MAX_FRAME_BYTES + 1))), PERR.TOO_LARGE);
  assert.equal(codeOf(() => parseFrame('{nope')), PERR.BAD_MESSAGE);
  assert.equal(codeOf(() => parseFrame('[1,2,3]')), PERR.BAD_MESSAGE);
  assert.equal(codeOf(() => parseFrame('null')), PERR.BAD_MESSAGE);
  assert.equal(codeOf(() => parseFrame('{"x":1}')), PERR.BAD_MESSAGE, 'no type');
  assert.equal(parseFrame('{"t":"ping"}').t, 'ping');
});

test('a huge frame is rejected on size, not on parse cost', () => {
  // 1 MB of valid JSON: the size check must fire first
  const huge = JSON.stringify({ t: 'playCards', cardIds: new Array(100_000).fill('7H') });
  assert.equal(codeOf(() => parseFrame(huge)), PERR.TOO_LARGE);
});

test('payload validators reject what a hostile client would send', () => {
  assert.equal(codeOf(() => requireCode('ABC')), PERR.NO_ROOM);
  assert.equal(codeOf(() => requirePlayerCount(1)), PERR.BAD_PLAYER_COUNT);
  assert.equal(codeOf(() => requirePlayerCount(6)), PERR.BAD_PLAYER_COUNT);
  assert.equal(codeOf(() => requirePlayerCount('three')), PERR.BAD_PLAYER_COUNT);
  assert.equal(requirePlayerCount('4'), 4);

  assert.equal(codeOf(() => requireToken('nope')), PERR.BAD_TOKEN);
  assert.equal(codeOf(() => requireToken('a'.repeat(31))), PERR.BAD_TOKEN);
  assert.equal(requireToken('ab'.repeat(16)).length, 32);

  assert.equal(codeOf(() => requireCardIds([])), PERR.BAD_MESSAGE);
  assert.equal(codeOf(() => requireCardIds(['7H', '7S', '7D', '7C', '9H'])), PERR.BAD_MESSAGE);
  assert.equal(codeOf(() => requireCardIds(['7H', '7H'])), PERR.BAD_MESSAGE);
  assert.equal(codeOf(() => requireCardIds(['1H'])), PERR.BAD_MESSAGE);
  assert.equal(codeOf(() => requireCardIds(['7X'])), PERR.BAD_MESSAGE);
  assert.equal(codeOf(() => requireCardIds(['__proto__'])), PERR.BAD_MESSAGE);
  assert.deepEqual(requireCardIds(['10D', '2H']), ['10D', '2H']);
});

test('the rate limiter allows a burst then clamps, and recovers next second', () => {
  const allow = makeRateLimiter(3);
  assert.deepEqual([allow(0), allow(0), allow(0), allow(0)], [true, true, true, false]);
  assert.equal(allow(1001), true, 'a new window');
});

// ------------------------------------------------------------------ rooms

const lobbyOf = (n = 3, maxPlayers = 5) => {
  const room = new Room('K7QM', { maxPlayers, now: T0 });
  const seats = [];
  for (let i = 0; i < n; i++) seats.push(room.join(`P${i + 1}`, T0));
  return { room, seats };
};

test('the first player to join becomes the host and takes seat 0', () => {
  const { room, seats } = lobbyOf(3);
  assert.equal(room.hostSeatId, 0);
  assert.deepEqual(seats.map((s) => s.seatId), [0, 1, 2]);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.roomView().canStart, true);
});

test('a room will not start with one player and will not overfill', () => {
  const { room } = lobbyOf(1);
  assert.equal(room.roomView().canStart, false);
  assert.equal(codeOf(() => room.startGame(0, T0)), PERR.NOT_ENOUGH_PLAYERS);

  const full = new Room('AAAA', { maxPlayers: 2, now: T0 });
  full.join('a', T0);
  full.join('b', T0);
  assert.equal(codeOf(() => full.join('c', T0)), PERR.ROOM_FULL);
});

test('only the host may change the player count or start the game', () => {
  const { room } = lobbyOf(3);
  assert.equal(codeOf(() => room.setMaxPlayers(1, 4)), PERR.NOT_HOST);
  assert.equal(codeOf(() => room.startGame(2, T0)), PERR.NOT_HOST);
  room.setMaxPlayers(0, 4);
  assert.equal(room.maxPlayers, 4);
});

test('the player count cannot be set below the people already seated', () => {
  const { room } = lobbyOf(4);
  assert.equal(codeOf(() => room.setMaxPlayers(0, 3)), PERR.BAD_PLAYER_COUNT);
  room.setMaxPlayers(0, 4);
  assert.equal(room.maxPlayers, 4);
});

test('a freed lobby seat is handed to the next joiner', () => {
  const { room } = lobbyOf(3);
  room.disconnect(1, T0);
  assert.deepEqual(room.seats.map((s) => s.seatId), [0, 2]);
  const seat = room.join('Newcomer', T0);
  assert.equal(seat.seatId, 1, 'the gap is filled before seat 3');
});

test('nobody can join a game already in progress', () => {
  const { room } = lobbyOf(3);
  room.startGame(0, T0);
  assert.equal(codeOf(() => room.join('latecomer', T0)), PERR.GAME_IN_PROGRESS);
  assert.equal(codeOf(() => room.setMaxPlayers(0, 4)), PERR.GAME_IN_PROGRESS);
  assert.equal(codeOf(() => room.startGame(0, T0)), PERR.GAME_IN_PROGRESS);
});

test('starting deals a game whose seat order matches the room', () => {
  const { room } = lobbyOf(3);
  const game = room.startGame(0, T0);
  assert.deepEqual(game.seatOrder, [0, 1, 2]);
  // Dealing *is* starting: there is no phase between the two.
  assert.equal(room.phase, 'playing');
  assert.equal(game.gameId, 1);
  assert.ok(game.seatOrder.includes(game.startingSeat), 'somebody is already on turn');
  for (const seat of game.seatOrder) assert.equal(game.players[seat].hand.length, 3);
});

test('seat ids survive a gap, so a game can run on seats 0 and 2', () => {
  const { room } = lobbyOf(3);
  room.disconnect(1, T0);
  const game = room.startGame(0, T0);
  assert.deepEqual(game.seatOrder, [0, 2]);
  assert.ok(game.players[2]);
  assert.equal(game.players[1], undefined);
});

test('a resume token restores the seat mid-game', () => {
  const { room, seats } = lobbyOf(2);
  room.startGame(0, T0);
  room.disconnect(1, T0 + 1000);

  assert.equal(room.seat(1).connected, false);
  assert.ok(room.seats.some((s) => s.seatId === 1), 'the seat is held, not released');

  const back = room.resume(seats[1].resumeToken, T0 + 2000);
  assert.equal(back.seatId, 1);
  assert.equal(room.seat(1).connected, true);
  assert.equal(codeOf(() => room.resume('deadbeef'.repeat(4), T0)), PERR.BAD_TOKEN);
});

test('the host migrates to the lowest connected seat', () => {
  const { room } = lobbyOf(3);
  room.startGame(0, T0);
  room.disconnect(0, T0 + 1000);
  assert.equal(room.hostSeatId, 1);
  room.disconnect(1, T0 + 2000);
  assert.equal(room.hostSeatId, 2);
});

test('leaving mid-game forfeits the seat and can end the game', () => {
  const { room } = lobbyOf(2);
  room.startGame(0, T0);
  const { events } = room.leave(1, T0 + 1000);
  assert.ok(events.some((e) => e.e === 'forfeit'));
  assert.equal(room.game.phase, 'gameover');
  assert.equal(room.game.loser, 0);
  assert.equal(room.seats.length, 1);
});

test('session scores accumulate across games and derive wins', () => {
  const { room } = lobbyOf(3);
  for (const loser of [2, 2, 1]) {
    room.startGame(0, T0);
    // short-circuit to a finished game rather than playing one out
    room.game.phase = 'gameover';
    room.game.loser = loser;
    room.recordResult();
  }

  const board = room.scoreboard();
  assert.deepEqual(board.map((r) => r.seatId), [0, 1, 2], 'fewest losses first');
  assert.deepEqual(board.map((r) => [r.games, r.wins, r.losses]), [
    [3, 3, 0],
    [3, 2, 1],
    [3, 1, 2],
  ]);
});

test('a result is recorded once, however often the game-over is seen', () => {
  const { room } = lobbyOf(2);
  room.startGame(0, T0);
  room.game.loser = 1;
  room.recordResult();
  room.recordResult();
  room.recordResult();
  assert.equal(room.scores[0].games, 1);
  assert.equal(room.scores[1].losses, 1);
});

test('back to lobby keeps the seats and the scoreboard', () => {
  const { room } = lobbyOf(3);
  room.startGame(0, T0);
  room.game.phase = 'gameover';
  room.game.loser = 1;
  room.recordResult();

  room.backToLobby(0);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.game, null);
  assert.equal(room.seats.length, 3);
  assert.equal(room.scoreboard().find((r) => r.seatId === 1).losses, 1);
  assert.equal(room.roomView().gamesStarted, 1);
});

test('a rematch reuses the seats and bumps the game id', () => {
  const { room } = lobbyOf(3);
  room.startGame(0, T0);
  room.game.phase = 'gameover';
  const second = room.startGame(0, T0 + 1000);
  assert.equal(second.gameId, 2);
  assert.deepEqual(second.seatOrder, [0, 1, 2]);
  assert.equal(room.seats.every((s) => s.playAgainReady === false), true);
});

test('the stuck-seat nudge unlocks only for a disconnected player on turn', () => {
  const { room } = lobbyOf(2);
  room.startGame(0, T0);
  const onTurn = room.game.current;
  const offTurn = onTurn === 0 ? 1 : 0;

  assert.equal(room.stuckSeat(T0), null, 'nobody has dropped');
  room.disconnect(offTurn, T0);
  assert.equal(room.stuckSeat(T0 + LIMITS.STUCK_SEAT_MS + 1), null, 'not their turn');

  room.disconnect(onTurn, T0);
  assert.equal(room.stuckSeat(T0 + 1000), null, 'too soon');
  assert.equal(room.stuckSeat(T0 + LIMITS.STUCK_SEAT_MS + 1), onTurn);
});

test('the stall clock restarts whenever the turn actually moves', () => {
  const { room } = lobbyOf(2);
  room.startGame(0, T0);
  const seat = room.game.current;
  room.disconnect(seat, T0);
  assert.equal(room.stuckSeat(T0 + LIMITS.STUCK_SEAT_MS + 1), seat);

  room.afterEngine([{ e: 'turn', seat }], T0 + LIMITS.STUCK_SEAT_MS + 1);
  assert.equal(room.stuckSeat(T0 + LIMITS.STUCK_SEAT_MS + 2), null, 'clock reset');
});

test('a room view carries seats and scores but never a card', () => {
  const { room } = lobbyOf(3);
  const view = room.roomView();
  assert.equal(view.t, 'room');
  assert.equal(view.code, 'K7QM');
  assert.equal(view.seats[0].isHost, true);
  assert.equal(JSON.stringify(view).includes('rank'), false);
});

test('a game view is per seat, and only reaches the seat it belongs to', () => {
  const { room } = lobbyOf(2);
  room.startGame(0, T0);
  const a = room.viewFor(0, [], T0);
  const b = room.viewFor(1, [], T0);

  assert.equal(a.you, 0);
  assert.equal(b.you, 1);
  assert.equal(a.roomCode, 'K7QM');
  assert.equal(a.hostSeatId, 0);
  const own = JSON.stringify(a.players.find((p) => p.seatId === 0).hand.map((c) => c.id));
  assert.equal(JSON.stringify(b).includes(own.slice(2, 6)), false, 'seat 1 cannot see seat 0');
});

// ------------------------------------------------------------- manager / GC

test('the manager hands out distinct codes and finds rooms by code', () => {
  const rooms = new RoomManager();
  const a = rooms.create({ now: T0 });
  const b = rooms.create({ now: T0 });
  assert.notEqual(a.code, b.code);
  assert.equal(rooms.get(a.code), a);
  assert.equal(rooms.get('ZZZZ'), null);
  assert.equal(codeOf(() => rooms.require('ZZZZ')), PERR.NO_ROOM);
  assert.equal(rooms.size, 2);
});

test('an empty room is collected immediately', () => {
  const rooms = new RoomManager();
  const room = rooms.create({ now: T0 });
  assert.deepEqual(rooms.sweep(T0), [room.code]);
  assert.equal(rooms.size, 0);
});

test('a room with anyone connected is never collected', () => {
  const rooms = new RoomManager();
  const room = rooms.create({ now: T0 });
  room.join('Ana', T0);
  assert.deepEqual(rooms.sweep(T0 + LIMITS.IDLE_ROOM_MS * 10), []);
});

test('an abandoned room is collected sooner if no game ever started', () => {
  const rooms = new RoomManager();
  const never = rooms.create({ now: T0 });
  never.join('Ana', T0);
  never.seat(0).connected = false;

  const played = rooms.create({ now: T0 });
  played.join('Bob', T0);
  played.join('Cy', T0);
  played.startGame(0, T0);
  for (const s of played.seats) s.connected = false;

  const mid = T0 + LIMITS.UNSTARTED_ROOM_MS + 1;
  assert.deepEqual(rooms.sweep(mid), [never.code], 'the unplayed room goes first');
  assert.deepEqual(rooms.sweep(T0 + LIMITS.IDLE_ROOM_MS + 1), [played.code]);
  assert.equal(rooms.size, 0);
});
