// Rooms: seats, host, session scores, resume tokens, garbage collection.
//
// This layer owns everything that survives a single game. It holds the engine
// state but never reaches into it except through applyAction(), and it never
// touches a socket — socket.js does the sending. That keeps rooms.js testable
// with plain objects.

import { randomBytes } from 'node:crypto';
import { createGame, applyAction, MIN_PLAYERS } from '../game/engine.js';
import { viewFor, roomView } from '../game/redact.js';
import { LIMITS, PERR } from '../shared/protocol.js';
import { uniqueCode, resumeToken } from './codes.js';
import { BadInput, cleanName } from './validate.js';

const bad = (code, detail) => { throw new BadInput(code, detail); };

// Deck seeds come from the CSPRNG, not Math.random(): V8's generator is
// recoverable from a handful of outputs, and the whole game rests on nobody
// being able to predict the shuffle.
const deckSeed = () => randomBytes(4).readUInt32BE(0);

export class Room {
  constructor(code, { maxPlayers = LIMITS.MAX_PLAYERS, now = Date.now() } = {}) {
    this.code = code;
    this.maxPlayers = maxPlayers;
    this.seats = [];          // only occupied seats, ascending by seatId
    this.hostSeatId = null;
    this.scores = {};         // seatId -> { games, losses }
    this.game = null;
    this.gamesStarted = 0;
    this.resultRecorded = false;
    this.createdAt = now;
    this.lastActivityAt = now;
    this.currentSeatSince = now;
  }

  // ------------------------------------------------------------- lifecycle

  get phase() {
    if (!this.game) return 'lobby';
    return this.game.phase; // 'playing' | 'gameover'
  }

  get inProgress() {
    return this.game !== null && this.game.phase !== 'gameover';
  }

  touch(now = Date.now()) {
    this.lastActivityAt = now;
  }

  seat(seatId) {
    return this.seats.find((s) => s.seatId === seatId) ?? null;
  }

  connectedSeats() {
    return this.seats.filter((s) => s.connected);
  }

  // ------------------------------------------------------------- membership

  join(name, now = Date.now()) {
    if (this.inProgress) bad(PERR.GAME_IN_PROGRESS);
    if (this.seats.length >= this.maxPlayers) bad(PERR.ROOM_FULL);

    const seatId = this.firstFreeSeatId();
    const seat = {
      seatId,
      name: cleanName(name, `Player ${seatId + 1}`),
      connected: true,
      resumeToken: resumeToken(),
      playAgainReady: false,
      lastSeen: now,
    };
    this.seats.push(seat);
    this.seats.sort((a, b) => a.seatId - b.seatId);
    this.scores[seatId] ??= { games: 0, losses: 0 };
    if (this.hostSeatId === null) this.hostSeatId = seatId;
    this.touch(now);
    return seat;
  }

  firstFreeSeatId() {
    for (let i = 0; i < this.maxPlayers; i++) {
      if (!this.seat(i)) return i;
    }
    bad(PERR.ROOM_FULL);
  }

  /** Reclaim a seat with its token. Works mid-game — that is the whole point. */
  resume(token, now = Date.now()) {
    const seat = this.seats.find((s) => s.resumeToken === token);
    if (!seat) bad(PERR.BAD_TOKEN);
    seat.connected = true;
    seat.lastSeen = now;
    this.touch(now);
    return seat;
  }

  disconnect(seatId, now = Date.now()) {
    const seat = this.seat(seatId);
    if (!seat) return;
    seat.connected = false;
    seat.lastSeen = now;
    // Outside a game there is nothing to preserve, so the seat is released and
    // the next joiner can have it.
    if (!this.inProgress) this.releaseSeat(seatId);
    if (this.hostSeatId === seatId) this.migrateHost();
    this.touch(now);
  }

  /** An explicit "leave": the seat goes, and mid-game that means a forfeit. */
  leave(seatId, now = Date.now()) {
    const seat = this.seat(seatId);
    if (!seat) return { events: [] };
    let events = [];
    if (this.inProgress && this.game.players[seatId]) {
      const res = applyAction(this.game, { type: 'FORFEIT', seat: seatId });
      if (res.ok) events = res.events;
      this.afterEngine(events, now);
    }
    this.releaseSeat(seatId);
    if (this.hostSeatId === seatId) this.migrateHost();
    this.touch(now);
    return { events };
  }

  releaseSeat(seatId) {
    this.seats = this.seats.filter((s) => s.seatId !== seatId);
    // Scores stay keyed by seatId so a rejoin under the same seat keeps them,
    // but an empty room forgets everything by being collected.
  }

  migrateHost() {
    const next = this.connectedSeats()[0] ?? this.seats[0] ?? null;
    this.hostSeatId = next ? next.seatId : null;
  }

  requireHost(seatId) {
    if (seatId !== this.hostSeatId) bad(PERR.NOT_HOST);
  }

  setName(seatId, name) {
    const seat = this.seat(seatId);
    if (!seat) bad(PERR.NOT_IN_ROOM);
    seat.name = cleanName(name, seat.name);
    this.touch();
    return seat.name;
  }

  setMaxPlayers(seatId, n) {
    this.requireHost(seatId);
    if (this.inProgress) bad(PERR.GAME_IN_PROGRESS);
    if (n < this.seats.length) bad(PERR.BAD_PLAYER_COUNT, 'already more players than that');
    this.maxPlayers = n;
    this.touch();
  }

  // ------------------------------------------------------------- games

