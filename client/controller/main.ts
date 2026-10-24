// Phone controller: join form, floating joystick, A/B/C buttons and a small HUD.
// Phones only send input state; the laptop decides what happens.

import { BTN_A, BTN_B, BTN_C, INPUT_HEARTBEAT_MS, normalizeRoomCode } from '../../shared/constants';
import type { HapticPattern } from '../../shared/constants';
import type { CtrlMessage, GameStatePayload, HudPayload, ServerToCtrl } from '../../shared/protocol';
import { ReconnectingSocket } from '../common/socket';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SESSION_KEY = 'ember:session';
const NAME_KEY = 'ember:name';

interface Session {
  room: string;
  token?: string;
  name: string;
}

const ITEM_ICON: Record<string, string> = { wood: '🪵', stone: '🪨', berry: '🫐', fuel: '⛽', can: '🥫' };

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone =
  matchMedia('(display-mode: fullscreen)').matches ||
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const canFullscreen = !!document.documentElement.requestFullscreen;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let session: Session | null = loadSession();
let socket: ReconnectingSocket<ServerToCtrl, CtrlMessage> | null = null;
let joined = false;
let ready = false;
let gameState: GameStatePayload = { state: 'lobby', night: 0, nights: 5 };
let hostOnline = true;
let screen: 'join' | 'wait' | 'pad' = 'join';

const input = { x: 0, y: 0, b: 0 };
let seq = 0;
let lastSent = 0;
let sendPending = false;

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (typeof s.room !== 'string' || typeof s.name !== 'string') return null;
    return s;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
    if (s?.name) localStorage.setItem(NAME_KEY, s.name);
  } catch {
    // Private mode: reconnect after reload will not work, everything else does.
  }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function show(next: typeof screen): void {
  screen = next;
  $('screen-join').hidden = next !== 'join';
  $('screen-wait').hidden = next !== 'wait';
  $('screen-pad').hidden = next !== 'pad';
  updateRotateOverlay();
  if (next !== 'pad') resetInput();
}

function updateRotateOverlay(): void {
  const portrait = window.innerHeight > window.innerWidth;
  $('overlay-rotate').hidden = !(portrait && screen === 'pad');
}

function banner(text: string | null): void {
  const el = $('banner');
  el.hidden = !text;
  el.textContent = text ?? '';
}

function showJoin(error = ''): void {
  joined = false;
  show('join');
  $('join-error').textContent = error;
  const params = new URLSearchParams(location.search);
  const roomInput = $<HTMLInputElement>('join-room');
  const nameInput = $<HTMLInputElement>('join-name');
  if (!roomInput.value) roomInput.value = normalizeRoomCode(params.get('room') ?? session?.room ?? '');
  if (!nameInput.value) {
    try {
      nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      // ignore
    }
  }
  $('ios-hint').hidden = !(isIOS && !isStandalone);
  $<HTMLButtonElement>('join-btn').disabled = false;
}

function applyGameState(): void {
  if (!joined) return;
  const s = gameState.state;
  if (s === 'day' || s === 'dusk' || s === 'night') {
    ready = false;
    show('pad');
    return;
  }
  show('wait');
  const title = $('wait-title');
  const sub = $('wait-sub');
  if (s === 'over') {
    title.textContent = gameState.won ? '🔥 You survived!' : '💀 Game over';
    sub.textContent = (gameState.reason ? gameState.reason + ' ' : '') + 'Press Ready to play again.';
  } else {
    title.textContent = hostOnline ? 'In the lobby' : 'Waiting for the laptop…';
    sub.textContent = 'Press Ready when you are set. The game starts when everyone is ready.';
  }
  renderReady();
}

