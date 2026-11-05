// Payload shape, length and charset checks.
//
// Everything a client sends is hostile until it has been through here. The
// engine then re-resolves card ids against its own state, so this layer only
// has to guarantee "well-formed", not "legal".

import { LIMITS, PERR } from '../shared/protocol.js';
import { normalizeCode } from './codes.js';

export class BadInput extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail;
  }
}

const bad = (code, detail) => { throw new BadInput(code, detail); };

/** Strip control characters and collapse whitespace; reject what's left if empty. */
export function cleanName(input, fallback = 'Player') {
  if (typeof input !== 'string') return fallback;
  // Whitespace collapses first: a newline inside a name should become a space,
  // not vanish and weld two words together.
  const cleaned = [...input.normalize('NFC').replace(/\s+/g, ' ')]
    // eslint-disable-next-line no-control-regex
    .filter((ch) => !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/.test(ch))
    .join('')
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length > LIMITS.MAX_NAME_LEN) return cleaned.slice(0, LIMITS.MAX_NAME_LEN);
  return cleaned;
}

export function requireCode(input) {
  const code = normalizeCode(input);
  if (code.length !== LIMITS.CODE_LEN) bad(PERR.NO_ROOM, 'bad code length');
  return code;
}

export function requirePlayerCount(input) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < LIMITS.MIN_PLAYERS || n > LIMITS.MAX_PLAYERS) {
    bad(PERR.BAD_PLAYER_COUNT, String(input));
  }
  return n;
}

export function requireToken(input) {
  if (typeof input !== 'string' || !/^[0-9a-f]{32}$/.test(input)) bad(PERR.BAD_TOKEN);
  return input;
}

/** A card-id list: 1..4 short uppercase strings, no duplicates. */
export function requireCardIds(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 4) {
    bad(PERR.BAD_MESSAGE, 'cardIds must be 1-4 entries');
  }
  const out = input.map((id) => {
    if (typeof id !== 'string' || !/^(?:[3-9]|10|[JQKA2])[HSDC]$/.test(id)) {
      bad(PERR.BAD_MESSAGE, `bad card id ${JSON.stringify(id)}`);
    }
    return id;
  });
  if (new Set(out).size !== out.length) bad(PERR.BAD_MESSAGE, 'duplicate card ids');
  return out;
}

export function requireTurnSeq(input) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0 || n > 1e9) bad(PERR.BAD_MESSAGE, 'bad turnSeq');
  return n;
}

export function requireSeatId(input) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0 || n >= LIMITS.MAX_PLAYERS) bad(PERR.BAD_MESSAGE, 'bad seatId');
  return n;
}

/** Parse a raw frame. Size is checked before the JSON parse, deliberately. */
export function parseFrame(raw) {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (bytes > LIMITS.MAX_FRAME_BYTES) bad(PERR.TOO_LARGE, `${bytes} bytes`);

  let msg;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch {
    bad(PERR.BAD_MESSAGE, 'not JSON');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) bad(PERR.BAD_MESSAGE, 'not an object');
  if (typeof msg.t !== 'string' || msg.t.length > 32) bad(PERR.BAD_MESSAGE, 'missing type');
  return msg;
}

/** A fixed-window counter. Cheap, and good enough to stop a runaway client. */
export function makeRateLimiter(perSecond = LIMITS.MAX_MSGS_PER_SEC) {
  let windowStart = 0;
  let count = 0;
  return function allow(now) {
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    count++;
    return count <= perSecond;
  };
}
