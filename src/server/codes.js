// Room codes. Four characters, read aloud over a phone without ambiguity.

import { randomBytes } from 'node:crypto';
import { LIMITS } from '../shared/protocol.js';

// No 0/O, no 1/I/L, no 5/S, no 2/Z, no 8/B — the pairs people mishear or mistype.
export const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY3467';

export function makeCode(len = LIMITS.CODE_LEN) {
  // Rejection sampling, so every letter is equally likely (256 % 24 !== 0).
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < len) {
    for (const byte of randomBytes(len * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
}

/**
 * A code that is not already taken. `isTaken` is injected so this stays pure
 * enough to test. After enough collisions we lengthen rather than spin forever.
 */
export function uniqueCode(isTaken, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const code = makeCode();
    if (!isTaken(code)) return code;
  }
  for (let len = LIMITS.CODE_LEN + 1; len <= 8; len++) {
    for (let i = 0; i < attempts; i++) {
      const code = makeCode(len);
      if (!isTaken(code)) return code;
    }
  }
  throw new Error('could not allocate a room code');
}

/**
 * Normalise what the user typed: uppercase, then drop anything outside the
 * alphabet. Since both halves of every confusable pair are excluded (O and 0,
 * I/L and 1, S and 5...) there is nothing to remap: punctuation and spacing
 * simply fall away, so "k7-qm" and " K7QM " both resolve.
 */
export function normalizeCode(input) {
  if (typeof input !== 'string') return '';
  return [...input.toUpperCase()].filter((ch) => ALPHABET.includes(ch)).join('').slice(0, 8);
}

export function resumeToken() {
  return randomBytes(16).toString('hex');
}