function renderReady(): void {
  const btn = $('ready-btn');
  btn.classList.toggle('is-ready', ready);
  btn.textContent = ready ? '✓ Ready!' : 'Ready';
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function connect(): void {
  if (!session) return;
  if (socket) {
    socket.restart();
    return;
  }
  socket = new ReconnectingSocket<ServerToCtrl, CtrlMessage>({
    onOpen: () => {
      if (!session) return;
      socket?.send({ t: 'ctrl:join', room: session.room, name: session.name, token: session.token });
    },
    onMessage: onMessage,
    onStatus: (status) => {
      if (status === 'open') banner(null);
      else if (joined || session?.token) banner('Reconnecting…');
    },
  });
}

function disconnect(): void {
  socket?.stop();
  banner(null);
}

function onMessage(msg: ServerToCtrl): void {
  switch (msg.t) {
    case 'joined':
      joined = true;
      session = { room: msg.room, token: msg.token, name: msg.name };
      saveSession(session);
      ready = msg.ready;
      hostOnline = msg.hostOnline;
      document.documentElement.style.setProperty('--me', msg.color);
      $('wait-dot').style.background = msg.color;
      $('wait-name').textContent = msg.name;
      $('wait-slot').textContent = `Player ${msg.slot}`;
      banner(hostOnline ? null : 'Laptop disconnected – waiting…');
      applyGameState();
      break;
    case 'game:state':
      gameState = msg;
      applyGameState();
      break;
    case 'hud':
      renderHud(msg);
      break;
    case 'haptic':
      haptic(msg.pattern);
      break;
    case 'host:status':
      hostOnline = msg.online;
      banner(msg.online ? null : 'Laptop disconnected – waiting…');
      if (screen === 'wait') applyGameState();
      break;
    case 'error':
      if (msg.code === 'invalid' || msg.code === 'rate-limit') return;
      if (msg.code === 'room-not-found' && session) session = { ...session, token: undefined };
      saveSession(null);
      disconnect();
      showJoin(msg.message);
      break;
    case 'room:closed': {
      const text: Record<typeof msg.reason, string> = {
        'host-left': 'Host left. Join a new room.',
        expired: 'The room expired.',
        kicked: 'You were removed from the room.',
        server: 'The server restarted. Join again.',
      };
      session = null;
      saveSession(null);
      disconnect();
      $<HTMLInputElement>('join-room').value = '';
      showJoin(text[msg.reason]);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Input sending: on change (throttled), plus a heartbeat every 100 ms
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 30;

function sendInput(): void {
  if (!joined || !socket) return;
  const now = performance.now();
  if (now - lastSent < MIN_INTERVAL_MS) {
    if (!sendPending) {
      sendPending = true;
      setTimeout(() => {
        sendPending = false;
        sendInput();
      }, MIN_INTERVAL_MS - (now - lastSent));
    }
    return;
  }
  lastSent = now;
  seq = (seq + 1) % 2 ** 31;
  socket.send({
    t: 'input',
    x: Math.round(input.x * 1000) / 1000,
    y: Math.round(input.y * 1000) / 1000,
    b: input.b,
    seq,
  });
}

setInterval(() => {
  if (performance.now() - lastSent >= INPUT_HEARTBEAT_MS - 5) sendInput();
}, INPUT_HEARTBEAT_MS);

function resetInput(): void {
  input.x = 0;
  input.y = 0;
  input.b = 0;
  for (const id of ['btn-a', 'btn-b', 'btn-c']) $(id).classList.remove('down');
  $('stick-base').hidden = true;
  $('stick-hint').hidden = false;
  stickPointer = null;
  sendInput();
}

// ---------------------------------------------------------------------------
// Floating joystick
// ---------------------------------------------------------------------------

const zone = $('stick-zone');
const base = $('stick-base');
const knob = $('stick-knob');
let stickPointer: number | null = null;
let stickCx = 0;
let stickCy = 0;

function stickRadius(): number {
  return Math.max(48, Math.min(95, Math.min(innerWidth, innerHeight) * 0.2));
}

zone.addEventListener('pointerdown', (e) => {
  if (stickPointer !== null) return;
  e.preventDefault();
  stickPointer = e.pointerId;
  zone.setPointerCapture(e.pointerId);
  const rect = zone.getBoundingClientRect();
  stickCx = e.clientX - rect.left;
  stickCy = e.clientY - rect.top;
  const r = stickRadius();
  base.style.setProperty('--stick-d', `${r * 2}px`);
  base.style.left = `${stickCx}px`;
  base.style.top = `${stickCy}px`;
  base.hidden = false;
  $('stick-hint').hidden = true;
  knob.style.transform = 'translate(0px, 0px)';
});

zone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== stickPointer) return;
  const rect = zone.getBoundingClientRect();
  const r = stickRadius();
  let dx = e.clientX - rect.left - stickCx;
  let dy = e.clientY - rect.top - stickCy;
  const len = Math.hypot(dx, dy);
  if (len > r) {
    dx = (dx / len) * r;
    dy = (dy / len) * r;
  }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  // Dead zone, then rescale so small movements are still possible.
  const mag = Math.min(1, len / r);
  const dead = 0.12;
  const scaled = mag < dead ? 0 : (mag - dead) / (1 - dead);
  const nx = len > 0 ? dx / Math.min(len, r) : 0;
  const ny = len > 0 ? dy / Math.min(len, r) : 0;
  const x = nx * scaled;
  const y = -ny * scaled;
  if (Math.abs(x - input.x) > 0.02 || Math.abs(y - input.y) > 0.02 || (scaled === 0 && (input.x || input.y))) {
    input.x = x;
    input.y = y;
    sendInput();
  }
});

function endStick(e: PointerEvent): void {
  if (e.pointerId !== stickPointer) return;
  stickPointer = null;
  base.hidden = true;
  $('stick-hint').hidden = false;
  input.x = 0;
  input.y = 0;
  sendInput();
}
zone.addEventListener('pointerup', endStick);
zone.addEventListener('pointercancel', endStick);
zone.addEventListener('lostpointercapture', endStick);

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function bindButton(id: string, bit: number): void {
  const el = $(id);
  let pointer: number | null = null;
  const release = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    el.classList.remove('down');
    input.b &= ~bit;
    sendInput();
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (pointer !== null) return;
    pointer = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add('down');
    input.b |= bit;
    lastSent = 0; // Button presses go out immediately.
    sendInput();
  });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindButton('btn-a', BTN_A);
