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

export const CARRY_MAX = { wood: 8, stone: 6, berry: 5 } as const;

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
