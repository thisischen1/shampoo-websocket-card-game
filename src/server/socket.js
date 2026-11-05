// WebSocket lifecycle, message routing, rate limiting and broadcast.
//
// Every client->server message lands in ROUTES. Each handler validates its
// payload, calls into the room, and the caller broadcasts afterwards — so there
// is exactly one place that decides what each seat gets to see.

import { WebSocketServer } from 'ws';
import { ERR } from '../game/engine.js';
import { C, S, PERR, LIMITS, PROTOCOL_VERSION, ERROR_TEXT } from '../shared/protocol.js';
import { RoomManager } from './rooms.js';
import {
  BadInput, parseFrame, makeRateLimiter, cleanName,
  requireCode, requirePlayerCount, requireToken, requireCardIds,
  requireTurnSeq, requireSeatId,
} from './validate.js';

export function attachSockets(server, {
  rooms = new RoomManager(),
  now = () => Date.now(),
  // Generous for a human — a player cannot tap 25 times a second — but it does
  // cap a scripted client, so the integration harness raises it to drive a game
  // at machine speed instead of spending the whole test sleeping.
  maxMsgsPerSec = LIMITS.MAX_MSGS_PER_SEC,
  // How often rooms are re-checked for a stalled seat. Injectable so the test
  // for it can run at speed instead of sleeping through a real interval.
  stallPollMs = 5_000,
} = {}) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.MAX_FRAME_BYTES });
  const clients = new Set();

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const fail = (ws, code, detail, fatal = false) => {
    send(ws, {
      t: S.ERROR,
      code,
      message: ERROR_TEXT[code] ?? 'Something went wrong.',
      detail,
      fatal,
    });
  };

  /** Push the right view to every seat in a room. The only broadcast path. */
  const broadcast = (room, events = []) => {
    const ts = now();
    for (const client of clients) {
      if (client.room !== room) continue;
      if (room.game) send(client.ws, room.viewFor(client.seatId, events, ts));
      else send(client.ws, room.roomView());
    }
  };

  const notify = (room, text, kind = 'info') => {
    for (const client of clients) {
      if (client.room === room) send(client.ws, { t: S.NOTICE, text, kind });
    }
  };

  const requireRoom = (client) => {
    if (!client.room || client.seatId === null) throw new BadInput(PERR.NOT_IN_ROOM);
    return client.room;
  };

  // An existing connection cannot silently abandon its seat by creating or
  // joining a second room; it has to leave first.
  const requireNoRoom = (client) => {
    if (client.room) throw new BadInput(PERR.BAD_MESSAGE, 'already in a room');
  };

  const welcome = (client, room, seat) => {
    client.room = room;
    client.seatId = seat.seatId;
    send(client.ws, {
      t: S.WELCOME,
      protocolVersion: PROTOCOL_VERSION,
      roomCode: room.code,
      you: seat.seatId,
      resumeToken: seat.resumeToken,
      isHost: room.hostSeatId === seat.seatId,
    });
  };

  // ------------------------------------------------------------------ routes

  const ROUTES = {
    [C.PING]: (client) => send(client.ws, { t: S.PONG }),

    [C.CREATE_ROOM]: (client, msg) => {
      requireNoRoom(client);
      const maxPlayers = requirePlayerCount(msg.maxPlayers ?? LIMITS.MAX_PLAYERS);
      const room = rooms.create({ maxPlayers, now: now() });
      const seat = room.join(msg.name, now());
      welcome(client, room, seat);
      broadcast(room);
    },

    [C.JOIN_ROOM]: (client, msg) => {
      requireNoRoom(client);
      const room = rooms.require(requireCode(msg.code));
      const seat = room.join(msg.name, now());
      welcome(client, room, seat);
      broadcast(room);
      notify(room, `${seat.name} joined`, 'join');
    },

    [C.RESUME]: (client, msg) => {
      requireNoRoom(client);
      const room = rooms.require(requireCode(msg.code));
      const seat = room.resume(requireToken(msg.resumeToken), now());
      // Boot any stale connection still holding this seat, or two tabs fight.
      for (const other of clients) {
        if (other !== client && other.room === room && other.seatId === seat.seatId) {
          other.room = null;
          other.seatId = null;
          fail(other.ws, PERR.BAD_TOKEN, 'seat taken over by another tab', true);
        }
      }
      welcome(client, room, seat);
      broadcast(room);
    },

    [C.SET_NAME]: (client, msg) => {
      const room = requireRoom(client);
      room.setName(client.seatId, cleanName(msg.name));
      broadcast(room);
    },

    [C.SET_MAX_PLAYERS]: (client, msg) => {
      const room = requireRoom(client);
      room.setMaxPlayers(client.seatId, requirePlayerCount(msg.maxPlayers));
      broadcast(room);
    },

    [C.START_GAME]: (client) => {
      beginGame(requireRoom(client), client.seatId);
    },

    [C.PLAY_CARDS]: (client, msg) => {
      const room = requireRoom(client);
      const res = room.engineAction({
        type: 'PLAY',
        seat: client.seatId,
        cardIds: requireCardIds(msg.cardIds),
        turnSeq: requireTurnSeq(msg.turnSeq),
      }, now());
      if (!res.ok) return rejectPlay(client, room, res);
      broadcast(room, res.events);
    },

    [C.PICK_UP_PILE]: (client, msg) => {
      const room = requireRoom(client);
      const res = room.engineAction({
        type: 'PICKUP',
        seat: client.seatId,
        turnSeq: requireTurnSeq(msg.turnSeq),
      }, now());
      if (!res.ok) return rejectPlay(client, room, res);
      broadcast(room, res.events);
    },

    [C.FLIP_FACE_DOWN]: (client, msg) => {
      const room = requireRoom(client);
      const index = Number(msg.index);
      if (!Number.isInteger(index) || index < 0 || index > 2) {
        throw new BadInput(PERR.BAD_MESSAGE, 'bad flip index');
      }
      const res = room.engineAction({
        type: 'FLIP',
        seat: client.seatId,
        index,
        turnSeq: requireTurnSeq(msg.turnSeq),
      }, now());
      if (!res.ok) return rejectPlay(client, room, res);
      broadcast(room, res.events);
    },

    [C.PICK_UP_FOR_SEAT]: (client, msg) => {
      const room = requireRoom(client);
      room.requireHost(client.seatId);
      const seatId = requireSeatId(msg.seatId);
      // Guarded hard: this is the one action one player may take for another, so
      // it is only unlocked once that seat has actually gone quiet mid-turn.
      if (room.stuckSeat(now()) !== seatId) throw new BadInput(PERR.TOO_SOON);
      const res = room.engineAction({
        type: 'PICKUP', seat: seatId, turnSeq: requireTurnSeq(msg.turnSeq),
      }, now());
      if (!res.ok) return fail(client.ws, res.error, res.detail);
      notify(room, `${room.seat(seatId)?.name ?? 'A player'} had the pile taken for them`, 'nudge');
      broadcast(room, res.events);
    },

    [C.FORFEIT_SEAT]: (client, msg) => {
      const room = requireRoom(client);
      room.requireHost(client.seatId);
      const seatId = requireSeatId(msg.seatId);
      const seat = room.seat(seatId);
      if (!seat) throw new BadInput(PERR.NOT_IN_ROOM);
      if (seat.connected) throw new BadInput(PERR.SEAT_CONNECTED);
      const res = room.engineAction({ type: 'FORFEIT', seat: seatId }, now());
      if (!res.ok) return fail(client.ws, res.error, res.detail);
      notify(room, `${seat.name} was removed from the game`, 'forfeit');
      broadcast(room, res.events);
    },

    [C.PLAY_AGAIN_READY]: (client, msg) => {
      const room = requireRoom(client);
      room.playAgain(client.seatId, msg.ready !== false);
      broadcast(room);
    },

    [C.START_NEXT_GAME]: (client) => {
      beginGame(requireRoom(client), client.seatId);
    },

    // Drops the finished game so broadcast() starts sending `room` frames
    // again, which is what moves everyone from the postgame screen back to the
    // lobby. Scores survive — they belong to the room, not the game.
    [C.BACK_TO_LOBBY]: (client) => {
      const room = requireRoom(client);
      room.backToLobby(client.seatId);
      broadcast(room);
    },

    [C.LEAVE_ROOM]: (client) => {
      const room = requireRoom(client);
      const seat = room.seat(client.seatId);
      const { events } = room.leave(client.seatId, now());
      client.room = null;
      client.seatId = null;
      send(client.ws, { t: S.ROOM, code: null, left: true, seats: [], scores: {} });
      if (room.seats.length === 0) return rooms.close(room.code);
      notify(room, `${seat?.name ?? 'A player'} left`, 'leave');
      broadcast(room, events);
    },
  };

  /**
   * Deal and start, which are now the same moment — there is no phase between
   * them. The engine picks the starter inside createGame, so the two events the
   * clients animate are reconstructed here from the fresh game rather than
   * returned by an action.
   */
  const beginGame = (room, seatId) => {
    const game = room.startGame(seatId, now());
    broadcast(room, [
      { e: 'dealt', gameId: game.gameId },
      { e: 'gameStart', startingSeat: game.startingSeat, reason: game.startReason },
    ]);

    const name = room.seat(game.startingSeat)?.name ?? `Seat ${game.startingSeat}`;
    // Deliberately vague: naming the card would leak a hand card.
    notify(room, game.startReason === 'lowestCard'
      ? `${name} has the lowest card and starts`
      : `${name} starts`, 'start');
  };

  /**
   * A rejected play deserves a resync, not just an error: the client's board was
   * wrong, or it tried something it should have known was illegal.
   */
  const rejectPlay = (client, room, res) => {
    fail(client.ws, res.error, res.detail);
    if (res.error === ERR.STALE || res.error === ERR.CARD_NOT_IN_ZONE) {
      send(client.ws, room.viewFor(client.seatId, [], now()));
    }
  };

  // ------------------------------------------------------------- connections

  wss.on('connection', (ws) => {
    const client = {
      ws, room: null, seatId: null, allow: makeRateLimiter(maxMsgsPerSec), alive: true,
    };
    clients.add(client);

    ws.on('pong', () => { client.alive = true; });

    ws.on('message', (raw) => {
      try {
        if (!client.allow(now())) return fail(ws, PERR.RATE_LIMIT);
        const msg = parseFrame(raw);
        const route = ROUTES[msg.t];
        if (!route) return fail(ws, PERR.BAD_MESSAGE, msg.t);
        route(client, msg);
      } catch (e) {
        if (e instanceof BadInput) return fail(ws, e.code, e.detail, e.code === PERR.BAD_VERSION);
        // A bug on our side must not take the process down mid-game.
        console.error('socket handler failed:', e);
        fail(ws, PERR.BAD_MESSAGE, 'server error');
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      const room = client.room;
      if (!room) return;
      room.disconnect(client.seatId, now());
      if (room.seats.length === 0) return rooms.close(room.code);
      broadcast(room);
    });

    ws.on('error', () => { /* 'close' always follows; nothing to do here */ });
  });

  // Keepalive. Platform proxies drop idle sockets at ~30 s, and a half-open
  // socket would otherwise look like a connected player who never moves.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try { client.ws.ping(); } catch { /* terminated between checks */ }
    }
  }, LIMITS.HEARTBEAT_MS);
  heartbeat.unref?.();

  // The host's stalled-seat buttons are driven by elapsed time, and time passing
  // sends no message. Without this poll the host would sit looking at a frozen
  // table while the very control that unfreezes it stayed hidden, because the
  // frame that would have revealed it is only cut when somebody acts.
  const lastStuck = new WeakMap();

  const stallPoll = setInterval(() => {
    const ts = now();
    for (const room of rooms.rooms.values()) {
      if (!room.game) continue;
      const stuck = room.stuckSeat(ts);
      if (lastStuck.get(room) === stuck) continue;
      lastStuck.set(room, stuck);
      broadcast(room);
    }
  }, stallPollMs);
  stallPoll.unref?.();

  const gc = setInterval(() => {
    for (const code of rooms.sweep(now())) console.log(`room ${code} collected`);
  }, 60_000);
  gc.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    clearInterval(stallPoll);
    clearInterval(gc);
    for (const client of clients) client.ws.terminate();
    clients.clear();
    wss.close();
  };

  return { wss, rooms, clients, close, broadcast };
}
