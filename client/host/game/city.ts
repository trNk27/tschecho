// The abandoned city: a 4 x 4 grid of blocks on one side of the island.
// The four inner blocks are downtown (many zombies, the best loot), the ring
// blocks facing the camp are the outskirts (few zombies, basic loot) and the
// rest is midtown.

import { CITY } from './config';

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export type Tier = 0 | 1 | 2;

export interface CityBlock extends Rect {
  tier: Tier;
  park: boolean;
}

export interface BuildingDef extends Rect {
  h: number;
  house: boolean;
  ruined: boolean;
  shade: number;
  tier: Tier;
}

export interface CarDef {
  x: number;
  z: number;
  rot: number;
  color: number;
  tilt: number;
}

export interface ContainerDef {
  x: number;
  z: number;
  rot: number;
  kind: 'car' | 'crate';
  tier: Tier;
  /** Index into cars or crates. */
  ref: number;
}

export interface PropXZ {
  x: number;
  z: number;
  rot: number;
  scale: number;
}

export interface CityLayout extends Rect {
  cx: number;
  cz: number;
  /** Direction from the camp towards the city (unit vector). */
  dirX: number;
  dirZ: number;
  blocks: CityBlock[];
  buildings: BuildingDef[];
  cars: CarDef[];
  crates: PropXZ[];
  containers: ContainerDef[];
  rubble: PropXZ[];
  lamps: PropXZ[];
  dashes: PropXZ[];
  cell: number;
}

const CELLS = CITY.blocks * CITY.blockCells + CITY.roadCells;

export const CAR_LENGTH = 3.0;
export const CAR_WIDTH = 1.5;

/** 0 = outside, 1 = road, 2 = lot, 3 = park */
export function cityCellType(c: CityLayout, x: number, z: number): number {
  if (x < c.x0 || x >= c.x1 || z < c.z0 || z >= c.z1) return 0;
  const ix = Math.floor((x - c.x0) / c.cell);
  const iz = Math.floor((z - c.z0) / c.cell);
  if (ix % CITY.blockCells < CITY.roadCells || iz % CITY.blockCells < CITY.roadCells) return 1;
  const b = blockIndexAt(c, x, z);
  return b >= 0 && c.blocks[b].park ? 3 : 2;
}

export function blockIndexAt(c: CityLayout, x: number, z: number): number {
  if (x < c.x0 || x >= c.x1 || z < c.z0 || z >= c.z1) return -1;
  const span = CITY.blockCells * c.cell;
  const bx = Math.min(CITY.blocks - 1, Math.floor((x - c.x0) / span));
  const bz = Math.min(CITY.blocks - 1, Math.floor((z - c.z0) / span));
  return bz * CITY.blocks + bx;
}

/** Distance from a point to the city rectangle (0 inside). */
export function distToCity(c: CityLayout, x: number, z: number): number {
  const dx = Math.max(c.x0 - x, 0, x - c.x1);
  const dz = Math.max(c.z0 - z, 0, z - c.z1);
  return Math.hypot(dx, dz);
}

