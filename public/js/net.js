// The socket, and the reconnect policy around it.
//
// The server is authoritative and sends a full snapshot on every change, so
// reconnecting needs no reconciliation: drop the old socket, resume the seat,
// and render whatever comes back.

import { C, S, PROTOCOL_VERSION } from '/shared/protocol.js';

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 8000;

export function createNet({ onFrame, onStatus, onOpen }) {
  let ws = null;
  let attempt = 0;
  let retryTimer = null;
  let stopped = false;

  const url = () => {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}/ws`;
  };

  function connect() {
    if (stopped) return;
    clearTimeout(retryTimer);
    onStatus(attempt === 0 ? 'connecting' : 'retrying');

    ws = new WebSocket(url());

    ws.addEventListener('open', () => {
      attempt = 0;
      onStatus('open');
      onOpen();
    });

    ws.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return; // a frame we cannot parse is a frame we cannot act on
      }
      if (frame.t === S.WELCOME && frame.protocolVersion !== PROTOCOL_VERSION) {
        // A tab left open across a deploy. Nothing it does from here is safe.
        stopped = true;
        ws.close();
        onStatus('fatal');
        onFrame({
          t: S.ERROR,
          code: 'ERR_BAD_VERSION',
          message: 'This page is out of date. Please reload.',
          fatal: true,
        });
        return;
      }
      onFrame(frame);
    });

    ws.addEventListener('close', () => {
      if (stopped) return;
      // Jittered, so a server restart does not bring every client back at once.
      const base = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** attempt);
      const wait = base / 2 + Math.random() * (base / 2);
      attempt += 1;
      onStatus('retrying');
      retryTimer = setTimeout(connect, wait);
    });

    // 'close' always follows 'error', so the retry is already handled.
    ws.addEventListener('error', () => {});
  }

  return {
    connect,

    /**
     * Fire and forget. There is no send queue by design: every client message
     * is a request about the current board, and a board that has since changed
     * makes the request wrong. Anything dropped by a disconnect is better
     * re-decided by the player once the fresh snapshot arrives.
     */
    send(t, body = {}) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t, ...body }));
        return true;
      }
      return false;
    },

    close() {
      stopped = true;
      clearTimeout(retryTimer);
      ws?.close();
    },

    get ready() {
      return ws?.readyState === WebSocket.OPEN;
    },
  };
}

export { C, S };
