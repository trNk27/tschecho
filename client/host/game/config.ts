// Gameplay tuning. All times in seconds, distances in world units.

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

export const WORLD_SIZE = 140; // terrain square, the island is ~110 across
export const ISLAND_RADIUS = 64;
export const WATER_LEVEL = 0;
export const SHORE_LIMIT = 0.22; // players cannot walk below this height

export const PHASE_TIME = { day: 120, dusk: 20, night: 90 } as const;
export const DAWN_BLEND = 8; // first seconds of a day blend from night colours

export const PLAYER = {
  speed: 5.4,
  radius: 0.42,
  maxHp: 100,
  maxFood: 100,
  foodDrain: 0.4,
  starveDamage: 2.2,
  regen: 0.6,
  regenNearFire: 2.2,
  reviveTime: 3,
  reviveHp: 40,
  reviveRange: 1.8,
  attackCooldown: 0.42,
  attackRange: 2.0,
  attackDamage: 1,
  reach: 1.4,
  berryFood: 24,
  berryHp: 6,
} as const;

export const CARRY_MAX = { wood: 8, stone: 6, berry: 5, fuel: 2, can: 3 } as const;

export const RESOURCES = {
  treeWood: 4,
  chopTime: 0.85,
  rockStone: 3,
  mineTime: 1.15,
  bushBerries: 3,
  treeRegrowChance: 0.55,
  rockRespawnChance: 0.45,
} as const;

export const FIRE = {
  maxFuel: 100,
  startFuel: 78,
  woodFuel: 9,
  drain: { day: 0.3, dusk: 0.45, night: 0.66 },
  minRadius: 2.6,
  maxRadius: 13,
  ringRadius: 1.15, // stone ring collider
  feedRange: 3.4,
} as const;

export const TORCH = { cost: 2, radius: 5.5, max: 12 } as const;
export const WALL = { cost: 3, length: 2.4, thickness: 0.55, hp: 8, max: 30 } as const;

export const CREATURE = {
  radius: 0.55,
  speed: 2.3,
  speedPerNight: 0.12,
  hp: 3,
  damage: 14,
  attackCooldown: 1.1,
  attackRange: 0.75,
  aggroRange: 18,
  burnDps: 1.2,
  maxAlive: 28,
  spawnWindow: 0.55, // fraction of the night during which they keep arriving
} as const;

export const MAX_ITEMS_ON_GROUND = 40;

// ---------------------------------------------------------------------------
// Abandoned city, zombies and gear
// ---------------------------------------------------------------------------

export const CITY = {
  blocks: 4, // 4 x 4 city blocks
  blockCells: 9, // terrain cells per block incl. one road
  roadCells: 3,
  height: 1.3,
  distance: 36, // city centre from the campfire
} as const;

/** 0 = outskirts, 1 = midtown, 2 = downtown. */
export const DISTRICT_NAMES = ['Outskirts', 'Midtown', 'Downtown'] as const;

export const ZOMBIE = {
  radius: 0.42,
  hp: 3,
  hpPerNight: 0.5,
  speedWander: 0.9,
  speedChase: 2.1,
  speedNight: 2.6,
  speedPerNight: 0.12,
  damage: 12,
  attackCooldown: 1.2,
  attackRange: 0.7,
  aggroDay: 7.5,
  aggroNight: 11,
  max: 84, // total, so the nightly horde always has room
  cityMax: 60,
  /** Zombies per city block by district, before scaling with night and players. */
  perBlock: [0.8, 2.2, 4.2],
  trampleFuel: 1.6, // fuel per second each zombie stamps out of the fire
} as const;

export const SEARCH_TIME = 1.4;

export type WeaponKind = 'bat' | 'machete' | 'pistol';
export type ArmorKind = 'jacket' | 'armor';
export type GearKind = WeaponKind | ArmorKind | 'ammo';

export const WEAPONS: Record<WeaponKind | 'fists', { damage: number; cooldown: number; range: number }> = {
  fists: { damage: 1, cooldown: 0.42, range: 2.0 },
  bat: { damage: 2, cooldown: 0.45, range: 2.2 },
  machete: { damage: 3, cooldown: 0.38, range: 2.2 },
  pistol: { damage: 3, cooldown: 0.35, range: 11 },
};

export const ARMOR: Record<ArmorKind, number> = { jacket: 0.3, armor: 0.55 };
export const PISTOL_AMMO = 12;
export const AMMO_PICKUP = 10;
export const GAS_FUEL = 22;
export const CAN_FOOD = 45;
export const MAX_GEAR_ON_GROUND = 30;
