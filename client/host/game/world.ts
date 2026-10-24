// Island generation from a seed. Everything here is deterministic, so the
// simulation only has to store the seed plus what changed (chopped trees etc.).

import { ISLAND_RADIUS, SHORE_LIMIT, WORLD_SIZE } from './config';
import { clamp, fbm, lerp, mulberry32, smoothstep } from './rng';

export interface TreeDef {
  x: number;
  z: number;
  kind: 0 | 1; // 0 = pine, 1 = round
  scale: number;
  rot: number;
  r: number; // collider radius
}

export interface RockDef {
  x: number;
  z: number;
  scale: number;
  rot: number;
  r: number;
}

export interface PropDef {
  x: number;
  z: number;
  scale: number;
  rot: number;
  shade: number;
}

export const GRID_RES = 112;
const COLLIDER_CELL = 4;

export class World {
  readonly size = WORLD_SIZE;
  readonly half = WORLD_SIZE / 2;
  readonly res = GRID_RES;
  readonly cell = WORLD_SIZE / GRID_RES;
  readonly heights: Float32Array;
  readonly trees: TreeDef[] = [];
  readonly rocks: RockDef[] = [];
  readonly bushes: PropDef[] = [];
  readonly grass: PropDef[] = [];
  readonly flowers: PropDef[] = [];
  /** Static collider lookup: cell index -> packed (type << 16 | index). type 0 = tree, 1 = rock. */
  private colliderCells: Map<number, number[]> = new Map();

