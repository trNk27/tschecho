// Message types and schemas for the Ember WebSocket protocol.
// The server validates every incoming message with these schemas. Browser code
// only imports the types from here (`import type`), so zod stays out of the
// client bundles.

import { z } from 'zod';
import {
  GAME_STATES,
  HAPTIC_PATTERNS,
  ITEM_TYPES,
  MAX_PLAYERS,
  ROOM_CODE_RE,
  type GameStateName,
  type HapticPattern,
  type ItemType,
} from './constants';

const slot = z.number().int().min(1).max(MAX_PLAYERS);
const roomCode = z.string().regex(ROOM_CODE_RE);
const token = z.uuid();
const label = z.string().max(24);

// ---------------------------------------------------------------------------
// Laptop (host) -> server
// ---------------------------------------------------------------------------

export const hostCreateSchema = z.object({ t: z.literal('host:create') }).strict();

export const hostResumeSchema = z
  .object({ t: z.literal('host:resume'), room: roomCode, token })
  .strict();

export const hudSchema = z
  .object({
    t: z.literal('hud'),
    slot,
    hp: z.number().min(0).max(100),
    food: z.number().min(0).max(100),
    item: z
      .object({ type: z.enum(ITEM_TYPES), count: z.number().int().min(0).max(99) })
      .strict()
      .nullable(),
    hint: z.string().max(48),
    gear: z.string().max(24),
    a: label,
    b: label,
    c: label,
    downed: z.boolean(),
    progress: z.number().min(0).max(1),
  })
  .strict();

export const hapticSchema = z
  .object({ t: z.literal('haptic'), slot, pattern: z.enum(HAPTIC_PATTERNS) })
  .strict();

export const gameStateSchema = z
  .object({
    t: z.literal('game:state'),
    state: z.enum(GAME_STATES),
    night: z.number().int().min(0).max(99),
    nights: z.number().int().min(1).max(99),
    won: z.boolean().optional(),
    reason: z.string().max(80).optional(),
  })
  .strict();

export const hostKickSchema = z.object({ t: z.literal('host:kick'), slot }).strict();

export const hostMessageSchema = z.discriminatedUnion('t', [
  hostCreateSchema,
  hostResumeSchema,
  hudSchema,
  hapticSchema,
  gameStateSchema,
  hostKickSchema,
]);

// ---------------------------------------------------------------------------
// Phone (controller) -> server
// ---------------------------------------------------------------------------

export const ctrlJoinSchema = z
  .object({
    t: z.literal('ctrl:join'),
    room: roomCode,
    name: z.string().max(64),
    token: token.optional(),
  })
  .strict();

export const inputSchema = z
  .object({
    t: z.literal('input'),
    x: z.number().min(-1).max(1),
    y: z.number().min(-1).max(1),
    b: z.number().int().min(0).max(7),
    seq: z.number().int().min(0).max(2 ** 31),
  })
  .strict();

export const ctrlReadySchema = z.object({ t: z.literal('ctrl:ready'), ready: z.boolean() }).strict();
export const ctrlLeaveSchema = z.object({ t: z.literal('ctrl:leave') }).strict();

export const ctrlMessageSchema = z.discriminatedUnion('t', [
  ctrlJoinSchema,
  inputSchema,
  ctrlReadySchema,
  ctrlLeaveSchema,
]);

/** Any message a socket may send before it has a role. */
export const firstMessageSchema = z.discriminatedUnion('t', [
  hostCreateSchema,
  hostResumeSchema,
  ctrlJoinSchema,
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
export type CtrlMessage = z.infer<typeof ctrlMessageSchema>;
export type HudMessage = z.infer<typeof hudSchema>;
export type GameStateMessage = z.infer<typeof gameStateSchema>;

// ---------------------------------------------------------------------------
// Server -> clients (the server builds these, so plain types are enough)
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  slot: number;
  playerId: string;
  name: string;
  color: string;
  connected: boolean;
  ready: boolean;
}

export type ErrorCode =
  | 'room-not-found'
  | 'room-full'
  | 'too-many-rooms'
  | 'bad-token'
  | 'bad-name'
  | 'invalid'
  | 'rate-limit';

export type ServerToHost =
  | { t: 'host:room'; room: string; token: string; players: PlayerInfo[]; resumed: boolean }
  | ({ t: 'player:joined'; reconnected: boolean } & PlayerInfo)
  | { t: 'player:left'; slot: number; permanent: boolean }
  | { t: 'player:ready'; slot: number; ready: boolean }
  | { t: 'input'; slot: number; x: number; y: number; b: number; seq: number }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'room:closed'; reason: 'expired' | 'replaced' | 'server' };

export interface HudPayload {
  hp: number;
  food: number;
  item: { type: ItemType; count: number } | null;
  hint: string;
  gear: string;
  a: string;
  b: string;
  c: string;
  downed: boolean;
  progress: number;
}

export interface GameStatePayload {
  state: GameStateName;
  night: number;
  nights: number;
  won?: boolean;
  reason?: string;
}

export type ServerToCtrl =
  | {
      t: 'joined';
      room: string;
      slot: number;
      playerId: string;
      token: string;
      name: string;
      color: string;
      ready: boolean;
      hostOnline: boolean;
    }
  | ({ t: 'hud' } & HudPayload)
  | { t: 'haptic'; pattern: HapticPattern }
  | ({ t: 'game:state' } & GameStatePayload)
  | { t: 'host:status'; online: boolean }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'room:closed'; reason: 'host-left' | 'expired' | 'kicked' | 'server' };
