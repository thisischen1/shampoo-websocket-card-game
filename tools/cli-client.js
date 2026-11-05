#!/usr/bin/env node
// A terminal client for Shampoo, so the protocol can be played before any UI
// exists. It knows only what the server tells it — the same redacted view the
// browser will get — which makes it a working proof that the view is complete
// enough to play from.
//
//   node tools/cli-client.js --name Ana --create --players 3
//   node tools/cli-client.js --name Bob --join K7QM
//
// Commands once seated:
//   start                 host: deal and begin
//   p 1 / p 1 2 / p a     play hand cards by number, face-up cards by letter
//   take                  pick up the pile
//   f                     flip a face-down card
//   again / next          postgame: ready up / host deals the next game
//   name <text>  players <n>  look  leave  quit

import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { C, S, PROTOCOL_VERSION } from '../src/shared/protocol.js';

// ------------------------------------------------------------------- options

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(`--${name}`);

if (has('help')) {
  // The usage block at the top of this file is the only copy of the help text.
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  const end = lines.findIndex((line) => !line.startsWith('//'));
  console.log(lines.slice(0, end).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const host = flag('host', process.env.SHAMPOO_HOST ?? 'localhost');
const port = flag('port', process.env.PORT ?? 3000);
const url = flag('url', `ws://${host}:${port}/ws`);
const name = String(flag('name', `Player${Math.floor(Math.random() * 90) + 10}`));
const players = Number(flag('players', 3));
const joinCode = flag('join');
const resumeWith = flag('resume');

if (!has('create') && !joinCode) {
  console.error('Pass --create [--players n] or --join CODE [--resume TOKEN]. --help for more.');
  process.exit(1);
}

// --------------------------------------------------------------- presentation

const C_ = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const GLYPH = { H: '♥', D: '♦', S: '♠', C: '♣' };
const card = (c) => {
  if (!c) return C_.dim('—');
  const face = `${c.rank}${GLYPH[c.suit]}`;
  return c.suit === 'H' || c.suit === 'D' ? C_.red(face) : face;
};
const LETTERS = 'abcdef';

let view = null;      // last `state` frame
let room = null;      // last `room` frame
let me = null;        // last `welcome` frame

function showRoom() {
  if (!room || room.left) return;
  console.log(`\n  room ${C_.bold(room.code)}  ${room.phase}`);
  for (const s of room.seats) {
    const dot = s.connected ? C_.green('●') : C_.dim('○');
    const crown = s.isHost ? ' (host)' : '';
    const you = s.seatId === me?.you ? C_.cyan(' ← you') : '';
    const ready = s.playAgainReady ? C_.yellow(' ready') : '';
    console.log(`  ${dot} ${s.seatId}. ${s.name}${crown}${ready}${you}`);
  }
  if (room.scoreboard?.some((r) => r.games > 0)) {
    console.log(C_.dim('  name            games wins losses'));
    for (const r of room.scoreboard) {
      console.log(C_.dim(`  ${r.name.padEnd(15)} ${String(r.games).padStart(5)}`
        + `${String(r.wins).padStart(5)}${String(r.losses).padStart(7)}`));
    }
  }
  if (room.canStart && room.hostSeatId === me?.you) console.log(C_.yellow('  type `start`'));
}

function showTable() {
  if (!view) return;
  const mine = view.players.find((p) => p.seatId === view.you);
  console.log('');

  for (const p of view.players) {
    if (p.seatId === view.you) continue;
    const turn = view.current === p.seatId && view.phase === 'playing' ? C_.yellow('▶') : ' ';
    const dot = p.connected ? '' : C_.dim(' (away)');
    const status = p.out ? C_.green(` out #${p.place}`) : '';
    console.log(`${turn} ${p.name}${dot}${status}  hand ${p.handCount}`
      + `  down ${p.faceDownCount}  up ${p.faceUp.map(card).join(' ') || C_.dim('—')}`);
  }

  const pile = view.pile.count
    ? `${card(view.pile.top)} ${C_.dim(`(${view.pile.count})`)}`
    : C_.dim('empty');
  console.log(`\n  stock ${view.stock.count}   pile ${pile}   burned ${view.burnedCount}`);

  if (!mine) return console.log(C_.dim('  (spectating)'));

  const mark = (c) => {
    const bomb = view.me.bombCardIds.includes(c.id) ? C_.yellow('*') : '';
    const lock = view.me.playableCardIds.includes(c.id) ? '' : C_.dim('·');
    return `${card(c)}${bomb}${lock}`;
  };
  console.log(`  your up   ${mine.faceUp.map((c, i) => `${LETTERS[i]}:${mark(c)}`).join('  ')
    || C_.dim('—')}`);
  console.log(`  your down ${'▨ '.repeat(mine.faceDownCount) || C_.dim('—')}`);
  console.log(`  your hand ${mine.hand.map((c, i) => `${i + 1}:${mark(c)}`).join('  ')
    || C_.dim('—')}`);

  if (view.phase === 'gameover') {
    const loser = view.players.find((p) => p.seatId === view.loser);
    console.log(view.loser === view.you
      ? C_.red(`\n  You lose. Order: ${view.finishedOrder.join(', ')}`)
      : C_.green(`\n  ${loser?.name ?? 'Someone'} loses. You placed `
        + `#${mine.place ?? '—'}`));
    console.log(C_.yellow('  `again` to ready up, host types `next`'));
  } else if (view.me.yourTurn) {
    const can = [];
    if (view.me.mustFlip) can.push('`f` to flip');
    else if (view.me.playableCardIds.length) can.push('`p <n...>` to play');
    if (view.me.canPickUp) can.push('`take` the pile');
    console.log(C_.yellow(`  YOUR TURN — ${can.join(', ') || 'nothing but to take the pile'}`));
  } else {
    const who = view.players.find((p) => p.seatId === view.current);
    console.log(C_.dim(`  waiting for ${who?.name ?? `seat ${view.current}`}`));
  }
}

const EVENT_TEXT = {
  dealt: () => 'cards dealt',
  // `gameStart` is deliberately silent: the server sends a notice naming the
  // starter, and printing both says the same thing twice.
  played: (e, n) => `${n(e.seat)} played ${e.cards.map(card).join(' ')}`,
  drew: (e, n) => `${n(e.seat)} drew ${e.count}`,
  burned: (e, n) => C_.yellow(`${n(e.seat)} burned the pile (${e.count}) — ${e.reason}`),
  pickedUp: (e, n) => `${n(e.seat)} took the pile (${e.count})`,
  flipped: (e, n) => `${n(e.seat)} flips a card…`,
  flipSuccess: (e, n) => `${n(e.seat)} flipped ${card(e.card)} — it stays`,
  flipFail: (e, n) => `${n(e.seat)} flipped ${card(e.card)} and took ${e.taken}`,
  playerOut: (e, n) => C_.green(`${n(e.seat)} is out (#${e.place})`),
  forfeit: (e, n) => `${n(e.seat)} forfeited`,
  turn: (e, n) => (e.extra ? C_.cyan(`${n(e.seat)} goes again (${e.extraReason})`) : null),
  gameOver: (e, n) => C_.bold(`game over — ${n(e.loser)} loses`),
};

function showEvents(events = []) {
  const nameOf = (seat) => (seat === view?.you
    ? 'you'
    : view?.players.find((p) => p.seatId === seat)?.name ?? `seat ${seat}`);
  for (const e of events) {
    const line = EVENT_TEXT[e.e]?.(e, nameOf);
    if (line) console.log(C_.dim('  · ') + line);
  }
}

// ------------------------------------------------------------------- commands

const ws = new WebSocket(url);

// Piped input arrives faster than the handshake, so a command can land while
// the socket is still CONNECTING. Queue until open rather than throwing.
const pending = [];
const send = (t, body = {}) => {
  const frame = JSON.stringify({ t, ...body });
  if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  else pending.push(frame);
};
const seq = () => view?.turnSeq ?? 0;

/** Resolve `1 2` / `a b` into card ids, one zone only — mixing is illegal. */
function resolveCards(tokens) {
  const mine = view?.players.find((p) => p.seatId === view.you);
  if (!mine) return { error: 'no cards' };
  const ids = [];
  let zone = null;
  for (const token of tokens) {
    const asLetter = LETTERS.indexOf(token.toLowerCase());
    const asNumber = Number(token);
    let found;
    if (asLetter !== -1 && !/^\d+$/.test(token)) {
      if (zone === 'hand') return { error: 'one zone per play' };
      zone = 'faceUp';
      found = mine.faceUp[asLetter];
    } else if (Number.isInteger(asNumber) && asNumber >= 1) {
      if (zone === 'faceUp') return { error: 'one zone per play' };
      zone = 'hand';
      found = mine.hand[asNumber - 1];
    }
    if (!found) return { error: `no card at "${token}"` };
    ids.push(found.id);
  }
  return ids.length ? { ids } : { error: 'name at least one card' };
}

const COMMANDS = {
  start: () => send(C.START_GAME),
  next: () => send(C.START_NEXT_GAME),
  again: () => send(C.PLAY_AGAIN_READY, { ready: true }),
  take: () => send(C.PICK_UP_PILE, { turnSeq: seq() }),
  f: (args) => send(C.FLIP_FACE_DOWN, { index: Number(args[0] ?? 0) || 0, turnSeq: seq() }),
  look: () => (view ? showTable() : showRoom()),
  leave: () => send(C.LEAVE_ROOM),
  name: (args) => send(C.SET_NAME, { name: args.join(' ') }),
  players: (args) => send(C.SET_MAX_PLAYERS, { maxPlayers: Number(args[0]) }),
  nudge: (args) => send(C.PICK_UP_FOR_SEAT, { seatId: Number(args[0]), turnSeq: seq() }),
  boot: (args) => send(C.FORFEIT_SEAT, { seatId: Number(args[0]) }),
  quit: () => process.exit(0),

  p: (args) => {
    const { ids, error } = resolveCards(args);
    if (error) return console.log(C_.red(`  ${error}`));
    send(C.PLAY_CARDS, { cardIds: ids, turnSeq: seq() });
  },
};
COMMANDS.l = COMMANDS.look;
COMMANDS.t = COMMANDS.take;
COMMANDS.r = COMMANDS.ready;

// --------------------------------------------------------------------- wiring

ws.on('open', () => {
  if (resumeWith && joinCode) {
    send(C.RESUME, { code: String(joinCode), resumeToken: String(resumeWith) });
  } else if (joinCode) {
    send(C.JOIN_ROOM, { code: String(joinCode), name });
  } else {
    send(C.CREATE_ROOM, { name, maxPlayers: players });
  }
  // Flush last: anything typed during the handshake must land behind the
  // join, or it would be acted on before this client holds a seat.
  while (pending.length) ws.send(pending.shift());
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString('utf8'));
  switch (msg.t) {
    case S.WELCOME:
      me = msg;
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        console.log(C_.red(`  protocol ${msg.protocolVersion} != ${PROTOCOL_VERSION} — update me`));
        process.exit(1);
      }
      console.log(`\n  joined ${C_.bold(msg.roomCode)} as seat ${msg.you}`
        + `${msg.isHost ? ' (host)' : ''}`);
      console.log(C_.dim(`  resume: --join ${msg.roomCode} --resume ${msg.resumeToken}`));
      break;

    case S.ROOM:
      room = msg;
      if (msg.left) console.log(C_.dim('\n  you left the room'));
      else if (!view || view.phase === 'gameover') showRoom();
      break;

    case S.STATE:
      showEvents(msg.events);
      view = msg;
      showTable();
      break;

    case S.NOTICE:
      console.log(C_.cyan(`  ${msg.text}`));
      break;

    case S.ERROR:
      console.log(C_.red(`  ${msg.message}${msg.detail ? ` (${msg.detail})` : ''}`));
      if (msg.fatal) process.exit(1);
      break;

    default:
      break;
  }
  rl.prompt(true);
});

ws.on('close', () => {
  console.log(C_.dim('\n  disconnected'));
  process.exit(0);
});
ws.on('error', (e) => {
  console.error(C_.red(`  cannot reach ${url}: ${e.message}`));
  process.exit(1);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.on('line', (line) => {
  const [word, ...args] = line.trim().split(/\s+/);
  if (word) {
    const run = COMMANDS[word.toLowerCase()];
    if (run) run(args);
    else console.log(C_.dim(`  unknown: ${word} — try look, p, take, f, ready, start`));
  }
  rl.prompt();
});
rl.on('close', () => process.exit(0));
