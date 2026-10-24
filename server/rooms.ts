// Room and relay logic. The server never runs game logic: it only pairs phones
// with a laptop by room code and forwards messages where their sender may send.

import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  MAX_PLAYERS,
  MAX_ROOMS,
  PLAYER_COLORS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  cleanName,
} from '../shared/constants';
import {
  ctrlMessageSchema,
  firstMessageSchema,
  hostMessageSchema,
  type CtrlMessage,
  type ErrorCode,
  type HostMessage,
  type PlayerInfo,
  type ServerToCtrl,
  type ServerToHost,
} from '../shared/protocol';

export const HOST_GRACE_MS = 60_000;
export const EMPTY_ROOM_MS = 10 * 60_000;

const RATE = { host: 200, ctrl: 60, none: 10 } as const;
const MAX_INVALID = 20;
const MAX_DROPPED = 300;

type Role = 'none' | 'host' | 'ctrl';

export interface Client {
  ws: WebSocket;
  role: Role;
  room: Room | null;
  slot: number;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  invalid: number;
  dropped: number;
}

interface PlayerSlot {
  slot: number;
  playerId: string;
  token: string;
  name: string;
  color: string;
  ready: boolean;
  client: Client | null;
  lastHud: string | null;
}

interface Room {
  code: string;
  hostToken: string;
  host: Client | null;
  players: Map<number, PlayerSlot>;
  lastGameState: string | null;
  lastStateName: string;
  hostGoneTimer: NodeJS.Timeout | null;
  emptyTimer: NodeJS.Timeout | null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function playerInfo(p: PlayerSlot): PlayerInfo {
  return {
    slot: p.slot,
    playerId: p.playerId,
    name: p.name,
    color: p.color,
    connected: p.client !== null,
    ready: p.ready,
  };
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  constructor(private log: (msg: string) => void = () => {}) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  newClient(ws: WebSocket): Client {
    return {
      ws,
      role: 'none',
      room: null,
      slot: 0,
      alive: true,
      tokens: RATE.none,
      lastRefill: Date.now(),
      invalid: 0,
      dropped: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Incoming messages
  // -------------------------------------------------------------------------

  handleRaw(client: Client, raw: string): void {
    if (!this.takeToken(client)) {
      client.dropped++;
      if (client.dropped > MAX_DROPPED) client.ws.close(1008, 'rate limit');
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.invalid(client);
      return;
    }

    if (client.role === 'none') {
      const parsed = firstMessageSchema.safeParse(data);
      if (!parsed.success) return this.invalid(client);
      const msg = parsed.data;
      if (msg.t === 'ctrl:join') this.onCtrlJoin(client, msg);
      else this.onHostHello(client, msg);
    } else if (client.role === 'host') {
      const parsed = hostMessageSchema.safeParse(data);
      if (!parsed.success) return this.invalid(client);
      this.onHostMessage(client, parsed.data);
    } else {
      const parsed = ctrlMessageSchema.safeParse(data);
      if (!parsed.success) return this.invalid(client);
      this.onCtrlMessage(client, parsed.data);
    }
  }

  handleClose(client: Client): void {
    const room = client.room;
    if (!room) return;
    client.room = null;

    if (client.role === 'host' && room.host === client) {
      room.host = null;
      this.broadcastCtrl(room, { t: 'host:status', online: false });
      this.clearTimer(room, 'hostGoneTimer');
      room.hostGoneTimer = setTimeout(() => {
        this.deleteRoom(room, 'host-left');
      }, HOST_GRACE_MS);
      this.log(`room ${room.code}: host disconnected, waiting ${HOST_GRACE_MS / 1000}s`);
    } else if (client.role === 'ctrl') {
      const p = room.players.get(client.slot);
      if (p && p.client === client) {
        p.client = null;
        this.sendHost(room, { t: 'player:left', slot: p.slot, permanent: false });
        this.updateEmptyTimer(room);
      }
    }
  }

  /** Refill a socket's token bucket and take one token. */
  private takeToken(client: Client): boolean {
    const rate = RATE[client.role];
    const now = Date.now();
    client.tokens = Math.min(rate * 1.5, client.tokens + ((now - client.lastRefill) / 1000) * rate);
    client.lastRefill = now;
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }

  private invalid(client: Client): void {
    client.invalid++;
    if (client.invalid === 1) this.sendTo(client, { t: 'error', code: 'invalid', message: 'Invalid message' });
    if (client.invalid > MAX_INVALID) client.ws.close(1008, 'invalid messages');
  }

  // -------------------------------------------------------------------------
  // Host
  // -------------------------------------------------------------------------

  private onHostHello(
    client: Client,
    msg: Extract<HostMessage, { t: 'host:create' | 'host:resume' }>,
  ): void {
    if (msg.t === 'host:resume') {
      const room = this.rooms.get(msg.room);
      if (room && safeEqual(room.hostToken, msg.token)) {
        if (room.host && room.host !== client) {
          this.sendTo(room.host, { t: 'room:closed', reason: 'replaced' });
          room.host.room = null;
          room.host.ws.close(1000, 'replaced');
        }
        this.attachHost(client, room);
        this.clearTimer(room, 'hostGoneTimer');
        this.sendHost(room, {
          t: 'host:room',
          room: room.code,
          token: room.hostToken,
          players: [...room.players.values()].map(playerInfo),
          resumed: true,
        });
        this.broadcastCtrl(room, { t: 'host:status', online: true });
        this.log(`room ${room.code}: host resumed`);
        return;
      }
      this.sendTo(client, { t: 'error', code: 'room-not-found', message: 'Room expired' });
      return;
    }

    if (this.rooms.size >= MAX_ROOMS) {
      this.error(client, 'too-many-rooms', 'The server is full, try again later');
      return;
    }
    const room: Room = {
      code: this.newCode(),
      hostToken: randomUUID(),
      host: null,
      players: new Map(),
      lastGameState: null,
      lastStateName: 'lobby',
      hostGoneTimer: null,
      emptyTimer: null,
    };
    this.rooms.set(room.code, room);
    this.attachHost(client, room);
    this.updateEmptyTimer(room);
    this.sendHost(room, { t: 'host:room', room: room.code, token: room.hostToken, players: [], resumed: false });
    this.log(`room ${room.code}: created (${this.rooms.size} rooms)`);
  }

  private attachHost(client: Client, room: Room): void {
    client.role = 'host';
    client.room = room;
    room.host = client;
  }

  private onHostMessage(client: Client, msg: HostMessage): void {
    const room = client.room;
    if (!room || room.host !== client) return;

    switch (msg.t) {
      case 'host:create':
      case 'host:resume':
        this.invalid(client);
        return;
      case 'hud': {
        const p = room.players.get(msg.slot);
        if (!p) return;
        const { t: _t, slot: _slot, ...payload } = msg;
        const out = JSON.stringify({ t: 'hud', ...payload });
        p.lastHud = out;
        if (p.client) this.sendRaw(p.client, out);
        return;
      }
      case 'haptic': {
        const p = room.players.get(msg.slot);
        if (p?.client) this.sendTo(p.client, { t: 'haptic', pattern: msg.pattern });
        return;
      }
      case 'game:state': {
        const wasIdle = room.lastStateName === 'lobby' || room.lastStateName === 'over';
        const isPlaying = msg.state === 'day' || msg.state === 'dusk' || msg.state === 'night';
        if (wasIdle && isPlaying) for (const p of room.players.values()) p.ready = false;
        room.lastStateName = msg.state;
        room.lastGameState = JSON.stringify(msg);
        this.broadcastCtrlRaw(room, room.lastGameState);
        return;
      }
      case 'host:kick': {
        const p = room.players.get(msg.slot);
        if (!p) return;
        room.players.delete(msg.slot);
        if (p.client) {
          this.sendTo(p.client, { t: 'room:closed', reason: 'kicked' });
          p.client.room = null;
          p.client.ws.close(1000, 'kicked');
        }
        this.sendHost(room, { t: 'player:left', slot: msg.slot, permanent: true });
        this.updateEmptyTimer(room);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Controller
  // -------------------------------------------------------------------------

  private onCtrlJoin(client: Client, msg: Extract<CtrlMessage, { t: 'ctrl:join' }>): void {
    const room = this.rooms.get(msg.room);
    if (!room) {
      this.error(client, 'room-not-found', 'Room not found. Check the code on the laptop.');
      return;
    }

    // Reconnect: the token must match a slot this server handed out.
    if (msg.token) {
      for (const p of room.players.values()) {
        if (!safeEqual(p.token, msg.token)) continue;
        if (p.client && p.client !== client) {
          p.client.room = null;
          p.client.ws.close(1000, 'replaced');
        }
        this.attachCtrl(client, room, p);
        this.sendHost(room, { t: 'player:joined', reconnected: true, ...playerInfo(p) });
        this.log(`room ${room.code}: slot ${p.slot} reconnected`);
        return;
      }
    }

    const name = cleanName(msg.name);
    if (!name) {
      this.error(client, 'bad-name', 'Please enter a name');
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      this.error(client, 'room-full', 'This room already has 4 players');
      return;
    }
    let slot = 1;
    while (room.players.has(slot)) slot++;
    const p: PlayerSlot = {
      slot,
      playerId: randomUUID(),
      token: randomUUID(),
      name,
      color: PLAYER_COLORS[slot - 1],
      ready: false,
      client: null,
      lastHud: null,
    };
    room.players.set(slot, p);
    this.attachCtrl(client, room, p);
    this.sendHost(room, { t: 'player:joined', reconnected: false, ...playerInfo(p) });
    this.log(`room ${room.code}: slot ${slot} joined`);
  }

  private attachCtrl(client: Client, room: Room, p: PlayerSlot): void {
    client.role = 'ctrl';
    client.room = room;
    client.slot = p.slot;
    p.client = client;
    this.sendTo(client, {
      t: 'joined',
      room: room.code,
      slot: p.slot,
      playerId: p.playerId,
      token: p.token,
      name: p.name,
      color: p.color,
      ready: p.ready,
      hostOnline: room.host !== null,
    });
    if (room.lastGameState) this.sendRaw(client, room.lastGameState);
    if (p.lastHud) this.sendRaw(client, p.lastHud);
    this.updateEmptyTimer(room);
  }

  private onCtrlMessage(client: Client, msg: CtrlMessage): void {
    const room = client.room;
    if (!room) return;
    const p = room.players.get(client.slot);
    if (!p || p.client !== client) return;

    switch (msg.t) {
      case 'ctrl:join':
        this.invalid(client);
        return;
      case 'input':
        // The slot always comes from the server-side session, never the message.
        this.sendHost(room, { t: 'input', slot: p.slot, x: msg.x, y: msg.y, b: msg.b, seq: msg.seq });
        return;
      case 'ctrl:ready':
        p.ready = msg.ready;
        this.sendHost(room, { t: 'player:ready', slot: p.slot, ready: p.ready });
        return;
      case 'ctrl:leave':
        room.players.delete(p.slot);
        client.room = null;
        this.sendHost(room, { t: 'player:left', slot: p.slot, permanent: true });
        this.updateEmptyTimer(room);
        client.ws.close(1000, 'left');
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  /** A room with no connected phones expires after EMPTY_ROOM_MS. */
  private updateEmptyTimer(room: Room): void {
    const anyPhone = [...room.players.values()].some((p) => p.client !== null);
    if (anyPhone) {
      this.clearTimer(room, 'emptyTimer');
    } else if (!room.emptyTimer) {
      room.emptyTimer = setTimeout(() => this.deleteRoom(room, 'expired'), EMPTY_ROOM_MS);
    }
  }

  private clearTimer(room: Room, key: 'hostGoneTimer' | 'emptyTimer'): void {
    const timer = room[key];
    if (timer) clearTimeout(timer);
    room[key] = null;
  }

  deleteRoom(room: Room, reason: 'host-left' | 'expired' | 'server'): void {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    this.clearTimer(room, 'hostGoneTimer');
    this.clearTimer(room, 'emptyTimer');
    for (const p of room.players.values()) {
      if (!p.client) continue;
      this.sendTo(p.client, { t: 'room:closed', reason });
      p.client.room = null;
      p.client.ws.close(1000, reason);
    }
    room.players.clear();
    if (room.host) {
      this.sendTo(room.host, { t: 'room:closed', reason: reason === 'host-left' ? 'expired' : reason });
      room.host.room = null;
      room.host.ws.close(1000, reason);
      room.host = null;
    }
    this.log(`room ${room.code}: deleted (${reason}, ${this.rooms.size} rooms left)`);
  }

  closeAll(): void {
    for (const room of [...this.rooms.values()]) this.deleteRoom(room, 'server');
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private error(client: Client, code: ErrorCode, message: string): void {
    this.sendTo(client, { t: 'error', code, message });
  }

  private sendTo(client: Client, msg: ServerToHost | ServerToCtrl): void {
    this.sendRaw(client, JSON.stringify(msg));
  }

  private sendRaw(client: Client, data: string): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(data);
  }

  private sendHost(room: Room, msg: ServerToHost): void {
    if (room.host) this.sendTo(room.host, msg);
  }

  private broadcastCtrl(room: Room, msg: ServerToCtrl): void {
    this.broadcastCtrlRaw(room, JSON.stringify(msg));
  }

  private broadcastCtrlRaw(room: Room, data: string): void {
    for (const p of room.players.values()) if (p.client) this.sendRaw(p.client, data);
  }
}
