// Values shared by the server, the laptop host and the phone controller.
// This file must not import zod so the browser bundles stay small.

export const MAX_PLAYERS = 4;
export const MAX_ROOMS = 50;
export const MAX_NAME_LENGTH = 12;
export const MAX_PAYLOAD_BYTES = 1024;

/** Letters without look-alikes (no I, O, L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

/** Slot colours, index = slot - 1. */
export const PLAYER_COLORS = ['#ff7a45', '#3fb6ff', '#8fe04a', '#d873ff'] as const;

/** Button bitmask used in `input` messages. */
export const BTN_A = 1;
export const BTN_B = 2;
export const BTN_C = 4;
export const BTN_MASK = BTN_A | BTN_B | BTN_C;

export const INPUT_HEARTBEAT_MS = 100;

export const HAPTIC_PATTERNS = ['hit', 'pickup', 'downed', 'alert'] as const;
export type HapticPattern = (typeof HAPTIC_PATTERNS)[number];

export const GAME_STATES = ['lobby', 'day', 'dusk', 'night', 'over'] as const;
export type GameStateName = (typeof GAME_STATES)[number];

export const ITEM_TYPES = ['wood', 'stone', 'berry', 'fuel', 'can'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

export function cleanName(name: string): string {
  // Collapse whitespace, strip control characters, trim, cap length.
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('');
}
