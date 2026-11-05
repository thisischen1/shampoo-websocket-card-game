// The first screen: pick a name, then create a room or join one by code.
//
// Each screen module builds its DOM once and returns an `update`. Re-rendering
// from scratch would fight the user — it would drop focus and wipe half-typed
// input on every frame the server sends.

import { LIMITS } from '/shared/protocol.js';
import { remembered } from '../store.js';

const CODE_BOXES = LIMITS.CODE_LEN;

export function createHome({ onCreate, onJoin }) {
  const el = document.createElement('section');
  el.className = 'screen home';
  el.innerHTML = `
    <div class="home-inner">
      <header class="masthead">
        <h1 class="brand">Shampoo</h1>
        <p class="tagline">Don't be the last one holding cards.</p>
      </header>

      <label class="field">
        <span class="field-label">Your name</span>
        <input class="input" id="home-name" type="text" autocomplete="nickname"
               maxlength="${LIMITS.MAX_NAME_LEN}" placeholder="Ana" enterkeyhint="done">
      </label>

      <div class="home-panel" data-mode="pick">
        <button class="btn btn-primary" id="home-create-mode">Create a room</button>
        <button class="btn" id="home-join-mode">Join a room</button>
      </div>

      <div class="home-panel" data-mode="create" hidden>
        <span class="field-label">How many players?</span>
        <div class="segmented" id="home-count" role="group" aria-label="Player count"></div>
        <button class="btn btn-primary" id="home-create">Create room</button>
        <button class="btn btn-quiet" data-back>Back</button>
      </div>

      <div class="home-panel" data-mode="join" hidden>
        <span class="field-label">Room code</span>
        <div class="code-input" id="home-code"></div>
        <button class="btn btn-primary" id="home-join">Join room</button>
        <button class="btn btn-quiet" data-back>Back</button>
      </div>
    </div>
  `;

  const nameInput = el.querySelector('#home-name');
  const panels = el.querySelectorAll('.home-panel');
  const countGroup = el.querySelector('#home-count');
  const codeWrap = el.querySelector('#home-code');

  nameInput.value = remembered.name;
  nameInput.addEventListener('input', () => { remembered.name = nameInput.value; });

  const showPanel = (mode) => {
    for (const panel of panels) panel.hidden = panel.dataset.mode !== mode;
    if (mode === 'join') codeWrap.firstElementChild.focus();
  };

  el.querySelector('#home-create-mode').addEventListener('click', () => showPanel('create'));
  el.querySelector('#home-join-mode').addEventListener('click', () => showPanel('join'));
  for (const back of el.querySelectorAll('[data-back]')) {
    back.addEventListener('click', () => showPanel('pick'));
  }

  // ---------------------------------------------------------- player count

  let maxPlayers = LIMITS.MAX_PLAYERS;
  for (let n = LIMITS.MIN_PLAYERS; n <= LIMITS.MAX_PLAYERS; n++) {
    const button = document.createElement('button');
    button.className = 'seg';
    button.textContent = String(n);
    button.dataset.count = String(n);
    button.setAttribute('aria-pressed', String(n === maxPlayers));
    button.addEventListener('click', () => {
      maxPlayers = n;
      for (const seg of countGroup.children) {
        seg.setAttribute('aria-pressed', String(Number(seg.dataset.count) === maxPlayers));
      }
    });
    countGroup.append(button);
  }

  // ------------------------------------------------------------- code input

  // One box per character. Fiddly, but typing a code on a phone is the single
  // most error-prone thing in the app, so it gets the per-character treatment:
  // auto-advance, backspace that steps back, and paste that fills every box.
  const boxes = [];
  for (let i = 0; i < CODE_BOXES; i++) {
    const box = document.createElement('input');
    box.className = 'code-box';
    box.type = 'text';
    box.inputMode = 'text';
    box.autocapitalize = 'characters';
    box.autocomplete = 'off';
    box.spellcheck = false;
    box.maxLength = 1;
    box.setAttribute('aria-label', `Code character ${i + 1}`);
    boxes.push(box);
    codeWrap.append(box);
  }

  const codeValue = () => boxes.map((b) => b.value).join('').toUpperCase();

  const fill = (text, from = 0) => {
    const chars = text.toUpperCase().replace(/[^A-Z0-9]/g, '').split('');
    for (let i = from; i < boxes.length; i++) {
      boxes[i].value = chars[i - from] ?? '';
    }
    const next = Math.min(from + chars.length, boxes.length - 1);
    boxes[next].focus();
    boxes[next].select();
  };

  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      // A paste or a fast typist can land several characters in one box.
      if (box.value.length > 1) return fill(box.value, i);
      box.value = box.value.toUpperCase();
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    });

    box.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !box.value && i > 0) {
        boxes[i - 1].value = '';
        boxes[i - 1].focus();
        event.preventDefault();
      }
      if (event.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (event.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
      if (event.key === 'Enter') submitJoin();
    });

    box.addEventListener('paste', (event) => {
      event.preventDefault();
      fill(event.clipboardData.getData('text'), 0);
    });

    box.addEventListener('focus', () => box.select());
  });

  // ---------------------------------------------------------------- submit

  const name = () => nameInput.value.trim();

  const submitJoin = () => {
    const code = codeValue();
    if (code.length !== CODE_BOXES) {
      shake(codeWrap);
      boxes[code.length]?.focus();
      return;
    }
    onJoin({ code, name: name() });
  };

  el.querySelector('#home-create').addEventListener('click', () => {
    onCreate({ name: name(), maxPlayers });
  });
  el.querySelector('#home-join').addEventListener('click', submitJoin);

  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') nameInput.blur();
  });

  return {
    el,

    /** A room link (`/?r=K7QM`) drops the joiner straight onto a filled code. */
    prefill(code) {
      if (!code) return;
      fill(code, 0);
      showPanel('join');
      // The name matters more than the code they already have, so focus that
      // if we do not know it yet.
      if (!nameInput.value) nameInput.focus();
    },

    update() {},
  };
}

function shake(node) {
  node.classList.remove('shake');
  // Force a reflow so the class re-applies even on consecutive failures.
  void node.offsetWidth;
  node.classList.add('shake');
}