  startGame(seatId, now = Date.now()) {
    this.requireHost(seatId);
    if (this.inProgress) bad(PERR.GAME_IN_PROGRESS);
    if (this.seats.length < MIN_PLAYERS) bad(PERR.NOT_ENOUGH_PLAYERS);

    this.gamesStarted++;
    this.game = createGame({
      seatOrder: this.seats.map((s) => s.seatId),
      seed: deckSeed(),
      gameId: this.gamesStarted,
    });
    this.resultRecorded = false;
    this.currentSeatSince = now;
    for (const s of this.seats) s.playAgainReady = false;
    this.touch(now);
    return this.game;
  }

  playAgain(seatId, ready = true) {
    const seat = this.seat(seatId);
    if (!seat) bad(PERR.NOT_IN_ROOM);
    seat.playAgainReady = ready !== false;
    this.touch();
  }

  /** Back to the lobby, scores intact — seats and the scoreboard both survive. */
  backToLobby(seatId) {
    this.requireHost(seatId);
    if (this.inProgress) bad(PERR.GAME_IN_PROGRESS);
    this.game = null;
    for (const s of this.seats) s.playAgainReady = false;
    this.touch();
  }

  // ------------------------------------------------------------- engine access

  /**
   * The only door into the engine. Returns the engine's own result object so
   * the socket layer can forward a rule error verbatim.
   */
  engineAction(action, now = Date.now()) {
    if (!this.game) bad(PERR.NOT_IN_ROOM, 'no game');
    const res = applyAction(this.game, action);
    if (res.ok) this.afterEngine(res.events, now);
    return res;
  }

  afterEngine(events, now = Date.now()) {
    this.touch(now);
    // Reset the stall clock whenever the turn actually moves, so "the current
    // player is stuck" means stuck on *this* turn.
    if (events.some((e) => e.e === 'turn' || e.e === 'gameStart')) this.currentSeatSince = now;
    if (events.some((e) => e.e === 'gameOver')) this.recordResult();
  }

  /**
   * Has the current player gone quiet long enough for the host to step in?
   * The host's only options are deliberately knowledge-free: take the pile, or
   * forfeit the seat. Nothing that requires seeing their cards.
   */
  stuckSeat(now = Date.now()) {
    if (!this.game || this.game.phase !== 'playing') return null;
    const seatId = this.game.current;
    const seat = this.seat(seatId);
    if (seat?.connected) return null;
    if (now - this.currentSeatSince < LIMITS.STUCK_SEAT_MS) return null;
    return seatId;
  }

  recordResult() {
    if (this.resultRecorded || !this.game) return;
    this.resultRecorded = true;
    for (const seatId of this.game.seatOrder) {
      this.scores[seatId] ??= { games: 0, losses: 0 };
      this.scores[seatId].games++;
    }
    if (this.game.loser !== null && this.scores[this.game.loser]) {
      this.scores[this.game.loser].losses++;
    }
  }

  /** Scoreboard rows, sorted the way the UI shows them: fewest losses first. */
  scoreboard() {
    return this.seats
      .map((s) => {
        const sc = this.scores[s.seatId] ?? { games: 0, losses: 0 };
        return {
          seatId: s.seatId,
          name: s.name,
          games: sc.games,
          losses: sc.losses,
          wins: sc.games - sc.losses,
        };
      })
      .sort((a, b) => a.losses - b.losses || b.games - a.games || a.seatId - b.seatId);
  }

  // ------------------------------------------------------------- views

  viewFor(seatId, events = [], now = Date.now()) {
    if (!this.game) return null;
    const view = viewFor(this.game, seatId, {
      seats: Object.fromEntries(this.seats.map((s) => [s.seatId, {
        name: s.name,
        connected: s.connected,
        isHost: s.seatId === this.hostSeatId,
        playAgainReady: s.playAgainReady === true,
      }])),
      scores: Object.fromEntries(this.scoreboard().map((r) => [r.seatId, r])),
      events,
    });
    view.roomCode = this.code;
    view.maxPlayers = this.maxPlayers;
    view.hostSeatId = this.hostSeatId;
    view.stuckSeat = this.stuckSeat(now);
    return view;
  }

  roomView() {
    const view = roomView(this);
    view.gamesStarted = this.gamesStarted;
    view.scoreboard = this.scoreboard();
    view.canStart = !this.inProgress && this.seats.length >= MIN_PLAYERS;
    return view;
  }

  // ------------------------------------------------------------- collection

  isExpired(now = Date.now()) {
    if (this.seats.length === 0) return true;
    if (this.connectedSeats().length > 0) return false;
    const idle = now - this.lastActivityAt;
    return this.gamesStarted === 0
      ? idle > LIMITS.UNSTARTED_ROOM_MS
      : idle > LIMITS.IDLE_ROOM_MS;
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  create({ maxPlayers = LIMITS.MAX_PLAYERS, now = Date.now() } = {}) {
    const code = uniqueCode((c) => this.rooms.has(c));
    const room = new Room(code, { maxPlayers, now });
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(code) ?? null;
  }

  require(code) {
    const room = this.get(code);
    if (!room) bad(PERR.NO_ROOM, code);
    return room;
  }

  close(code) {
    this.rooms.delete(code);
  }

  /** Drop rooms nobody is coming back to. Returns the codes collected. */
  sweep(now = Date.now()) {
    const gone = [];
    for (const [code, room] of this.rooms) {
      if (room.isExpired(now)) {
        this.rooms.delete(code);
        gone.push(code);
      }
    }
    return gone;
  }

  get size() {
    return this.rooms.size;
  }
}
