// Laptop host: room + lobby, the game simulation and the split-screen view.

import QRCode from 'qrcode';
import type { HapticPattern } from '../../shared/constants';
import type { GameStatePayload, HostMessage, PlayerInfo, ServerToHost } from '../../shared/protocol';
import { ReconnectingSocket } from '../common/socket';
import { Audio, type Sfx } from './game/audio';
import { DT } from './game/config';
import { computeLayout } from './game/layout';
import { GameRenderer, type Quality, type TargetMark } from './game/render';
import { Sim, type SimEvent, type SimState } from './game/sim';
import { World } from './game/world';
import { Hud, fmtTime } from './hud';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const HOST_KEY = 'ember:host';
const SNAP_KEY = 'ember:snapshot';
const SETTINGS_KEY = 'ember:settings';
const COUNTDOWN_S = 3;

type Mode = 'connecting' | 'lobby' | 'playing' | 'over';

interface PlayerEntry extends PlayerInfo {
  lastSeq: number;
}

// ---------------------------------------------------------------------------
// Storage helpers (all optional: private mode just loses reload recovery)
// ---------------------------------------------------------------------------

function load<T>(store: Storage, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(store: Storage, key: string, value: unknown): void {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

const settings = {
  nights: 5,
  quality: 'high' as Quality,
  ...load<{ nights: number; quality: Quality }>(localStorage, SETTINGS_KEY),
};
if (settings.nights !== 3 && settings.nights !== 5) settings.nights = 5;
if (settings.quality !== 'high' && settings.quality !== 'low') settings.quality = 'high';
const qualityParam = new URLSearchParams(location.search).get('quality');
if (qualityParam === 'low' || qualityParam === 'high') settings.quality = qualityParam;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mode: Mode = 'connecting';
let room = '';
const players = new Map<number, PlayerEntry>();
let countdownEnd = 0;
let lastCountdownTick = 0;
let lastStateSent = '';
let lastStateSentAt = 0;
const lastHud = new Map<number, { key: string; at: number }>();

const newSeed = () => (Math.random() * 2 ** 31) >>> 0;
let world = new World(newSeed());
let sim = new Sim(world, Sim.newState(world, settings.nights));

const hud = new Hud();
const audio = new Audio();
let renderer: GameRenderer;
try {
  renderer = new GameRenderer($('stage'), settings.quality);
  renderer.setWorld(world);
} catch (err) {
  const e = $('error');
  e.hidden = false;
  e.textContent = 'Ember needs WebGL. Please use a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled.';
  throw err;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const socket = new ReconnectingSocket<ServerToHost, HostMessage>({
  onOpen: () => {
    const saved = load<{ room: string; token: string }>(sessionStorage, HOST_KEY);
    if (saved) socket.send({ t: 'host:resume', room: saved.room, token: saved.token });
    else socket.send({ t: 'host:create' });
  },
  onMessage: onMessage,
  onStatus: (status) => {
    if (status === 'open') toast(null);
    else if (mode !== 'connecting') toast('Connection lost – reconnecting…');
  },
});

function send(msg: HostMessage): void {
  socket.send(msg);
}

function onMessage(msg: ServerToHost): void {
  switch (msg.t) {
    case 'host:room': {
      room = msg.room;
      save(sessionStorage, HOST_KEY, { room: msg.room, token: msg.token });
      players.clear();
      for (const p of msg.players) players.set(p.slot, { ...p, lastSeq: -1 });
      lastStateSent = '';

      if (msg.resumed && mode === 'connecting' && tryRestoreSnapshot()) {
        // Game continues after a page reload.
      } else if (!msg.resumed || mode === 'connecting') {
        if (mode !== 'lobby') enterLobby(false);
      }
      syncSimPlayers();
      renderJoinInfo();
      renderLobby();
      broadcastState(true);
      if (mode === 'playing') for (const p of players.values()) lastHud.delete(p.slot);
      break;
    }
    case 'player:joined': {
      const existing = players.get(msg.slot);
      players.set(msg.slot, {
        slot: msg.slot,
        playerId: msg.playerId,
        name: msg.name,
        color: msg.color,
        connected: true,
        ready: msg.ready,
        lastSeq: -1,
      });
      if (mode === 'playing' || mode === 'over') {
        if (mode === 'playing') sim.addPlayer(msg.slot, msg.name, msg.color);
        else sim.setConnected(msg.slot, true);
      }
      lastHud.delete(msg.slot);
      if (!existing || !existing.connected) audio.play('join');
      renderLobby();
      checkAutoStart();
      break;
    }
    case 'player:left': {
      if (msg.permanent) {
        players.delete(msg.slot);
        if (mode === 'playing' || mode === 'over') sim.removePlayer(msg.slot);
      } else {
        const p = players.get(msg.slot);
        if (p) p.connected = false;
        sim.setConnected(msg.slot, false);
      }
      renderLobby();
      checkAutoStart();
      break;
    }
    case 'player:ready': {
      const p = players.get(msg.slot);
      if (p) p.ready = msg.ready;
      renderLobby();
      checkAutoStart();
      break;
    }
    case 'input': {
      const p = players.get(msg.slot);
      if (!p) return;
      // Drop old or out-of-order inputs.
      if (msg.seq <= p.lastSeq && p.lastSeq - msg.seq < 1_000_000) return;
      p.lastSeq = msg.seq;
      if (mode === 'playing') sim.setInput(msg.slot, msg.x, msg.y, msg.b);
      break;
    }
    case 'error':
      if (msg.code === 'room-not-found') {
        save(sessionStorage, HOST_KEY, null);
        send({ t: 'host:create' });
      } else if (msg.code === 'too-many-rooms') {
        toast(msg.message);
        setTimeout(() => send({ t: 'host:create' }), 10_000);
      }
      break;
    case 'room:closed':
      if (msg.reason === 'replaced') {
        socket.stop();
        fatal('Ember was opened in another tab. Close this one or reload it to take over.');
        return;
      }
      // The server will close the socket; the reconnect creates a fresh room.
      save(sessionStorage, HOST_KEY, null);
      save(sessionStorage, SNAP_KEY, null);
      players.clear();
      if (mode === 'playing' || mode === 'over') enterLobby(true);
      mode = 'connecting';
      break;
  }
}

function syncSimPlayers(): void {
  if (mode !== 'playing' && mode !== 'over') return;
  for (const p of [...sim.state.players]) {
    const entry = players.get(p.slot);
    if (!entry) sim.removePlayer(p.slot);
    else sim.setConnected(p.slot, entry.connected);
  }
  if (mode === 'playing') {
    for (const e of players.values()) {
      if (!sim.player(e.slot)) {
        sim.addPlayer(e.slot, e.name, e.color);
        sim.setConnected(e.slot, e.connected);
      }
    }
  }
}

function currentGameState(): GameStatePayload {
  if (mode === 'playing') return { state: sim.state.phase, night: sim.state.night, nights: sim.state.nights };
  if (mode === 'over' && sim.state.over) {
    return {
      state: 'over',
      night: sim.state.night,
      nights: sim.state.nights,
      won: sim.state.over.won,
      reason: sim.state.over.reason,
    };
  }
  return { state: 'lobby', night: 0, nights: settings.nights };
}

function broadcastState(force = false): void {
  const payload = currentGameState();
  const key = JSON.stringify(payload);
  const now = performance.now();
  // Re-send now and then: keeps the free Render instance awake in the lobby.
  if (!force && key === lastStateSent && now - lastStateSentAt < 60_000) return;
  send({ t: 'game:state', ...payload });
  lastStateSent = key;
  lastStateSentAt = now;
}

function haptic(slot: number, pattern: HapticPattern): void {
  send({ t: 'haptic', slot, pattern });
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------

function enterLobby(newIsland: boolean): void {
  mode = 'lobby';
  countdownEnd = 0;
  if (newIsland || sim.state.players.length > 0 || sim.state.over) {
    world = new World(newSeed());
    renderer.setWorld(world);
  }
  sim = new Sim(world, Sim.newState(world, settings.nights));
  save(sessionStorage, SNAP_KEY, null);
  $('lobby').hidden = false;
  $('over').hidden = true;
  hud.show(false);
  renderLobby();
  broadcastState();
}

function startGame(): void {
  const connected = [...players.values()].filter((p) => p.connected);
  if (connected.length === 0) return;
  countdownEnd = 0;
  // The lobby already shows the next island; after a game over make a new one.
  if (mode !== 'lobby' || sim.state.players.length > 0) {
    world = new World(newSeed());
    renderer.setWorld(world);
  }
  sim = new Sim(world, Sim.newState(world, settings.nights));
  for (const p of players.values()) {
    sim.addPlayer(p.slot, p.name, p.color);
    sim.setConnected(p.slot, p.connected);
    p.ready = false;
  }
  // Zombie numbers scale with the number of players.
  sim.populateCity(1);
  mode = 'playing';
  acc = 0;
  lastHud.clear();
  $('lobby').hidden = true;
  $('over').hidden = true;
  hud.show(true);
  hud.banner('☀️ Day 1', 'Gather wood and keep the fire burning', 4000);
  audio.play('dawn');
  broadcastState();
  saveSnapshot();
}

function endGame(): void {
  mode = 'over';
  const over = sim.state.over!;
  audio.play(over.won ? 'win' : 'lose');
  save(sessionStorage, SNAP_KEY, null);
  for (const p of players.values()) p.ready = false;
  hud.show(false);
  renderOver();
  $('over').hidden = false;
  broadcastState();
}

function checkAutoStart(): void {
  if (mode !== 'lobby' && mode !== 'over') return;
  const connected = [...players.values()].filter((p) => p.connected);
  const allReady = connected.length > 0 && connected.every((p) => p.ready);
  if (allReady && !countdownEnd) {
    countdownEnd = performance.now() + COUNTDOWN_S * 1000;
    lastCountdownTick = 0;
  } else if (!allReady) {
    countdownEnd = 0;
  }
  renderLobby();
  if (mode === 'over') renderOver();
}

function saveSnapshot(): void {
  if (mode !== 'playing') return;
  save(sessionStorage, SNAP_KEY, { room, savedAt: Date.now(), state: sim.state });
}

function tryRestoreSnapshot(): boolean {
  const snap = load<{ room: string; savedAt: number; state: SimState }>(sessionStorage, SNAP_KEY);
  if (!snap || snap.room !== room || Date.now() - snap.savedAt > 90_000 || snap.state?.version !== 2) return false;
  try {
    world = new World(snap.state.seed);
    renderer.setWorld(world);
    sim = new Sim(world, snap.state);
    mode = 'playing';
    acc = 0;
    $('lobby').hidden = true;
    $('over').hidden = true;
    hud.show(true);
    hud.banner('Game restored', 'Welcome back', 2500);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sim events -> sound, haptics, effects, banners
// ---------------------------------------------------------------------------

const SFX: Partial<Record<SimEvent['type'], Sfx>> = {
  chop: 'chop',
  mine: 'mine',
  pickup: 'pickup',
  eat: 'eat',
  fuel: 'fuel',
  build: 'build',
  swing: 'swing',
  drop: 'pickup',
  hurt: 'hurt',
  downed: 'downed',
  revived: 'revived',
  fail: 'fail',
  creatureHit: 'creatureHit',
  creatureDie: 'creatureDie',
  wallHit: 'wall',
  wallBreak: 'wall',
  shot: 'shot',
  search: 'search',
  gear: 'gear',
  zombieHit: 'creatureHit',
  zombieDie: 'zombieDie',
  zombieAttack: 'zombie',
  trample: 'trample',
};

function handleEvents(): void {
  for (const e of sim.events) {
    const sfx = SFX[e.type];
    if (sfx) audio.play(sfx);
    switch (e.type) {
      case 'chop':
        renderer.fx('chop', e.x, e.z);
        break;
      case 'mine':
        renderer.fx('mine', e.x, e.z);
        break;
      case 'pickup':
        haptic(e.slot, 'pickup');
        break;
      case 'eat':
        renderer.fx('eat', e.x, e.z);
        break;
      case 'fuel':
        renderer.fx('fuel', 0, 0);
        break;
      case 'build':
        renderer.fx('build', e.x, e.z);
        break;
      case 'hurt':
        haptic(e.slot, 'hit');
        break;
      case 'downed': {
        haptic(e.slot, 'downed');
        const p = sim.player(e.slot);
        if (p && sim.state.players.length > 1) hud.banner(`${p.name} is down!`, 'Hold A next to them to revive', 2500);
        break;
      }
      case 'revived': {
        const p = sim.player(e.slot);
        if (p) hud.banner(`${p.name} is back up!`, '', 1800);
        break;
      }
      case 'creatureHit':
        renderer.fx('hit', e.x, e.z);
        break;
      case 'creatureDie':
        renderer.fx('die', e.x, e.z);
        break;
      case 'creatureBurn':
        renderer.fx('burn', e.x, e.z);
        break;
      case 'spawn':
        renderer.fx('spawn', e.x, e.z);
        break;
      case 'wallHit':
      case 'wallBreak':
        renderer.fx('wall', e.x, e.z);
        break;
      case 'shot':
        renderer.fx('shot', e.x, e.z, e.tx, e.tz);
        break;
      case 'search':
        renderer.fx('search', e.x, e.z);
        haptic(e.slot, 'pickup');
        break;
      case 'gear': {
        haptic(e.slot, 'pickup');
        break;
      }
      case 'zombieHit':
        renderer.fx('zhit', e.x, e.z);
        break;
      case 'zombieDie':
        renderer.fx('zdie', e.x, e.z);
        break;
      case 'trample':
        renderer.fx('trample', e.x, e.z);
        hud.banner('🧟 Zombies at the fire!', 'Drive them away before it goes out', 1800);
        break;
      case 'horde':
        hud.banner('🧟 A horde is coming from the city!', 'Build walls and defend the fire', 3500);
        audio.play('horde');
        for (const p of sim.state.players) haptic(p.slot, 'alert');
        break;
      case 'area':
        if (e.area === 2) haptic(e.slot, 'alert');
        break;
      case 'phase':
        if (e.phase === 'dusk') {
          hud.banner('🌇 Dusk', 'Get back to the fire!');
          audio.play('dusk');
          for (const p of sim.state.players) haptic(p.slot, 'alert');
        } else if (e.phase === 'night') {
          hud.banner(`🌙 Night ${e.night}`, 'Stay in the light. Keep the fire fed.');
          audio.play('night');
        } else {
          if (!sim.state.over) hud.banner(`🌅 Dawn – Day ${e.night}`, `You survived night ${e.night - 1}!`);
          audio.play('dawn');
        }
        broadcastState();
        break;
    }
  }
  sim.events.length = 0;
}

// ---------------------------------------------------------------------------
// Lobby and game-over UI
// ---------------------------------------------------------------------------

function renderJoinInfo(): void {
  if (!room) return;
  const url = `${location.origin}/play?room=${room}`;
  $('room-code').textContent = room;
  $('join-url').textContent = `${location.host}/play`;
  QRCode.toCanvas($<HTMLCanvasElement>('qr'), url, {
    width: 220,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#140d0a', light: '#ffffff' },
  }).catch(() => {});
}

function renderLobby(): void {
  const slots = $('slots');
  slots.replaceChildren();
  for (let slot = 1; slot <= 4; slot++) {
    const p = players.get(slot);
    const row = document.createElement('div');
    row.className = `slot ${p ? 'filled' : 'empty'}`;
    row.style.setProperty('--c', ['#ff7a45', '#3fb6ff', '#8fe04a', '#d873ff'][slot - 1]);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p ? p.name : `Player ${slot} – scan to join`;
    row.append(dot, name);
    if (p) {
      const state = document.createElement('span');
      state.className = `state ${!p.connected ? 'off' : p.ready ? 'ready' : ''}`;
      state.textContent = !p.connected ? 'Disconnected' : p.ready ? '✓ Ready' : 'Not ready';
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.type = 'button';
      kick.title = 'Remove player';
      kick.textContent = '×';
      kick.addEventListener('click', () => send({ t: 'host:kick', slot }));
      row.append(state, kick);
    }
    slots.appendChild(row);
  }

  const connected = [...players.values()].filter((p) => p.connected);
  const ready = connected.filter((p) => p.ready).length;
  const status = $('lobby-status');
  if (!room) status.textContent = 'Connecting to the server…';
  else if (countdownEnd) status.textContent = `Everyone is ready – starting in ${Math.max(1, Math.ceil((countdownEnd - performance.now()) / 1000))}…`;
  else if (connected.length === 0) status.textContent = 'Waiting for players to join…';
  else status.textContent = `Ready: ${ready} / ${connected.length} – press Ready on your phone`;
  $('sound-hint').hidden = audio.unlocked;
  const btn = $<HTMLButtonElement>('start-btn');
  btn.disabled = connected.length === 0;
  btn.textContent = connected.length > 0 && ready < connected.length ? 'Start anyway' : 'Start';

  for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-nights button')) {
    b.classList.toggle('on', Number(b.dataset.v) === settings.nights);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-quality button')) {
    b.classList.toggle('on', b.dataset.v === settings.quality);
  }
}

function renderOver(): void {
  const s = sim.state;
  const over = s.over;
  if (!over) return;
  $('over-title').textContent = over.won ? '🔥 You survived!' : '💀 Game over';
  $('over-reason').textContent = over.reason;
  const survived = over.won ? s.nights : s.night - 1;
  const stats: [string, string][] = [
    [`${survived} / ${s.nights}`, 'nights survived'],
    [String(s.stats.woodBurned), 'wood burned'],
    [String(s.stats.zombies), 'zombies killed'],
    [String(s.stats.kills - s.stats.zombies), 'creatures defeated'],
    [String(s.stats.searched), 'cars & crates searched'],
    [String(s.stats.revives), 'revives'],
    [fmtTime(s.time), 'time'],
  ];
  const box = $('over-stats');
  box.replaceChildren(
    ...stats.map(([v, label]) => {
      const d = document.createElement('div');
      d.className = 'stat';
      const b = document.createElement('b');
      b.textContent = v;
      const sp = document.createElement('span');
      sp.textContent = label;
      d.append(b, sp);
      return d;
    }),
  );
  const list = $('over-players');
  list.replaceChildren(
    ...[...players.values()].map((p) => {
      const sp = s.players.find((q) => q.slot === p.slot);
      const row = document.createElement('div');
      row.className = 'over-player';
      row.style.setProperty('--c', p.color);
      const n = document.createElement('span');
      n.className = 'pname';
      n.textContent = p.name;
      const st = document.createElement('span');
      st.className = 'ps';
      st.textContent = sp ? `🪵 ${sp.woodBurned} burned · ⚔️ ${sp.kills}` : 'joined late';
      const r = document.createElement('span');
      r.className = `state ${p.ready ? 'ready' : ''}`;
      r.textContent = !p.connected ? 'Disconnected' : p.ready ? '✓ Ready' : 'Not ready';
      row.append(n, st, r);
      return row;
    }),
  );
  const btn = $<HTMLButtonElement>('again-btn');
  btn.disabled = ![...players.values()].some((p) => p.connected);
  btn.textContent = countdownEnd
    ? `Starting in ${Math.max(1, Math.ceil((countdownEnd - performance.now()) / 1000))}…`
    : 'Play again';
}

$('start-btn').addEventListener('click', () => startGame());
$('again-btn').addEventListener('click', () => startGame());
$('lobby-btn').addEventListener('click', () => enterLobby(true));

for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-nights button')) {
  b.addEventListener('click', () => {
    settings.nights = Number(b.dataset.v);
    save(localStorage, SETTINGS_KEY, settings);
    sim.state.nights = settings.nights;
    renderLobby();
    broadcastState();
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#seg-quality button')) {
  b.addEventListener('click', () => {
    const q = b.dataset.v as Quality;
    if (q === settings.quality) return;
    settings.quality = q;
    save(localStorage, SETTINGS_KEY, settings);
    // The renderer is created once per page; the room survives the reload.
    location.reload();
  });
}

// ---------------------------------------------------------------------------
// Misc UI
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(text: string | null, ms = 0): void {
  const t = $('toast');
  clearTimeout(toastTimer);
  t.hidden = !text;
  t.textContent = text ?? '';
  if (text && ms) toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

function fatal(text: string): void {
  const e = $('error');
  e.hidden = false;
  e.textContent = text;
}

const soundBtn = $('sound-btn');
function updateSoundBtn(): void {
  soundBtn.textContent = audio.unlocked && !audio.muted ? '🔊' : '🔇';
}
document.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (e.target !== soundBtn) setTimeout(updateSoundBtn, 50);
  setTimeout(() => ($('sound-hint').hidden = audio.unlocked), 100);
});
document.addEventListener('keydown', (e) => {
  audio.unlock();
  setTimeout(updateSoundBtn, 50);
  if (e.key === 'f' || e.key === 'F') $('fps').hidden = !$('fps').hidden;
});
soundBtn.addEventListener('click', () => {
  if (!audio.unlocked) audio.unlock();
  else audio.setMuted(!audio.muted);
  setTimeout(updateSoundBtn, 50);
});

window.addEventListener('resize', () => renderer.resize());

// ---------------------------------------------------------------------------
// Main loop: fixed 30 Hz simulation, render every animation frame
// ---------------------------------------------------------------------------

let acc = 0;
let last = performance.now();
let time = 0;
let lastHudAt = 0;
let lastPhoneHudAt = 0;
let lastSnapAt = 0;
let fpsFrames = 0;
let fpsTime = 0;
let fps = 60;
let lastScaleChange = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  time += dt;

  let paused = false;
  if (mode === 'playing') {
    paused = sim.connectedCount === 0;
    if (!paused) {
      acc += dt;
      let steps = 0;
      while (acc >= DT && steps < 6) {
        sim.step();
        handleEvents();
        acc -= DT;
        steps++;
        if (sim.state.over) break;
      }
      if (steps === 6) acc = 0;
    }
    if (sim.state.over) endGame();
  }

  // Countdown in lobby / game over.
  if (countdownEnd && (mode === 'lobby' || mode === 'over')) {
    const left = Math.ceil((countdownEnd - now) / 1000);
    if (left !== lastCountdownTick) {
      lastCountdownTick = left;
      if (left > 0) audio.play('countdown');
      if (mode === 'lobby') renderLobby();
      else renderOver();
    }
    if (now >= countdownEnd) startGame();
  }

  const playing = mode === 'playing';
  const slots = playing ? sim.state.players.map((p) => p.slot) : [];
  const W = window.innerWidth;
  const H = window.innerHeight;
  const layout = computeLayout(W, H, slots.length);

  // Target highlight rings.
  const targets: (TargetMark | null)[] = [null, null, null, null];
  if (playing) {
    for (const p of sim.state.players) {
      const t = sim.targetOf(p.slot);
      if (!t || p.downed) continue;
      let mark: TargetMark | null = null;
      const s = sim.state;
      if (t.kind === 'tree') mark = { x: world.trees[t.i].x, z: world.trees[t.i].z, r: 1.0, color: p.color };
      else if (t.kind === 'rock') mark = { x: world.rocks[t.i].x, z: world.rocks[t.i].z, r: 1.4 * world.rocks[t.i].scale, color: p.color };
      else if (t.kind === 'bush') mark = { x: world.bushes[t.i].x, z: world.bushes[t.i].z, r: 1.2, color: p.color };
      else if (t.kind === 'item') {
        const it = s.items.find((i) => i.id === t.id);
        if (it) mark = { x: it.x, z: it.z, r: 0.8, color: p.color };
      } else if (t.kind === 'attack') {
        const c = s.creatures.find((q) => q.id === t.id);
        if (c) mark = { x: c.x, z: c.z, r: 1.1, color: '#ff4040' };
      } else if (t.kind === 'revive') {
        const q = sim.player(t.slot);
        if (q) mark = { x: q.x, z: q.z, r: 1.0, color: '#9be15d' };
      }
      targets[p.slot - 1] = mark;
    }
  }

  renderer.render({
    state: sim.state,
    alpha: playing ? Math.min(1, acc / DT) : 1,
    dt,
    time,
    views: playing ? slots.map((slot, i) => ({ slot, rect: layout.views[i] })) : [],
    orbit: !playing,
    phase: playing || mode === 'over' ? sim.state.phase : 'lobby',
    targets,
  });

  if (playing && now - lastHudAt > 100) {
    lastHudAt = now;
    hud.update(sim, layout, slots, paused);
    const nightness = sim.state.phase === 'night' ? 1 : sim.state.phase === 'dusk' ? 0.5 : 0;
    audio.setAmbience(sim.state.fuel / 100, nightness);
  } else if (!playing && now - lastHudAt > 500) {
    lastHudAt = now;
    audio.setAmbience(mode === 'over' && !sim.state.over?.won ? 0 : 0.5, 0.3);
  }

  // Phone HUDs, about 5 per second, only when something changed (or every second).
  if (playing && now - lastPhoneHudAt > 200) {
    lastPhoneHudAt = now;
    for (const p of sim.state.players) {
      if (!p.connected) continue;
      const h = sim.hudFor(p.slot);
      if (!h) continue;
      const key = JSON.stringify(h);
      const prev = lastHud.get(p.slot);
      if (prev && prev.key === key && now - prev.at < 1000) continue;
      lastHud.set(p.slot, { key, at: now });
      send({ t: 'hud', slot: p.slot, ...h });
    }
  }

  if (playing && now - lastSnapAt > 2000) {
    lastSnapAt = now;
    saveSnapshot();
  }
  if (now - lastStateSentAt > 60_000) broadcastState();

  // Frame rate and adaptive resolution.
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 2) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0;
    fpsTime = 0;
    if (playing && document.visibilityState === 'visible') {
      const target = slots.length >= 3 ? 38 : 50;
      const scale = renderer.currentPixelScale;
      if (fps < target && scale > 0.6) {
        renderer.setPixelScale(scale - 0.1);
        lastScaleChange = now;
      } else if (fps > 58 && scale < 1 && now - lastScaleChange > 8000) {
        renderer.setPixelScale(scale + 0.1);
        lastScaleChange = now;
      }
    }
    const fpsEl = $('fps');
    if (!fpsEl.hidden) {
      fpsEl.textContent = `${fps.toFixed(0)} fps · ${renderer.drawCalls} draws · res ${(renderer.currentPixelScale * 100).toFixed(0)}%`;
    }
  }
}

$('lobby').hidden = false;
renderLobby();
requestAnimationFrame(frame);

// Small debug hook for automated tests.
(window as unknown as { ember: unknown }).ember = {
  get mode() {
    return mode;
  },
  get room() {
    return room;
  },
  get sim() {
    return sim;
  },
  get drawCalls() {
    return renderer.drawCalls;
  },
};