  constructor(readonly seed: number) {
    const n = this.res + 1;
    this.heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        this.heights[j * n + i] = this.rawHeight(-this.half + i * this.cell, -this.half + j * this.cell);
      }
    }
    this.scatter();
  }

  /** The smooth height function the grid is sampled from. */
  private rawHeight(x: number, z: number): number {
    const s = this.seed;
    const d = Math.hypot(x, z);
    const ang = Math.atan2(z, x);
    const coast =
      ISLAND_RADIUS * (0.84 + 0.26 * fbm(Math.cos(ang) * 1.4 + 9, Math.sin(ang) * 1.4 + 9, s + 7, 3)) +
      (fbm(x * 0.05 + 30, z * 0.05 - 20, s + 11, 2) - 0.5) * 10;
    const t = d / coast;
    const mask = 1 - smoothstep(0.6, 1.0, t);
    const hillAmp = 0.35 + 0.65 * smoothstep(8, 34, d);
    const hills = fbm(x * 0.03, z * 0.03, s, 4);
    const ridges = fbm(x * 0.09 + 100, z * 0.09, s + 3, 3);
    const land = 0.9 + (hills * 4.6 + ridges * 1.2 - 2.1) * hillAmp;
    let h = lerp(-3.2, Math.max(land, 0.75), mask);
    // Flat clearing for the campfire.
    const c = smoothstep(10, 4.5, d);
    h = lerp(h, 1.1, c);
    return h;
  }

  /** Height of the rendered (triangulated) terrain at a world position. */
  heightAt(x: number, z: number): number {
    const gx = clamp((x + this.half) / this.cell, 0, this.res - 0.0001);
    const gz = clamp((z + this.half) / this.cell, 0, this.res - 0.0001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const n = this.res + 1;
    const h00 = this.heights[j * n + i];
    const h10 = this.heights[j * n + i + 1];
    const h01 = this.heights[(j + 1) * n + i];
    const h11 = this.heights[(j + 1) * n + i + 1];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  isWalkable(x: number, z: number): boolean {
    if (Math.abs(x) > this.half - 2 || Math.abs(z) > this.half - 2) return false;
    return this.heightAt(x, z) >= SHORE_LIMIT;
  }

  slopeAt(x: number, z: number): number {
    const e = 0.6;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  }

  /** Forest density in [0, 1]; also used to darken grass under trees. */
  forestAt(x: number, z: number): number {
    return smoothstep(0.42, 0.62, fbm(x * 0.045 + 50, z * 0.045 - 70, this.seed + 21, 3));
  }

  private scatter(): void {
    const rnd = mulberry32(this.seed ^ 0x9e3779b9);
    const taken: { x: number; z: number; r: number }[] = [];
    const free = (x: number, z: number, r: number) => {
      for (const t of taken) {
        const dx = t.x - x;
        const dz = t.z - z;
        const m = t.r + r;
        if (dx * dx + dz * dz < m * m) return false;
      }
      return true;
    };
    const randPoint = (maxR: number) => {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * maxR;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r };
    };

    const addTree = (x: number, z: number) => {
      const scale = 0.8 + rnd() * 0.55;
      const kind: 0 | 1 = rnd() < 0.62 ? 0 : 1;
      this.trees.push({ x, z, kind, scale, rot: rnd() * Math.PI * 2, r: 0.42 * scale });
      taken.push({ x, z, r: 1.1 * scale });
    };

    // A ring of trees fairly close to the fire so day 1 starts quickly.
    for (let k = 0, tries = 0; k < 14 && tries < 400; tries++) {
      const a = rnd() * Math.PI * 2;
      const r = 13 + rnd() * 9;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = this.heightAt(x, z);
      if (h < 0.8 || this.slopeAt(x, z) > 0.9 || !free(x, z, 1.2)) continue;
      addTree(x, z);
      k++;
    }

    // Forests.
    for (let tries = 0; tries < 9000 && this.trees.length < 230; tries++) {
      const { x, z } = randPoint(ISLAND_RADIUS * 1.05);
      const d = Math.hypot(x, z);
      if (d < 11) continue;
      const h = this.heightAt(x, z);
      if (h < 0.85 || this.slopeAt(x, z) > 0.95) continue;
      const density = 0.12 + this.forestAt(x, z) * 0.88;
      if (rnd() > density) continue;
      if (!free(x, z, 1.15)) continue;
      addTree(x, z);
    }

    // Rocks: more on high ground and beaches.
    for (let tries = 0; tries < 5000 && this.rocks.length < 60; tries++) {
      const { x, z } = randPoint(ISLAND_RADIUS * 1.05);
      const d = Math.hypot(x, z);
      if (d < 10) continue;
      const h = this.heightAt(x, z);
      if (h < 0.35) continue;
      const p = h > 2.6 ? 0.9 : h < 0.7 ? 0.5 : 0.22;
      if (rnd() > p) continue;
      const scale = 0.7 + rnd() * 0.7;
      if (!free(x, z, 1.3 * scale)) continue;
      this.rocks.push({ x, z, scale, rot: rnd() * Math.PI * 2, r: 0.75 * scale });
      taken.push({ x, z, r: 1.3 * scale });
    }

    // Berry bushes: a few close to camp, the rest spread out.
    for (let tries = 0; tries < 5000 && this.bushes.length < 46; tries++) {
      const near = this.bushes.length < 6;
      const { x, z } = near ? randPoint(24) : randPoint(ISLAND_RADIUS);
      const d = Math.hypot(x, z);
      if (d < (near ? 9 : 14)) continue;
      const h = this.heightAt(x, z);
      if (h < 0.8 || this.slopeAt(x, z) > 0.9) continue;
      if (!free(x, z, 1.0)) continue;
      this.bushes.push({ x, z, scale: 0.85 + rnd() * 0.35, rot: rnd() * Math.PI * 2, shade: rnd() });
      taken.push({ x, z, r: 1.0 });
    }

    // Decoration (no colliders).
    for (let tries = 0; tries < 12000 && this.grass.length < 1500; tries++) {
      const { x, z } = randPoint(ISLAND_RADIUS * 1.05);
      const h = this.heightAt(x, z);
      if (h < 0.7 || Math.hypot(x, z) < 3.5) continue;
      this.grass.push({ x, z, scale: 0.6 + rnd() * 0.8, rot: rnd() * Math.PI * 2, shade: rnd() });
    }
    for (let tries = 0; tries < 6000 && this.flowers.length < 260; tries++) {
      const { x, z } = randPoint(ISLAND_RADIUS);
      const h = this.heightAt(x, z);
      if (h < 0.9 || Math.hypot(x, z) < 6 || this.forestAt(x, z) > 0.5) continue;
      this.flowers.push({ x, z, scale: 0.7 + rnd() * 0.6, rot: rnd() * Math.PI * 2, shade: rnd() });
    }

    this.trees.forEach((t, i) => this.addCollider(t.x, t.z, t.r + 1, (0 << 16) | i));
    this.rocks.forEach((r, i) => this.addCollider(r.x, r.z, r.r + 1, (1 << 16) | i));
  }

  private cellKey(cx: number, cz: number): number {
    return (cz + 512) * 1024 + (cx + 512);
  }

  private addCollider(x: number, z: number, r: number, packed: number): void {
    const x0 = Math.floor((x - r) / COLLIDER_CELL);
    const x1 = Math.floor((x + r) / COLLIDER_CELL);
    const z0 = Math.floor((z - r) / COLLIDER_CELL);
    const z1 = Math.floor((z + r) / COLLIDER_CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = this.cellKey(cx, cz);
        let list = this.colliderCells.get(key);
        if (!list) this.colliderCells.set(key, (list = []));
        list.push(packed);
      }
    }
  }

  /** Packed static colliders (type << 16 | index) near a point. */
  collidersNear(x: number, z: number): readonly number[] {
    return this.colliderCells.get(this.cellKey(Math.floor(x / COLLIDER_CELL), Math.floor(z / COLLIDER_CELL))) ?? EMPTY;
  }

  /** Random walkable point on the island, used to spawn creatures. */
  randomShorePoint(rnd: () => number): { x: number; z: number } | null {
    for (let k = 0; k < 40; k++) {
      const a = rnd() * Math.PI * 2;
      // Walk inwards from the sea until we hit land.
      for (let r = ISLAND_RADIUS * 1.1; r > 12; r -= 1.5) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (this.isWalkable(x, z) && this.heightAt(x, z) > 0.45) {
          const inset = 2 + rnd() * 6;
          const px = Math.cos(a) * (r - inset);
          const pz = Math.sin(a) * (r - inset);
          if (this.isWalkable(px, pz)) return { x: px, z: pz };
          break;
        }
      }
    }
    return null;
  }
}

const EMPTY: number[] = [];