export function generateCity(rnd: () => number, worldHalf: number, cell: number): CityLayout {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const [dirX, dirZ] = dirs[Math.floor(rnd() * 4)];
  const off = (rnd() - 0.5) * 10;
  const cx = dirX * CITY.distance + dirZ * off;
  const cz = dirZ * CITY.distance + dirX * off;
  const size = CELLS * cell;
  const snap = (v: number) => -worldHalf + Math.round((v + worldHalf) / cell) * cell;
  const x0 = snap(cx - size / 2);
  const z0 = snap(cz - size / 2);
  const c: CityLayout = {
    x0,
    z0,
    x1: x0 + size,
    z1: z0 + size,
    cx: x0 + size / 2,
    cz: z0 + size / 2,
    dirX,
    dirZ,
    blocks: [],
    buildings: [],
    cars: [],
    crates: [],
    containers: [],
    rubble: [],
    lamps: [],
    dashes: [],
    cell,
  };

  const span = CITY.blockCells * cell;
  const road = CITY.roadCells * cell;

  // Blocks and districts.
  const ring: { i: number; d: number }[] = [];
  for (let bz = 0; bz < CITY.blocks; bz++) {
    for (let bx = 0; bx < CITY.blocks; bx++) {
      const bx0 = x0 + bx * span + road;
      const bz0 = z0 + bz * span + road;
      const inner = bx > 0 && bx < CITY.blocks - 1 && bz > 0 && bz < CITY.blocks - 1;
      const block: CityBlock = { x0: bx0, z0: bz0, x1: bx0 + span - road, z1: bz0 + span - road, tier: inner ? 2 : 1, park: false };
      c.blocks.push(block);
      if (!inner) ring.push({ i: c.blocks.length - 1, d: Math.hypot(bx0 + (span - road) / 2, bz0 + (span - road) / 2) });
    }
  }
  ring.sort((a, b) => a.d - b.d);
  ring.slice(0, 6).forEach((r) => (c.blocks[r.i].tier = 0));
  const outskirts = ring.slice(0, 6).map((r) => r.i);
  for (let k = 0; k < 2; k++) {
    const pick = outskirts.splice(Math.floor(rnd() * outskirts.length), 1)[0];
    if (pick !== undefined) c.blocks[pick].park = true;
  }

  // Buildings.
  const addBuilding = (x0b: number, z0b: number, w: number, d: number, h: number, house: boolean, tier: Tier) => {
    const ruined = !house && rnd() < 0.2;
    const b: BuildingDef = {
      x0: x0b,
      z0: z0b,
      x1: x0b + w,
      z1: z0b + d,
      h: ruined ? h * (0.35 + rnd() * 0.2) : h,
      house,
      ruined,
      shade: rnd(),
      tier,
    };
    c.buildings.push(b);
    if (ruined) {
      for (let k = 0; k < 5; k++) {
        const side = rnd() < 0.5;
        c.rubble.push({
          x: side ? x0b + rnd() * w : rnd() < 0.5 ? x0b - 0.4 : x0b + w + 0.4,
          z: side ? (rnd() < 0.5 ? z0b - 0.4 : z0b + d + 0.4) : z0b + rnd() * d,
          rot: rnd() * Math.PI * 2,
          scale: 0.5 + rnd() * 0.6,
        });
      }
    }
  };

  const parkCars: { x: number; z: number }[] = [];
  for (const block of c.blocks) {
    if (block.park) continue;
    const L = block.x1 - block.x0;
    const inset = 0.45;
    if (block.tier === 2) {
      if (rnd() < 0.55) {
        addBuilding(block.x0 + inset, block.z0 + inset, L - inset * 2, L - inset * 2, 9 + rnd() * 6, false, 2);
      } else {
        const half = (L - inset * 2 - 0.6) / 2;
        addBuilding(block.x0 + inset, block.z0 + inset, L - inset * 2, half, 7 + rnd() * 5, false, 2);
        addBuilding(block.x0 + inset, block.z0 + inset + half + 0.6, L - inset * 2, half, 7 + rnd() * 5, false, 2);
      }
      continue;
    }
    const sub = L / 2;
    for (let sz = 0; sz < 2; sz++) {
      for (let sx = 0; sx < 2; sx++) {
        const lx = block.x0 + sx * sub;
        const lz = block.z0 + sz * sub;
        const r = rnd();
        if (r < (block.tier === 0 ? 0.2 : 0.15)) {
          parkCars.push({ x: lx + sub / 2, z: lz + sub / 2 });
          continue;
        }
        const w = block.tier === 0 ? 2.5 + rnd() * 0.5 : 2.8 + rnd() * 0.5;
        const d = block.tier === 0 ? 2.5 + rnd() * 0.5 : 2.8 + rnd() * 0.5;
        const h = block.tier === 0 ? 2.2 + rnd() * 0.6 : 4 + rnd() * 4;
        addBuilding(lx + (sub - w) / 2, lz + (sub - d) / 2, w, d, h, block.tier === 0, block.tier);
      }
    }
  }

  // Cars along the roads (and a few in parking lots).
  const carFree = (x: number, z: number) => c.cars.every((o) => Math.hypot(o.x - x, o.z - z) > 3.2);
  const addCar = (x: number, z: number, rot: number) => {
    if (!carFree(x, z)) return;
    c.cars.push({ x, z, rot, color: Math.floor(rnd() * 8), tilt: rnd() < 0.15 ? (rnd() - 0.5) * 0.3 : 0 });
  };
  for (let k = 0; k <= CITY.blocks; k++) {
    const mid = (k * span + road / 2) as number;
    for (let n = 0; n < 4; n++) {
      const t = 1 + rnd() * (CELLS * cell - 2);
      const lat = (rnd() - 0.5) * 1.6;
      const turn = (rnd() - 0.5) * 0.9 + (rnd() < 0.5 ? Math.PI : 0);
      if (rnd() < 0.5) addCar(x0 + t, z0 + mid + lat, turn);
      else addCar(x0 + mid + lat, z0 + t, Math.PI / 2 + turn);
    }
  }
  for (const p of parkCars) addCar(p.x, p.z, rnd() * Math.PI);

  // Dumpsters and supply crates on the pavement next to the blocks.
  c.blocks.forEach((block) => {
    const n = block.park ? 0 : block.tier === 2 ? 2 : block.tier === 1 ? 1 : rnd() < 0.6 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const side = Math.floor(rnd() * 4);
      const t = 0.15 + rnd() * 0.7;
      const L = block.x1 - block.x0;
      const pos = [
        [block.x0 + t * L, block.z0 - 0.75],
        [block.x0 + t * L, block.z1 + 0.75],
        [block.x0 - 0.75, block.z0 + t * L],
        [block.x1 + 0.75, block.z0 + t * L],
      ][side];
      if (c.cars.some((o) => Math.hypot(o.x - pos[0], o.z - pos[1]) < 2.4)) continue;
      c.crates.push({ x: pos[0], z: pos[1], rot: side < 2 ? 0 : Math.PI / 2, scale: 1 });
    }
  });

  // Containers: every car and crate can be searched once a day.
  const tierAt = (x: number, z: number): Tier => {
    const b = blockIndexAt(c, x, z);
    return b >= 0 ? c.blocks[b].tier : 0;
  };
  c.cars.forEach((car, i) => c.containers.push({ x: car.x, z: car.z, rot: car.rot, kind: 'car', tier: tierAt(car.x, car.z), ref: i }));
  c.crates.forEach((cr, i) => c.containers.push({ x: cr.x, z: cr.z, rot: cr.rot, kind: 'crate', tier: tierAt(cr.x, cr.z), ref: i }));

  // Street lamps at block corners, some knocked over.
  for (const block of c.blocks) {
    for (const [x, z] of [
      [block.x0 - 0.35, block.z0 - 0.35],
      [block.x1 + 0.35, block.z1 + 0.35],
    ]) {
      c.lamps.push({ x, z, rot: rnd() * Math.PI * 2, scale: rnd() < 0.2 ? -1 : 1 });
    }
  }

  // Faded lane markings, skipping intersections.
  for (let k = 0; k <= CITY.blocks; k++) {
    const mid = k * span + road / 2;
    for (let t = 1; t < CELLS * cell; t += 2.4) {
      if (t % span < road + 0.3) continue;
      if (rnd() < 0.25) continue; // worn away
      c.dashes.push({ x: x0 + t, z: z0 + mid, rot: 0, scale: 1 });
      c.dashes.push({ x: x0 + mid, z: z0 + t, rot: Math.PI / 2, scale: 1 });
    }
  }

  // Debris in the streets.
  for (let k = 0; k < 40; k++) {
    const x = x0 + rnd() * size;
    const z = z0 + rnd() * size;
    if (cityCellType(c, x, z) !== 1) continue;
    c.rubble.push({ x, z, rot: rnd() * Math.PI * 2, scale: 0.3 + rnd() * 0.4 });
  }

  return c;
}