bindButton('btn-b', BTN_B);
bindButton('btn-c', BTN_C);

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener(
  'touchmove',
  (e) => {
    if (screen !== 'join') e.preventDefault();
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// HUD and haptics
// ---------------------------------------------------------------------------

function renderHud(h: HudPayload): void {
  $('hud-hp').style.transform = `scaleX(${h.hp / 100})`;
  $('hud-food').style.transform = `scaleX(${h.food / 100})`;
  $('hud-hint').textContent = h.hint;
  const item = h.item ? `${ITEM_ICON[h.item.type] ?? ''} ×${h.item.count}` : '';
  $('hud-item').textContent = [h.gear, item].filter(Boolean).join('  ');
  setLabel('btn-a', h.a);
  setLabel('btn-b', h.b);
  setLabel('btn-c', h.c);
  $('downed').hidden = !h.downed;
  const prog = $('hud-progress');
  prog.classList.toggle('on', h.progress > 0);
  (prog.firstElementChild as HTMLElement).style.transform = `scaleX(${h.progress})`;
}

function setLabel(id: string, text: string): void {
  const el = $(id);
  (el.querySelector('.lbl') as HTMLElement).textContent = text;
  el.classList.toggle('dim', !text);
}

const VIBRATION: Record<HapticPattern, number[]> = {
  hit: [70],
  pickup: [18],
  downed: [250, 100, 250],
  alert: [40, 60, 40, 60, 40],
};

function haptic(pattern: HapticPattern): void {
  try {
    navigator.vibrate?.(VIBRATION[pattern]);
  } catch {
    // Not supported (e.g. iPhone): the visual flash below still shows.
  }
  const flash = $('flash');
  flash.className = 'flash';
  void flash.offsetWidth;
  flash.classList.add(pattern === 'downed' ? 'hit' : pattern);
}

// ---------------------------------------------------------------------------
// Fullscreen, orientation and wake lock
// ---------------------------------------------------------------------------

let wakeLock: WakeLockSentinel | null = null;

async function requestWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    // Battery saver or unsupported: the game still works.
  }
}

async function enterFullscreen(): Promise<void> {
  try {
    if (canFullscreen && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    const orientation = screen_orientation();
    await orientation?.lock?.('landscape').catch(() => {});
  } catch {
    // iPhone Safari: no Fullscreen API on elements. The layout works with bars visible.
  }
  requestWakeLock();
}

function screen_orientation(): (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | null {
  return (window.screen?.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }) ?? null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
  else resetInput();
});

window.addEventListener('resize', updateRotateOverlay);
window.addEventListener('orientationchange', updateRotateOverlay);

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const room = normalizeRoomCode($<HTMLInputElement>('join-room').value);
  const name = $<HTMLInputElement>('join-name').value.trim();
  if (!/^[A-Z]{4}$/.test(room)) {
    $('join-error').textContent = 'The room code has 4 letters.';
    return;
  }
  if (!name) {
    $('join-error').textContent = 'Please enter a name.';
    return;
  }
  $('join-error').textContent = '';
  $<HTMLButtonElement>('join-btn').disabled = true;
  (document.activeElement as HTMLElement | null)?.blur();
  const keepToken = session && session.room === room ? session.token : undefined;
  session = { room, name, token: keepToken };
  saveSession(session);
  history.replaceState(null, '', `/play?room=${room}`);
  enterFullscreen();
  connect();
});

$('ready-btn').addEventListener('click', () => {
  ready = !ready;
  renderReady();
  socket?.send({ t: 'ctrl:ready', ready });
  enterFullscreen();
});

$('leave-btn').addEventListener('click', () => {
  socket?.send({ t: 'ctrl:leave' });
  session = null;
  saveSession(null);
  setTimeout(disconnect, 100);
  $<HTMLInputElement>('join-room').value = '';
  showJoin('');
});

$('tap-btn').addEventListener('click', () => {
  $('overlay-tap').hidden = true;
  enterFullscreen();
});

// Start: rejoin automatically when this phone already has a session for this room.
(function start() {
  const params = new URLSearchParams(location.search);
  const urlRoom = params.get('room') ? normalizeRoomCode(params.get('room')!) : null;
  if (session?.token && (!urlRoom || urlRoom === session.room)) {
    show('wait');
    $('wait-title').textContent = 'Reconnecting…';
    $('wait-sub').textContent = '';
    connect();
    // Fullscreen needs a tap after a reload.
    if (canFullscreen && !isStandalone) $('overlay-tap').hidden = false;
    else requestWakeLock();
  } else {
    showJoin('');
  }
})();
