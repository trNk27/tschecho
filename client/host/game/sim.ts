// The game simulation. Runs on the laptop at a fixed 30 Hz tick. The whole
// state is plain JSON so it can be saved and restored after a page reload.

import { BTN_A, BTN_B, BTN_C, type ItemType } from '../../../shared/constants';
import type { HudPayload } from '../../../shared/protocol';
import { CAR_LENGTH, CAR_WIDTH } from './city';
import { CITY } from './config';
import {
  AMMO_PICKUP,
  ARMOR,
  CAN_FOOD,
  CARRY_MAX,
  CREATURE,
  DISTRICT_NAMES,
  DT,
  FIRE,
  GAS_FUEL,
  MAX_GEAR_ON_GROUND,
  MAX_ITEMS_ON_GROUND,
  PHASE_TIME,
  PISTOL_AMMO,
  PLAYER,
  RESOURCES,
  SEARCH_TIME,
  TORCH,
  WALL,
  WEAPONS,
  ZOMBIE,
  type ArmorKind,
  type GearKind,
  type WeaponKind,
} from './config';
import { clamp } from './rng';
import type { World } from './world';

export type Phase = 'day' | 'dusk' | 'night';

export interface Held {
  type: ItemType;
  count: number;
}

export interface PlayerState {
  slot: number;
  name: string;
  color: string;
  x: number;
  z: number;
  px: number;
  pz: number;
  fx: number;
  fz: number;
  speed: number; // 0..1 of max, for walk animation
  hp: number;
  food: number;
  downed: boolean;
  item: Held | null;
  actionTime: number;
  actionKind: '' | 'chop' | 'mine' | 'revive' | 'search';
  attackCd: number;
  swingT: number; // seconds since last swing
  hurtT: number;
  reviveProgress: number;
  connected: boolean;
  kills: number;
  woodBurned: number;
  weapon: WeaponKind | '';
  ammo: number;
  armor: ArmorKind | '';
  area: number; // -1 wilds, 0..2 city district
  areaT: number; // seconds since entering the area
}

export interface ZombieState {
  id: number;
  x: number;
  z: number;
  px: number;
  pz: number;
  fx: number;
  fz: number;
  hp: number;
  cd: number;
  block: number; // home city block
  horde: boolean; // marching on the camp
  wx: number; // wander target
  wz: number;
  wanderT: number;
  alertT: number; // heard a gunshot
  detourT: number;
  detour: number;
  hurtT: number;
  attackT: number;
  age: number;
  shade: number;
}

export interface GearDrop {
  id: number;
  kind: GearKind;
  x: number;
  z: number;
}

export interface CreatureState {
  id: number;
  x: number;
  z: number;
  px: number;
  pz: number;
  fx: number;
  fz: number;
  hp: number;
  cd: number;
  flee: boolean;
  fleeT: number;
  hurtT: number;
  age: number;
  orbit: number; // +1 / -1 direction when circling the light
  attackT: number; // seconds since last attack (animation)
}

export interface ItemState {
  id: number;
  type: ItemType;
  count: number;
  x: number;
  z: number;
}

export interface TorchState {
  id: number;
  x: number;
  z: number;
  expires: number; // burns out at the dawn after this night number
  age: number;
}

export interface WallState {
  id: number;
  x: number;
  z: number;
  ax: number; // unit vector along the wall
  az: number;
  hp: number;
}

export interface SimState {
  version: 2;
  seed: number;
  nights: number;
  night: number;
  phase: Phase;
  phaseTime: number;
  time: number;
  fuel: number;
  players: PlayerState[];
  creatures: CreatureState[];
  items: ItemState[];
  torches: TorchState[];
  walls: WallState[];
  zombies: ZombieState[];
  gear: GearDrop[];
  containers: number[]; // 1 = can be searched, 0 = already searched today
  hordeLeft: number;
  hordeTimer: number;
  hordeWarned: boolean;
  trees: number[]; // wood left, 0 = stump
  rocks: number[]; // stone left, 0 = gone
  bushes: number[]; // berries left
  spawnLeft: number;
  spawnTimer: number;
  nextId: number;
  rng: number;
  over: null | { won: boolean; reason: string };
  stats: { woodBurned: number; kills: number; zombies: number; revives: number; torches: number; walls: number; searched: number };
}

export type SimEvent =
  | { type: 'chop' | 'mine' | 'treeFell' | 'rockBreak' | 'pickup' | 'eat' | 'fuel' | 'build' | 'swing' | 'drop'; slot: number; x: number; z: number }
  | { type: 'hurt' | 'downed' | 'revived' | 'fail'; slot: number; x: number; z: number }
  | { type: 'creatureHit' | 'creatureDie' | 'creatureAttack' | 'creatureBurn' | 'spawn'; x: number; z: number }
  | { type: 'wallHit' | 'wallBreak'; x: number; z: number }
  | { type: 'shot'; slot: number; x: number; z: number; tx: number; tz: number }
  | { type: 'search' | 'gear'; slot: number; x: number; z: number }
  | { type: 'zombieHit' | 'zombieDie' | 'zombieAttack' | 'trample'; x: number; z: number }
  | { type: 'horde' }
  | { type: 'area'; slot: number; area: number }
  | { type: 'phase'; phase: Phase | 'dawn'; night: number }
  | { type: 'over'; won: boolean };

interface InputState {
  x: number;
  y: number;
  b: number;
  prevB: number;
  latched: number;
}

type Target =
  | { kind: 'revive'; slot: number; dist: number }
  | { kind: 'attack'; id: number; dist: number; zombie: boolean }
  | { kind: 'item'; id: number; dist: number; blocked: boolean }
  | { kind: 'gear'; id: number; dist: number }
  | { kind: 'container'; i: number; dist: number }
  | { kind: 'bush'; i: number; dist: number; blocked: boolean }
  | { kind: 'tree'; i: number; dist: number; blocked: boolean }
  | { kind: 'rock'; i: number; dist: number; blocked: boolean };

const ITEM_NAME: Record<ItemType, string> = {
  wood: 'wood',
  stone: 'stone',
  berry: 'berries',
  fuel: 'gas can',
  can: 'canned food',
};

export const GEAR_NAME: Record<GearKind, string> = {
  bat: 'baseball bat',
  machete: 'machete',
  pistol: 'pistol',
  jacket: 'leather jacket',
  armor: 'riot armour',
  ammo: 'ammo',
};

export const GEAR_ICON: Record<GearKind, string> = {
  bat: '🏏',
  machete: '🔪',
  pistol: '🔫',
  jacket: '🧥',
  armor: '🦺',
  ammo: '•',
};

type Loot = GearKind | 'fuel' | 'can' | 'wood';

/** Loot tables per district: [what, weight]. Better gear deeper in the city. */
const LOOT: Record<0 | 1 | 2, [Loot, number][]> = {
  0: [['can', 35], ['bat', 18], ['jacket', 12], ['wood', 20], ['fuel', 15]],
  1: [['can', 20], ['fuel', 25], ['machete', 16], ['ammo', 12], ['jacket', 10], ['bat', 10], ['pistol', 7]],
  2: [['fuel', 24], ['pistol', 18], ['ammo', 22], ['armor', 16], ['machete', 10], ['can', 10]],
};

export class Sim {
  readonly events: SimEvent[] = [];
  private inputs = new Map<number, InputState>();
  private targets = new Map<number, Target | null>();

  constructor(
    readonly world: World,
    public state: SimState,
  ) {}

  static newState(world: World, nights: number): SimState {
    const state: SimState = {
      version: 2,
      seed: world.seed,
      nights,
      night: 1,
      phase: 'day',
      phaseTime: 0,
      time: 0,
      fuel: FIRE.startFuel,
      players: [],
      creatures: [],
      items: [],
      torches: [],
      walls: [],
      zombies: [],
      gear: [],
      containers: world.city.containers.map(() => 1),
      hordeLeft: 0,
      hordeTimer: 0,
      hordeWarned: false,
      trees: world.trees.map(() => RESOURCES.treeWood),
      rocks: world.rocks.map(() => RESOURCES.rockStone),
      bushes: world.bushes.map(() => RESOURCES.bushBerries),
      spawnLeft: 0,
      spawnTimer: 0,
      nextId: 1,
      rng: (world.seed * 2654435761) >>> 0,
      over: null,
      stats: { woodBurned: 0, kills: 0, zombies: 0, revives: 0, torches: 0, walls: 0, searched: 0 },
    };
    new Sim(world, state).populateCity(1);
    return state;
  }

  // -------------------------------------------------------------------------
  // Players and input
  // -------------------------------------------------------------------------

  player(slot: number): PlayerState | undefined {
    return this.state.players.find((p) => p.slot === slot);
  }

  addPlayer(slot: number, name: string, color: string): void {
    const existing = this.player(slot);
    if (existing) {
      existing.name = name;
      existing.color = color;
      existing.connected = true;
      return;
    }
    const a = (slot - 1) * (Math.PI / 2) + Math.PI / 4;
    const x = Math.cos(a) * 3.2;
    const z = Math.sin(a) * 3.2;
    this.state.players.push({
      slot,
      name,
      color,
      x,
      z,
      px: x,
      pz: z,
      fx: 0,
      fz: 1,
      speed: 0,
      hp: PLAYER.maxHp,
      food: PLAYER.maxFood,
      downed: false,
      item: null,
      actionTime: 0,
      actionKind: '',
      attackCd: 0,
      swingT: 9,
      hurtT: 9,
      reviveProgress: 0,
      connected: true,
      kills: 0,
      woodBurned: 0,
      weapon: '',
      ammo: 0,
      armor: '',
      area: -1,
      areaT: 9,
    });
    this.state.players.sort((a, b) => a.slot - b.slot);
  }

  removePlayer(slot: number): void {
    const p = this.player(slot);
    if (p?.item) this.dropItem(p.x, p.z, p.item.type, p.item.count);
    this.state.players = this.state.players.filter((q) => q.slot !== slot);
    this.inputs.delete(slot);
  }

  setConnected(slot: number, connected: boolean): void {
    const p = this.player(slot);
    if (p) p.connected = connected;
    if (!connected) this.clearInput(slot);
  }

  clearInput(slot: number): void {
    const inp = this.inputs.get(slot);
    if (inp) {
      inp.x = 0;
      inp.y = 0;
      inp.b = 0;
      inp.latched = 0;
    }
  }

  setInput(slot: number, x: number, y: number, b: number): void {
    let inp = this.inputs.get(slot);
    if (!inp) this.inputs.set(slot, (inp = { x: 0, y: 0, b: 0, prevB: 0, latched: 0 }));
    // Clamp again here so a modified client cannot move faster.
    x = clamp(Number.isFinite(x) ? x : 0, -1, 1);
    y = clamp(Number.isFinite(y) ? y : 0, -1, 1);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    b &= BTN_A | BTN_B | BTN_C;
    inp.latched |= b & ~inp.b; // remember short taps between ticks
    inp.x = x;
    inp.y = y;
    inp.b = b;
  }

  get connectedCount(): number {
    return this.state.players.filter((p) => p.connected).length;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private random(): number {
    let a = (this.state.rng = (this.state.rng + 0x6d2b79f5) >>> 0);
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  }

  fireRadius(fuel = this.state.fuel): number {
    if (fuel <= 0) return 0;
    return FIRE.minRadius + (FIRE.maxRadius - FIRE.minRadius) * Math.sqrt(clamp(fuel / FIRE.maxFuel, 0, 1));
  }

  /** Is the point inside the fire's or a torch's light? */
  inLight(x: number, z: number, margin = 0): boolean {
    const fr = this.fireRadius() + margin;
    if (x * x + z * z < fr * fr) return true;
    const tr = TORCH.radius + margin;
    for (const t of this.state.torches) {
      const dx = x - t.x;
      const dz = z - t.z;
      if (dx * dx + dz * dz < tr * tr) return true;
    }
    return false;
  }

  /** Push a point out of every light circle it is inside. */
  private pushOutOfLight(pos: { x: number; z: number }, margin: number): void {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const fr = this.fireRadius() + margin;
      const d = Math.hypot(pos.x, pos.z);
      if (d < fr) {
        const s = d > 0.001 ? fr / d : 0;
        pos.x = d > 0.001 ? pos.x * s : fr;
        pos.z = d > 0.001 ? pos.z * s : 0;
        moved = true;
      }
      const tr = TORCH.radius + margin;
      for (const t of this.state.torches) {
        const dx = pos.x - t.x;
        const dz = pos.z - t.z;
        const dd = Math.hypot(dx, dz);
        if (dd < tr) {
          const s = dd > 0.001 ? tr / dd : 0;
          pos.x = t.x + (dd > 0.001 ? dx * s : tr);
          pos.z = t.z + (dd > 0.001 ? dz * s : 0);
          moved = true;
        }
      }
      if (!moved) return;
    }
  }

  private dropItem(x: number, z: number, type: ItemType, count: number): void {
    if (count <= 0) return;
    const s = this.state;
    // Merge into a nearby pile of the same type.
    for (const it of s.items) {
      if (it.type === type && Math.hypot(it.x - x, it.z - z) < 1.2 && it.count < 99) {
        it.count = Math.min(99, it.count + count);
        return;
      }
    }
    if (s.items.length >= MAX_ITEMS_ON_GROUND) s.items.shift();
    s.items.push({ id: s.nextId++, type, count, x, z });
  }

  /** Move an entity with collisions. Returns the index of a wall that blocked it, or -1. */
  private move(e: { x: number; z: number }, dx: number, dz: number, radius: number): number {
    const w = this.world;
    let nx = e.x + dx;
    let nz = e.z + dz;
    if (!w.isWalkable(nx, nz)) {
      if (w.isWalkable(nx, e.z)) nz = e.z;
      else if (w.isWalkable(e.x, nz)) nx = e.x;
      else return -1;
    }

    const s = this.state;
    const pos = { x: nx, z: nz };
    const pushCircle = (cx: number, cz: number, r: number) => {
      const ddx = pos.x - cx;
      const ddz = pos.z - cz;
      const min = r + radius;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 0.001;
        pos.x = cx + (ddx / d) * min;
        pos.z = cz + (ddz / d) * min;
      }
    };

    for (const packed of w.collidersNear(pos.x, pos.z)) {
      const type = packed >> 16;
      const i = packed & 0xffff;
      if (type === 0) {
        const t = w.trees[i];
        pushCircle(t.x, t.z, s.trees[i] > 0 ? t.r : t.r * 0.8);
      } else if (type === 1) {
        if (s.rocks[i] <= 0) continue;
        const r = w.rocks[i];
        pushCircle(r.x, r.z, r.r * (0.55 + 0.15 * s.rocks[i]));
      } else if (type === 2) {
        // Building: push out of the rectangle.
        const b = w.city.buildings[i];
        const qx = clamp(pos.x, b.x0, b.x1);
        const qz = clamp(pos.z, b.z0, b.z1);
        const ddx = pos.x - qx;
        const ddz = pos.z - qz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < radius * radius) {
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            pos.x = qx + (ddx / d) * radius;
            pos.z = qz + (ddz / d) * radius;
          } else {
            // Centre inside: leave by the nearest side.
            const out = [pos.x - b.x0, b.x1 - pos.x, pos.z - b.z0, b.z1 - pos.z];
            const m = out.indexOf(Math.min(...out));
            if (m === 0) pos.x = b.x0 - radius;
            else if (m === 1) pos.x = b.x1 + radius;
            else if (m === 2) pos.z = b.z0 - radius;
            else pos.z = b.z1 + radius;
          }
        }
      } else if (type === 3) {
        const c = w.city.cars[i];
        const ax = Math.cos(c.rot);
        const az = -Math.sin(c.rot);
        const off = (CAR_LENGTH - CAR_WIDTH) / 2;
        pushCircle(c.x + ax * off, c.z + az * off, CAR_WIDTH / 2);
        pushCircle(c.x - ax * off, c.z - az * off, CAR_WIDTH / 2);
      } else if (type === 4) {
        const c = w.city.crates[i];
        pushCircle(c.x, c.z, 0.65);
      }
    }
    pushCircle(0, 0, FIRE.ringRadius);

    let blockedBy = -1;
    for (let wi = 0; wi < s.walls.length; wi++) {
      const wall = s.walls[wi];
      const rx = pos.x - wall.x;
      const rz = pos.z - wall.z;
      const along = clamp(rx * wall.ax + rz * wall.az, -WALL.length / 2, WALL.length / 2);
      const cx = wall.x + wall.ax * along;
      const cz = wall.z + wall.az * along;
      const ddx = pos.x - cx;
      const ddz = pos.z - cz;
      const min = WALL.thickness / 2 + radius;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 0.001;
        pos.x = cx + (ddx / d) * min;
        pos.z = cz + (ddz / d) * min;
        blockedBy = wi;
      }
    }

    if (!w.isWalkable(pos.x, pos.z)) return blockedBy;
    e.x = pos.x;
    e.z = pos.z;
    return blockedBy;
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  step(): void {
    const s = this.state;
    if (s.over) return;
    s.time += DT;
    this.stepPhase();
    if (s.over) return;

    // Fire fuel.
    const pf = 0.75 + 0.125 * Math.max(1, s.players.length);
    const nf = 1 + 0.1 * (s.night - 1);
    s.fuel -= FIRE.drain[s.phase] * pf * nf * DT;
    if (s.fuel <= 0) {
      s.fuel = 0;
      this.end(false, `The fire went out on ${s.phase === 'day' ? 'day' : 'night'} ${s.night}.`);
      return;
    }

    for (const p of s.players) {
      p.px = p.x;
      p.pz = p.z;
    }
    for (const c of s.creatures) {
      c.px = c.x;
      c.pz = c.z;
    }
    for (const z of s.zombies) {
      z.px = z.x;
      z.pz = z.z;
    }

    for (const p of s.players) this.stepPlayer(p);
    this.separatePlayers();
    this.stepSpawning();
    this.stepCreatures();
    this.stepHorde();
    this.stepZombies();
    if (s.fuel <= 0) {
      s.fuel = 0;
      this.end(false, `Zombies stamped out the fire on ${s.phase === 'day' ? 'day' : 'night'} ${s.night}.`);
      return;
    }
    for (const t of s.torches) t.age += DT;

    for (const inp of this.inputs.values()) {
      inp.prevB = inp.b;
      inp.latched = 0;
    }

    const active = s.players.filter((p) => p.connected);
    if (active.length > 0 && active.every((p) => p.downed)) {
      this.end(false, active.length > 1 ? 'Everyone was downed.' : 'You were downed.');
    }
  }

  private end(won: boolean, reason: string): void {
    this.state.over = { won, reason };
    this.events.push({ type: 'over', won });
  }

  private stepPhase(): void {
    const s = this.state;
    s.phaseTime += DT;
    if (s.phase === 'day' && s.phaseTime >= PHASE_TIME.day) {
      s.phase = 'dusk';
      s.phaseTime = 0;
      this.events.push({ type: 'phase', phase: 'dusk', night: s.night });
    } else if (s.phase === 'dusk' && s.phaseTime >= PHASE_TIME.dusk) {
      s.phase = 'night';
      s.phaseTime = 0;
      const players = Math.max(1, s.players.length);
      s.spawnLeft = Math.round((2 + 1.6 * s.night) * (0.55 + 0.45 * players));
      s.spawnTimer = 0;
      // A zombie horde leaves the city and marches on the camp; bigger every night.
      s.hordeLeft = Math.round((1 + 1.4 * s.night) * (0.6 + 0.4 * players));
      s.hordeTimer = 6;
      s.hordeWarned = false;
      this.events.push({ type: 'phase', phase: 'night', night: s.night });
    } else if (s.phase === 'night' && s.phaseTime >= PHASE_TIME.night) {
      this.dawn();
    }
  }

  private dawn(): void {
    const s = this.state;
    for (const c of s.creatures) c.flee = true;
    s.spawnLeft = 0;
    s.torches = s.torches.filter((t) => t.expires > s.night);
    // The island recovers a little every morning.
    s.trees = s.trees.map((w) => (w > 0 ? RESOURCES.treeWood : this.random() < RESOURCES.treeRegrowChance ? RESOURCES.treeWood : 0));
    s.rocks = s.rocks.map((r) => (r > 0 ? r : this.random() < RESOURCES.rockRespawnChance ? RESOURCES.rockStone : 0));
    s.bushes = s.bushes.map(() => RESOURCES.bushBerries);
    // Survivors of the horde wander back; cars and crates partly refill.
    s.hordeLeft = 0;
    for (const z of s.zombies) z.horde = false;
    s.containers = s.containers.map((c) => (c > 0 ? c : this.random() < 0.45 ? 1 : 0));
    if (s.night >= s.nights) {
      this.events.push({ type: 'phase', phase: 'dawn', night: s.night });
      this.end(true, `You kept the fire alive for ${s.nights} nights.`);
      return;
    }
    s.night++;
    s.phase = 'day';
    s.phaseTime = 0;
    // The city fills up again, with more zombies every day.
    this.populateCity(s.night);
    this.events.push({ type: 'phase', phase: 'dawn', night: s.night });
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  private stepPlayer(p: PlayerState): void {
    const inp = this.inputs.get(p.slot) ?? { x: 0, y: 0, b: 0, prevB: 0, latched: 0 };
    const pressed = p.connected ? inp.latched | (inp.b & ~inp.prevB) : 0;
    const held = p.connected ? inp.b : 0;
    p.swingT += DT;
    p.hurtT += DT;
    p.areaT += DT;
    p.attackCd = Math.max(0, p.attackCd - DT);
    const area = this.world.districtAt(p.x, p.z);
    if (area !== p.area) {
      p.area = area;
      p.areaT = 0;
      this.events.push({ type: 'area', slot: p.slot, area });
    }

    if (p.downed) {
      p.speed = 0;
      p.actionTime = 0;
      p.actionKind = '';
      this.targets.set(p.slot, null);
      return;
    }

    // Hunger and health.
    p.food = Math.max(0, p.food - PLAYER.foodDrain * DT);
    if (p.food <= 0) this.damagePlayer(p, PLAYER.starveDamage * DT, false);
    else if (p.food > 40) {
      const nearFire = p.x * p.x + p.z * p.z < this.fireRadius() ** 2;
      p.hp = Math.min(PLAYER.maxHp, p.hp + (nearFire ? PLAYER.regenNearFire : PLAYER.regen) * DT);
    }
    if (p.downed) return;

    // Movement. Joystick up = screen up = world -z.
    const mx = p.connected ? inp.x : 0;
    const mz = p.connected ? -inp.y : 0;
    const mag = Math.min(1, Math.hypot(mx, mz));
    const busy = p.actionTime > 0 && mag < 0.35;
    if (mag > 0.08 && !busy) {
      const speed = PLAYER.speed * mag;
      this.move(p, mx * PLAYER.speed * DT, mz * PLAYER.speed * DT, PLAYER.radius);
      p.speed = speed / PLAYER.speed;
      const tx = mx / mag;
      const tz = mz / mag;
      const k = 0.35;
      const fx = p.fx + (tx - p.fx) * k;
      const fz = p.fz + (tz - p.fz) * k;
      const fl = Math.hypot(fx, fz) || 1;
      p.fx = fx / fl;
      p.fz = fz / fl;
    } else {
      p.speed = 0;
    }

    const target = this.findTarget(p);
    this.targets.set(p.slot, target);

    // A: hold actions.
    const holdKind =
      target && !('blocked' in target && target.blocked)
        ? target.kind === 'tree'
          ? 'chop'
          : target.kind === 'rock'
            ? 'mine'
            : target.kind === 'revive'
              ? 'revive'
              : target.kind === 'container'
                ? 'search'
                : ''
        : '';
    if (holdKind && held & BTN_A && target) {
      if (p.actionKind !== holdKind) p.actionTime = 0;
      p.actionKind = holdKind;
      p.actionTime += DT;
      this.faceTowards(p, target);
      this.stepHoldAction(p, target);
    } else {
      p.actionTime = 0;
      p.actionKind = '';
    }

    // A: tap actions.
    if (pressed & BTN_A && !holdKind) {
      if (target?.kind === 'item' && !target.blocked) this.pickupItem(p, target.id);
      else if (target?.kind === 'gear') this.pickupGear(p, target.id);
      else if (target?.kind === 'bush' && !target.blocked) this.pickBerry(p, target.i);
      else if (target && 'blocked' in target && target.blocked) this.events.push({ type: 'fail', slot: p.slot, x: p.x, z: p.z });
      else this.attack(p, target?.kind === 'attack' ? target : null);
    }

    if (pressed & BTN_B) this.use(p);
    if (pressed & BTN_C) this.build(p);
  }

  private faceTowards(p: PlayerState, t: Target): void {
    const pos = this.targetPos(t);
    if (!pos) return;
    const dx = pos.x - p.x;
    const dz = pos.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.01) {
      p.fx = dx / d;
      p.fz = dz / d;
    }
  }

  private targetPos(t: Target): { x: number; z: number } | null {
    const s = this.state;
    switch (t.kind) {
      case 'revive':
        return this.player(t.slot) ?? null;
      case 'attack':
        return (t.zombie ? s.zombies.find((z) => z.id === t.id) : s.creatures.find((c) => c.id === t.id)) ?? null;
      case 'item':
        return s.items.find((i) => i.id === t.id) ?? null;
      case 'gear':
        return s.gear.find((g) => g.id === t.id) ?? null;
      case 'container':
        return this.world.city.containers[t.i];
      case 'bush':
        return this.world.bushes[t.i];
      case 'tree':
        return this.world.trees[t.i];
      case 'rock':
        return this.world.rocks[t.i];
    }
  }

  private canCarry(p: PlayerState, type: ItemType): boolean {
    return !p.item || (p.item.type === type && p.item.count < CARRY_MAX[type]);
  }

  private findTarget(p: PlayerState): Target | null {
    const s = this.state;
    const w = this.world;
    const probeX = p.x + p.fx * 0.5;
    const probeZ = p.z + p.fz * 0.5;
    const distTo = (x: number, z: number) => Math.hypot(x - probeX, z - probeZ);

    let best: Target | null = null;
    for (const q of s.players) {
      if (q === p || !q.downed) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < PLAYER.reviveRange && (!best || d < best.dist)) best = { kind: 'revive', slot: q.slot, dist: d };
    }
    if (best) return best;

    for (const c of s.creatures) {
      if (c.flee) continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z) - CREATURE.radius;
      if (d < PLAYER.attackRange && (!best || d < best.dist)) best = { kind: 'attack', id: c.id, dist: d, zombie: false };
    }
    for (const z of s.zombies) {
      const d = Math.hypot(z.x - p.x, z.z - p.z) - ZOMBIE.radius;
      if (d < PLAYER.attackRange && (!best || d < best.dist)) best = { kind: 'attack', id: z.id, dist: d, zombie: true };
    }
    if (best) return best;

    for (const it of s.items) {
      const d = Math.hypot(it.x - p.x, it.z - p.z);
      if (d < PLAYER.reach && (!best || d < best.dist)) {
        best = { kind: 'item', id: it.id, dist: d, blocked: !this.canCarry(p, it.type) };
      }
    }
    for (const g of s.gear) {
      const d = Math.hypot(g.x - p.x, g.z - p.z);
      if (d < PLAYER.reach && (!best || d < best.dist)) best = { kind: 'gear', id: g.id, dist: d };
    }
    if (best) return best;

    let bestGather: Target | null = null;
    w.bushes.forEach((b, i) => {
      if (s.bushes[i] <= 0) return;
      const d = distTo(b.x, b.z) - 0.6 * b.scale;
      if (d < PLAYER.reach * 0.75 && (!bestGather || d < bestGather.dist)) {
        bestGather = { kind: 'bush', i, dist: d, blocked: !this.canCarry(p, 'berry') };
      }
    });
    for (const packed of w.collidersNear(probeX, probeZ)) {
      const type = packed >> 16;
      const i = packed & 0xffff;
      if (type === 0) {
        if (s.trees[i] <= 0) continue;
        const t = w.trees[i];
        const d = distTo(t.x, t.z) - t.r;
        if (d < PLAYER.reach * 0.75 && (!bestGather || d < (bestGather as Target).dist)) {
          bestGather = { kind: 'tree', i, dist: d, blocked: !this.canCarry(p, 'wood') };
        }
      } else if (type === 1) {
        if (s.rocks[i] <= 0) continue;
        const r = w.rocks[i];
        const d = distTo(r.x, r.z) - r.r;
        if (d < PLAYER.reach * 0.75 && (!bestGather || d < (bestGather as Target).dist)) {
          bestGather = { kind: 'rock', i, dist: d, blocked: !this.canCarry(p, 'stone') };
        }
      } else if (type === 3 || type === 4) {
        // Cars and crates; containers list cars first, then crates.
        const ci = type === 3 ? i : w.city.cars.length + i;
        if (!s.containers[ci]) continue;
        const c = w.city.containers[ci];
        const d = distTo(c.x, c.z) - (type === 3 ? 1.2 : 0.7);
        if (d < PLAYER.reach * 0.75 && (!bestGather || d < (bestGather as Target).dist)) {
          bestGather = { kind: 'container', i: ci, dist: d };
        }
      }
    }
    return bestGather;
  }

  private give(p: PlayerState, type: ItemType, n: number): void {
    if (!p.item) p.item = { type, count: 0 };
    p.item.count = Math.min(CARRY_MAX[type], p.item.count + n);
  }

  private stepHoldAction(p: PlayerState, t: Target): void {
    const s = this.state;
    if (t.kind === 'tree') {
      if (p.actionTime < RESOURCES.chopTime) return;
      p.actionTime = 0;
      const tree = this.world.trees[t.i];
      s.trees[t.i]--;
      this.give(p, 'wood', 1);
      this.events.push({ type: 'chop', slot: p.slot, x: tree.x, z: tree.z });
      this.events.push({ type: 'pickup', slot: p.slot, x: p.x, z: p.z });
      if (s.trees[t.i] <= 0) this.events.push({ type: 'treeFell', slot: p.slot, x: tree.x, z: tree.z });
    } else if (t.kind === 'rock') {
      if (p.actionTime < RESOURCES.mineTime) return;
      p.actionTime = 0;
      const rock = this.world.rocks[t.i];
      s.rocks[t.i]--;
      this.give(p, 'stone', 1);
      this.events.push({ type: 'mine', slot: p.slot, x: rock.x, z: rock.z });
      this.events.push({ type: 'pickup', slot: p.slot, x: p.x, z: p.z });
      if (s.rocks[t.i] <= 0) this.events.push({ type: 'rockBreak', slot: p.slot, x: rock.x, z: rock.z });
    } else if (t.kind === 'container') {
      if (p.actionTime < SEARCH_TIME) return;
      p.actionTime = 0;
      if (!s.containers[t.i]) return;
      s.containers[t.i] = 0;
      s.stats.searched++;
      this.loot(p, t.i);
    } else if (t.kind === 'revive') {
      const q = this.player(t.slot);
      if (!q || !q.downed) return;
      q.reviveProgress = p.actionTime / PLAYER.reviveTime;
      if (p.actionTime < PLAYER.reviveTime) return;
      p.actionTime = 0;
      q.downed = false;
      q.hp = PLAYER.reviveHp;
      q.reviveProgress = 0;
      s.stats.revives++;
      this.events.push({ type: 'revived', slot: q.slot, x: q.x, z: q.z });
    }
  }

  private pickupItem(p: PlayerState, id: number): void {
    const s = this.state;
    const it = s.items.find((i) => i.id === id);
    if (!it) return;
    const room = p.item ? CARRY_MAX[it.type] - p.item.count : CARRY_MAX[it.type];
    const n = Math.min(room, it.count);
    if (n <= 0) return;
    this.give(p, it.type, n);
    it.count -= n;
    if (it.count <= 0) s.items = s.items.filter((i) => i !== it);
    this.events.push({ type: 'pickup', slot: p.slot, x: it.x, z: it.z });
  }

  private pickBerry(p: PlayerState, i: number): void {
    const s = this.state;
    if (s.bushes[i] <= 0) return;
    s.bushes[i]--;
    this.give(p, 'berry', 1);
    const b = this.world.bushes[i];
    this.events.push({ type: 'pickup', slot: p.slot, x: b.x, z: b.z });
  }

  private attack(p: PlayerState, target: Extract<Target, { kind: 'attack' }> | null): void {
    if (p.attackCd > 0) return;
    const s = this.state;
    const gun = p.weapon === 'pistol' && p.ammo > 0;
    const weapon = WEAPONS[p.weapon && (p.weapon !== 'pistol' || gun) ? p.weapon : 'fists'];
    p.attackCd = weapon.cooldown;
    p.swingT = 0;

    if (gun) {
      // Auto-aim at the nearest enemy roughly in front, else the nearest one in range.
      let best: { e: ZombieState | CreatureState; zombie: boolean; score: number } | null = null;
      const consider = (e: ZombieState | CreatureState, zombie: boolean) => {
        const dx = e.x - p.x;
        const dz = e.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d > weapon.range) return;
        const facing = d > 0.01 ? (dx * p.fx + dz * p.fz) / d : 1;
        const score = d - facing * 4;
        if (!best || score < best.score) best = { e, zombie, score };
      };
      for (const z of s.zombies) consider(z, true);
      for (const c of s.creatures) if (!c.flee) consider(c, false);
      p.ammo--;
      const hit = best as { e: ZombieState | CreatureState; zombie: boolean } | null;
      if (hit) {
        this.faceTowards(p, { kind: 'attack', id: hit.e.id, dist: 0, zombie: hit.zombie });
        this.damageEnemy(p, hit.e, hit.zombie, weapon.damage, 0.5);
      }
      const tx = hit ? hit.e.x : p.x + p.fx * weapon.range;
      const tz = hit ? hit.e.z : p.z + p.fz * weapon.range;
      this.events.push({ type: 'shot', slot: p.slot, x: p.x, z: p.z, tx, tz });
      // Gunshots carry: nearby zombies come running.
      for (const z of s.zombies) if (Math.hypot(z.x - p.x, z.z - p.z) < 16) z.alertT = 6;
      this.removeDead();
      return;
    }

    if (target) this.faceTowards(p, target);
    this.events.push({ type: 'swing', slot: p.slot, x: p.x, z: p.z });
    const inFront = (e: { x: number; z: number }, r: number) => {
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d - r > weapon.range) return false;
      return d < 0.3 || (dx * p.fx + dz * p.fz) / d >= 0.2;
    };
    for (const c of s.creatures) if (!c.flee && inFront(c, CREATURE.radius)) this.damageEnemy(p, c, false, weapon.damage, 1.1);
    for (const z of s.zombies) if (inFront(z, ZOMBIE.radius)) this.damageEnemy(p, z, true, weapon.damage, 0.9);
    this.removeDead();
  }

  private damageEnemy(p: PlayerState, e: ZombieState | CreatureState, zombie: boolean, damage: number, knock: number): void {
    const s = this.state;
    e.hp -= damage;
    e.hurtT = 0;
    const dx = e.x - p.x;
    const dz = e.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    this.move(e, (dx / d) * knock, (dz / d) * knock, zombie ? ZOMBIE.radius : CREATURE.radius);
    this.events.push({ type: zombie ? 'zombieHit' : 'creatureHit', x: e.x, z: e.z });
    if (e.hp <= 0) {
      p.kills++;
      s.stats.kills++;
      if (zombie) s.stats.zombies++;
    }
  }

  private removeDead(): void {
    this.removeDeadCreatures();
    const s = this.state;
    for (const z of s.zombies) if (z.hp <= 0) this.events.push({ type: 'zombieDie', x: z.x, z: z.z });
    s.zombies = s.zombies.filter((z) => z.hp > 0);
  }

  private pickupGear(p: PlayerState, id: number): void {
    const s = this.state;
    const g = s.gear.find((q) => q.id === id);
    if (!g) return;
    s.gear = s.gear.filter((q) => q !== g);
    if (g.kind === 'ammo') {
      p.ammo = Math.min(99, p.ammo + AMMO_PICKUP);
    } else if (g.kind === 'jacket' || g.kind === 'armor') {
      if (p.armor) this.dropGear(p.x, p.z, p.armor);
      p.armor = g.kind;
    } else {
      if (p.weapon) this.dropGear(p.x, p.z, p.weapon);
      p.weapon = g.kind;
      if (g.kind === 'pistol') p.ammo = Math.min(99, p.ammo + PISTOL_AMMO);
    }
    this.events.push({ type: 'gear', slot: p.slot, x: g.x, z: g.z });
  }

  private dropGear(x: number, z: number, kind: GearKind): void {
    const s = this.state;
    if (s.gear.length >= MAX_GEAR_ON_GROUND) s.gear.shift();
    const a = this.random() * Math.PI * 2;
    s.gear.push({ id: s.nextId++, kind, x: x + Math.cos(a) * 0.6, z: z + Math.sin(a) * 0.6 });
  }

  /** Roll the loot table of a searched car or crate and drop it next to the player. */
  private loot(p: PlayerState, ci: number): void {
    const c = this.world.city.containers[ci];
    const table = LOOT[c.tier];
    const weighted = c.kind === 'car' ? table.map(([k, w]) => [k, k === 'fuel' ? w * 2 : w] as [Loot, number]) : table;
    const total = weighted.reduce((sum, [, w]) => sum + w, 0);
    let r = this.random() * total;
    let pick: Loot = weighted[0][0];
    for (const [k, w] of weighted) {
      r -= w;
      if (r <= 0) {
        pick = k;
        break;
      }
    }
    const x = (p.x + c.x) / 2;
    const z = (p.z + c.z) / 2;
    if (pick === 'fuel' || pick === 'can' || pick === 'wood') {
      this.dropItem(x, z, pick, pick === 'wood' ? 3 : pick === 'can' ? 1 + Math.floor(this.random() * 2) : 1);
    } else {
      this.dropGear(x, z, pick);
    }
    this.events.push({ type: 'search', slot: p.slot, x: c.x, z: c.z });
  }

  private use(p: PlayerState): void {
    const s = this.state;
    if (!p.item) return;
    if (p.item.type === 'berry') {
      p.item.count--;
      p.food = Math.min(PLAYER.maxFood, p.food + PLAYER.berryFood);
      p.hp = Math.min(PLAYER.maxHp, p.hp + PLAYER.berryHp);
      if (p.item.count <= 0) p.item = null;
      this.events.push({ type: 'eat', slot: p.slot, x: p.x, z: p.z });
      return;
    }
    if (p.item.type === 'can') {
      p.item.count--;
      p.food = Math.min(PLAYER.maxFood, p.food + CAN_FOOD);
      p.hp = Math.min(PLAYER.maxHp, p.hp + PLAYER.berryHp);
      if (p.item.count <= 0) p.item = null;
      this.events.push({ type: 'eat', slot: p.slot, x: p.x, z: p.z });
      return;
    }
    if (p.item.type === 'fuel' && this.nearFire(p)) {
      s.fuel = Math.min(FIRE.maxFuel, s.fuel + p.item.count * GAS_FUEL);
      p.item = null;
      this.events.push({ type: 'fuel', slot: p.slot, x: 0, z: 0 });
      return;
    }
    if (p.item.type === 'wood' && this.nearFire(p)) {
      const n = p.item.count;
      s.fuel = Math.min(FIRE.maxFuel, s.fuel + n * FIRE.woodFuel);
      s.stats.woodBurned += n;
      p.woodBurned += n;
      p.item = null;
      this.events.push({ type: 'fuel', slot: p.slot, x: 0, z: 0 });
      return;
    }
    this.dropItem(p.x + p.fx * 0.7, p.z + p.fz * 0.7, p.item.type, p.item.count);
    p.item = null;
    this.events.push({ type: 'drop', slot: p.slot, x: p.x, z: p.z });
  }

  private nearFire(p: PlayerState): boolean {
    return Math.hypot(p.x, p.z) < FIRE.feedRange;
  }

  private build(p: PlayerState): void {
    const s = this.state;
    const w = this.world;
    const item = p.item;
    if (item?.type === 'wood' && item.count >= TORCH.cost) {
      if (s.torches.length >= TORCH.max) {
        this.events.push({ type: 'fail', slot: p.slot, x: p.x, z: p.z });
        return;
      }
      let x = p.x;
      let z = p.z;
      for (const dist of [1.1, 0.7, 0]) {
        const tx = p.x + p.fx * dist;
        const tz = p.z + p.fz * dist;
        if (w.isWalkable(tx, tz) && Math.hypot(tx, tz) > FIRE.ringRadius + 0.6) {
          x = tx;
          z = tz;
          break;
        }
      }
      item.count -= TORCH.cost;
      if (item.count <= 0) p.item = null;
      // A torch lasts until the end of the coming night.
      s.torches.push({ id: s.nextId++, x, z, expires: s.night, age: 0 });
      s.stats.torches++;
      this.events.push({ type: 'build', slot: p.slot, x, z });
      return;
    }
    if (item?.type === 'stone' && item.count >= WALL.cost) {
      const x = p.x + p.fx * 1.4;
      const z = p.z + p.fz * 1.4;
      if (s.walls.length >= WALL.max || !w.isWalkable(x, z) || Math.hypot(x, z) < 2.4) {
        this.events.push({ type: 'fail', slot: p.slot, x: p.x, z: p.z });
        return;
      }
      item.count -= WALL.cost;
      if (item.count <= 0) p.item = null;
      s.walls.push({ id: s.nextId++, x, z, ax: -p.fz, az: p.fx, hp: WALL.hp });
      s.stats.walls++;
      this.events.push({ type: 'build', slot: p.slot, x, z });
      return;
    }
    this.events.push({ type: 'fail', slot: p.slot, x: p.x, z: p.z });
  }

  private damagePlayer(p: PlayerState, amount: number, hit: boolean): void {
    if (p.downed) return;
    if (hit && p.armor) amount *= 1 - ARMOR[p.armor];
    p.hp -= amount;
    if (hit) {
      p.hurtT = 0;
      this.events.push({ type: 'hurt', slot: p.slot, x: p.x, z: p.z });
    }
    if (p.hp <= 0) {
      p.hp = 0;
      p.downed = true;
      p.reviveProgress = 0;
      p.actionTime = 0;
      if (p.item) {
        this.dropItem(p.x + 0.5, p.z, p.item.type, p.item.count);
        p.item = null;
      }
      this.events.push({ type: 'downed', slot: p.slot, x: p.x, z: p.z });
    }
  }

  private separatePlayers(): void {
    const ps = this.state.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i];
        const b = ps[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const min = PLAYER.radius * 2;
        if (d < min && d > 0.0001) {
          const push = (min - d) / 2;
          if (!a.downed) this.move(a, (-dx / d) * push, (-dz / d) * push, PLAYER.radius);
          if (!b.downed) this.move(b, (dx / d) * push, (dz / d) * push, PLAYER.radius);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Creatures
  // -------------------------------------------------------------------------

  private stepSpawning(): void {
    const s = this.state;
    if (s.phase !== 'night' || s.spawnLeft <= 0) return;
    s.spawnTimer -= DT;
    if (s.spawnTimer > 0) return;
    const alive = s.creatures.filter((c) => !c.flee).length;
    if (alive >= CREATURE.maxAlive) return;
    const window = PHASE_TIME.night * CREATURE.spawnWindow;
    s.spawnTimer = window / Math.max(1, s.spawnLeft + 1);
    for (let tries = 0; tries < 12; tries++) {
      const pt = this.world.randomShorePoint(() => this.random());
      if (!pt) continue;
      if (this.inLight(pt.x, pt.z, 3)) continue;
      if (s.players.some((p) => Math.hypot(p.x - pt.x, p.z - pt.z) < 14)) continue;
      s.creatures.push({
        id: s.nextId++,
        x: pt.x,
        z: pt.z,
        px: pt.x,
        pz: pt.z,
        fx: -pt.x,
        fz: -pt.z,
        hp: CREATURE.hp,
        cd: 0,
        flee: false,
        fleeT: 0,
        hurtT: 9,
        age: 0,
        orbit: this.random() < 0.5 ? 1 : -1,
        attackT: 9,
      });
      s.spawnLeft--;
      this.events.push({ type: 'spawn', x: pt.x, z: pt.z });
      return;
    }
  }

  private stepCreatures(): void {
    const s = this.state;
    const speed = CREATURE.speed + CREATURE.speedPerNight * (s.night - 1);
    const fireR = this.fireRadius();

    for (const c of s.creatures) {
      c.age += DT;
      c.hurtT += DT;
      c.attackT += DT;
      c.cd = Math.max(0, c.cd - DT);

      if (c.flee) {
        c.fleeT += DT;
        const d = Math.hypot(c.x, c.z) || 1;
        this.move(c, (c.x / d) * 4.5 * DT, (c.z / d) * 4.5 * DT, CREATURE.radius);
        c.fx = c.x / d;
        c.fz = c.z / d;
        continue;
      }

      // Light burns: run out of it.
      if (this.inLight(c.x, c.z, 0)) {
        c.hp -= CREATURE.burnDps * DT;
        c.hurtT = Math.min(c.hurtT, 0.2);
        const pos = { x: c.x, z: c.z };
        this.pushOutOfLight(pos, CREATURE.radius + 0.1);
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const d = Math.hypot(dx, dz) || 1;
        this.move(c, (dx / d) * speed * 1.6 * DT, (dz / d) * speed * 1.6 * DT, CREATURE.radius);
        if (c.hp <= 0) this.events.push({ type: 'creatureBurn', x: c.x, z: c.z });
        continue;
      }

      // Hunt the nearest player outside the light.
      let prey: PlayerState | null = null;
      let preyD: number = CREATURE.aggroRange;
      for (const p of s.players) {
        if (p.downed || !p.connected) continue;
        if (this.inLight(p.x, p.z, -0.2)) continue;
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < preyD) {
          preyD = d;
          prey = p;
        }
      }

      let tx: number;
      let tz: number;
      if (prey) {
        tx = prey.x - c.x;
        tz = prey.z - c.z;
        if (preyD - PLAYER.radius - CREATURE.radius < CREATURE.attackRange && c.cd <= 0) {
          c.cd = CREATURE.attackCooldown;
          c.attackT = 0;
          this.damagePlayer(prey, CREATURE.damage, true);
          this.events.push({ type: 'creatureAttack', x: c.x, z: c.z });
        }
      } else {
        // Creep towards the fire, then circle at the edge of its light.
        const d = Math.hypot(c.x, c.z) || 1;
        const edge = fireR + CREATURE.radius + 1.2;
        const inward = d - edge;
        const rx = -c.x / d;
        const rz = -c.z / d;
        const tangentX = -rz * c.orbit;
        const tangentZ = rx * c.orbit;
        const k = clamp(inward / 4, -1, 1);
        tx = rx * k + tangentX * 0.35;
        tz = rz * k + tangentZ * 0.35;
      }

      const tl = Math.hypot(tx, tz);
      if (tl > 0.01) {
        const sp = prey ? speed : speed * 0.75;
        const moveLen = Math.min(sp * DT, prey ? Math.max(0, preyD - PLAYER.radius - CREATURE.radius * 0.8) : 99);
        const next = { x: c.x + (tx / tl) * moveLen, z: c.z + (tz / tl) * moveLen };
        // Creatures will not step into light.
        this.pushOutOfLight(next, CREATURE.radius);
        const blocked = this.move(c, next.x - c.x, next.z - c.z, CREATURE.radius);
        if (blocked >= 0 && c.cd <= 0) this.hitWall(c, blocked);
        const fl = Math.hypot(tx, tz);
        c.fx += (tx / fl - c.fx) * 0.2;
        c.fz += (tz / fl - c.fz) * 0.2;
      }
    }

    // Keep them apart.
    const cs = s.creatures;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i];
        const b = cs[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const min = CREATURE.radius * 2.1;
        if (d < min && d > 0.0001) {
          const push = (min - d) / 2;
          this.move(a, (-dx / d) * push, (-dz / d) * push, CREATURE.radius);
          this.move(b, (dx / d) * push, (dz / d) * push, CREATURE.radius);
        }
      }
    }

    this.removeDeadCreatures();
    s.creatures = s.creatures.filter((c) => !(c.flee && c.fleeT > 3.2));
  }

  // -------------------------------------------------------------------------
  // Zombies
  // -------------------------------------------------------------------------

  /** Fill every city block up to its zombie quota (more downtown, more every night). */
  populateCity(night: number): void {
    const s = this.state;
    const w = this.world;
    const players = Math.max(1, s.players.length);
    const scale = (1 + 0.3 * (night - 1)) * (0.7 + 0.15 * players);
    const perBlock = new Array<number>(w.city.blocks.length).fill(0);
    let city = 0;
    for (const z of s.zombies) {
      if (z.horde) continue;
      perBlock[z.block]++;
      city++;
    }
    // Downtown first, so the cap never starves the dangerous districts.
    const order = w.city.blocks.map((_, i) => i).sort((a, b) => w.city.blocks[b].tier - w.city.blocks[a].tier);
    for (const bi of order) {
      const b = w.city.blocks[bi];
      const target = Math.round(ZOMBIE.perBlock[b.tier] * scale * (b.park ? 0.5 : 1));
      for (let tries = 0; perBlock[bi] < target && tries < target * 4 && city < ZOMBIE.cityMax && s.zombies.length < ZOMBIE.max; tries++) {
        const pt = w.randomPointInBlock(() => this.random(), bi);
        if (!pt || s.players.some((p) => Math.hypot(p.x - pt.x, p.z - pt.z) < 12)) continue;
        this.spawnZombie(pt.x, pt.z, bi, false);
        perBlock[bi]++;
        city++;
      }
    }
  }

  private spawnZombie(x: number, z: number, block: number, horde: boolean): void {
    const s = this.state;
    s.zombies.push({
      id: s.nextId++,
      x,
      z,
      px: x,
      pz: z,
      fx: 0,
      fz: 1,
      hp: Math.round((ZOMBIE.hp + ZOMBIE.hpPerNight * (s.night - 1)) * 2) / 2,
      cd: 0,
      block,
      horde,
      wx: x,
      wz: z,
      wanderT: this.random() * 3,
      alertT: 0,
      detourT: 0,
      detour: 1,
      hurtT: 9,
      attackT: 9,
      age: 0,
      shade: this.random(),
    });
  }

  /** At night a horde streams out of the city edge that faces the camp. */
  private stepHorde(): void {
    const s = this.state;
    if (s.phase !== 'night' || s.hordeLeft <= 0) return;
    s.hordeTimer -= DT;
    if (s.hordeTimer > 0) return;
    s.hordeTimer = (PHASE_TIME.night * 0.45) / Math.max(1, s.hordeLeft + 1);
    if (s.zombies.length >= ZOMBIE.max) return;
    const c = this.world.city;
    const mid = (CITY.roadCells * c.cell) / 2;
    const t = 0.1 + this.random() * 0.8;
    const along = (a0: number, a1: number) => a0 + t * (a1 - a0);
    const [x, z] =
      c.dirX === 1
        ? [c.x0 + mid, along(c.z0, c.z1)]
        : c.dirX === -1
          ? [c.x1 - mid, along(c.z0, c.z1)]
          : c.dirZ === 1
            ? [along(c.x0, c.x1), c.z0 + mid]
            : [along(c.x0, c.x1), c.z1 - mid];
    if (!this.world.isWalkable(x, z) || s.players.some((p) => Math.hypot(p.x - x, p.z - z) < 9)) return;
    this.spawnZombie(x, z, Math.floor(this.random() * c.blocks.length), true);
    s.hordeLeft--;
    if (!s.hordeWarned) {
      s.hordeWarned = true;
      this.events.push({ type: 'horde' });
    }
  }

  private stepZombies(): void {
    const s = this.state;
    const w = this.world;
    const night = s.phase === 'night';
    const bonus = ZOMBIE.speedPerNight * (s.night - 1);

    for (const z of s.zombies) {
      z.age += DT;
      z.hurtT += DT;
      z.attackT += DT;
      z.cd = Math.max(0, z.cd - DT);
      z.alertT = Math.max(0, z.alertT - DT);
      z.detourT = Math.max(0, z.detourT - DT);
      z.wanderT -= DT;
      if (z.hurtT < 0.2) continue; // staggered by a hit

      const aggro = (night ? ZOMBIE.aggroNight : ZOMBIE.aggroDay) * (z.alertT > 0 ? 2 : 1);
      let prey: PlayerState | null = null;
      let preyD = aggro;
      for (const p of s.players) {
        if (p.downed || !p.connected) continue;
        const d = Math.hypot(p.x - z.x, p.z - z.z);
        if (d < preyD) {
          preyD = d;
          prey = p;
        }
      }

      let tx = 0;
      let tz = 0;
      let speed = 0;
      if (prey) {
        tx = prey.x - z.x;
        tz = prey.z - z.z;
        speed = (night ? ZOMBIE.speedNight : ZOMBIE.speedChase) + bonus;
        if (preyD - PLAYER.radius - ZOMBIE.radius < ZOMBIE.attackRange) {
          speed = 0;
          if (z.cd <= 0) {
            z.cd = ZOMBIE.attackCooldown;
            z.attackT = 0;
            this.damagePlayer(prey, ZOMBIE.damage, true);
            this.events.push({ type: 'zombieAttack', x: z.x, z: z.z });
          }
        }
      } else if (z.horde) {
        tx = -z.x;
        tz = -z.z;
        const d = Math.hypot(z.x, z.z);
        if (d <= FIRE.ringRadius + ZOMBIE.radius + 0.5) {
          // Stamping on the campfire.
          s.fuel -= ZOMBIE.trampleFuel * DT;
          if (z.cd <= 0) {
            z.cd = 1;
            z.attackT = 0;
            this.events.push({ type: 'trample', x: z.x, z: z.z });
          }
        } else {
          speed = ZOMBIE.speedNight * 0.8 + bonus;
        }
      } else {
        const b = w.city.blocks[z.block];
        const hx = (b.x0 + b.x1) / 2;
        const hz = (b.z0 + b.z1) / 2;
        if (Math.hypot(z.x - hx, z.z - hz) > 14) {
          z.wx = hx;
          z.wz = hz;
        } else if (z.wanderT <= 0 || Math.hypot(z.wx - z.x, z.wz - z.z) < 0.5) {
          z.wanderT = 3 + this.random() * 4;
          const pt = w.randomPointInBlock(() => this.random(), z.block);
          if (pt) {
            z.wx = pt.x;
            z.wz = pt.z;
          }
        }
        tx = z.wx - z.x;
        tz = z.wz - z.z;
        speed = Math.hypot(tx, tz) > 0.4 ? ZOMBIE.speedWander : 0;
      }

      const len = Math.hypot(tx, tz);
      if (len < 0.01) continue;
      let dx = tx / len;
      let dz = tz / len;
      if (speed > 0) {
        if (z.detourT > 0) {
          // Slide around whatever is in the way.
          const a = 1.2 * z.detour;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          [dx, dz] = [dx * ca - dz * sa, dx * sa + dz * ca];
        }
        const step = speed * DT;
        const ox = z.x;
        const oz = z.z;
        const wall = this.move(z, dx * step, dz * step, ZOMBIE.radius);
        if (wall >= 0 && z.cd <= 0) this.hitWall(z, wall, ZOMBIE.attackCooldown);
        if (wall < 0 && z.detourT <= 0 && Math.hypot(z.x - ox, z.z - oz) < step * 0.3) {
          z.detourT = 0.9;
          z.detour = this.random() < 0.5 ? 1 : -1;
        }
      }
      z.fx += (dx - z.fx) * 0.15;
      z.fz += (dz - z.fz) * 0.15;
      const fl = Math.hypot(z.fx, z.fz) || 1;
      z.fx /= fl;
      z.fz /= fl;
    }

    // Keep them from stacking up.
    const zs = s.zombies;
    const min = ZOMBIE.radius * 2;
    for (let i = 0; i < zs.length; i++) {
      for (let j = i + 1; j < zs.length; j++) {
        const a = zs[i];
        const b = zs[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
        const d = Math.hypot(dx, dz);
        if (d < min && d > 0.0001) {
          const push = (min - d) / 2;
          this.move(a, (-dx / d) * push, (-dz / d) * push, ZOMBIE.radius);
          this.move(b, (dx / d) * push, (dz / d) * push, ZOMBIE.radius);
        }
      }
    }
    this.removeDead();
  }

  private hitWall(c: { cd: number; attackT: number }, wi: number, cooldown: number = CREATURE.attackCooldown): void {
    const s = this.state;
    const wall = s.walls[wi];
    if (!wall) return;
    c.cd = cooldown;
    c.attackT = 0;
    wall.hp--;
    this.events.push({ type: 'wallHit', x: wall.x, z: wall.z });
    if (wall.hp <= 0) {
      s.walls.splice(wi, 1);
      this.events.push({ type: 'wallBreak', x: wall.x, z: wall.z });
    }
  }

  private removeDeadCreatures(): void {
    const s = this.state;
    for (const c of s.creatures) {
      if (c.hp <= 0) this.events.push({ type: 'creatureDie', x: c.x, z: c.z });
    }
    s.creatures = s.creatures.filter((c) => c.hp > 0);
  }

  // -------------------------------------------------------------------------
  // Phone HUD
  // -------------------------------------------------------------------------

  hudFor(slot: number): HudPayload | null {
    const p = this.player(slot);
    if (!p) return null;
    const s = this.state;
    const t = this.targets.get(slot) ?? null;
    let hint = '';
    let a = '';
    let b = '';
    let c = '';
    let progress = 0;

    if (p.downed) {
      hint = p.reviveProgress > 0 ? 'Being revived…' : 'Downed – wait for help';
      progress = p.reviveProgress;
    } else {
      if (t) {
        const blocked = 'blocked' in t && t.blocked;
        if (blocked) {
          hint = 'Hands full – B to drop';
          a = '';
        } else {
          switch (t.kind) {
            case 'revive': {
              const q = this.player(t.slot);
              hint = `Hold A: revive ${q?.name ?? ''}`;
              a = 'Revive';
              progress = p.actionKind === 'revive' ? p.actionTime / PLAYER.reviveTime : 0;
              break;
            }
            case 'attack':
              hint = p.weapon === 'pistol' && p.ammo > 0 ? `Tap A: shoot (${p.ammo})` : 'Tap A: attack!';
              a = p.weapon === 'pistol' && p.ammo > 0 ? 'Shoot' : 'Attack';
              break;
            case 'gear': {
              const g = s.gear.find((q) => q.id === t.id);
              hint = g ? `Tap A: take ${GEAR_NAME[g.kind]}` : '';
              a = 'Take';
              break;
            }
            case 'container': {
              const cont = this.world.city.containers[t.i];
              hint = cont.kind === 'car' ? 'Hold A: search car' : 'Hold A: search crate';
              a = 'Search';
              progress = p.actionKind === 'search' ? p.actionTime / SEARCH_TIME : 0;
              break;
            }
            case 'item': {
              const it = s.items.find((i) => i.id === t.id);
              hint = `Tap A: pick up ${it ? ITEM_NAME[it.type] : ''}`;
              a = 'Pick up';
              break;
            }
            case 'bush':
              hint = 'Tap A: pick berries';
              a = 'Pick';
              break;
            case 'tree':
              hint = 'Hold A: chop';
              a = 'Chop';
              progress = p.actionKind === 'chop' ? p.actionTime / RESOURCES.chopTime : 0;
              break;
            case 'rock':
              hint = 'Hold A: mine';
              a = 'Mine';
              progress = p.actionKind === 'mine' ? p.actionTime / RESOURCES.mineTime : 0;
              break;
          }
        }
      } else {
        a = p.weapon === 'pistol' && p.ammo > 0 ? 'Shoot' : 'Swing';
      }

      if (p.item?.type === 'berry' || p.item?.type === 'can') b = 'Eat';
      else if ((p.item?.type === 'wood' || p.item?.type === 'fuel') && this.nearFire(p)) b = 'Fuel';
      else if (p.item) b = 'Drop';

      if (p.item?.type === 'wood' && p.item.count >= TORCH.cost) c = 'Torch';
      else if (p.item?.type === 'stone' && p.item.count >= WALL.cost) c = 'Wall';

      if (!hint && p.areaT < 3) {
        hint =
          p.area === 2
            ? '☠ Downtown – swarming with zombies'
            : p.area === 1
              ? '⚠ Midtown – watch out for zombies'
              : p.area === 0
                ? 'Outskirts – search cars and crates'
                : '';
      }
      if (!hint) {
        if (b === 'Fuel') hint = p.item?.type === 'fuel' ? 'B: pour gas on the fire' : 'B: throw wood in the fire';
        else if (s.phase === 'dusk') hint = 'Get back to the fire!';
        else if (p.food < 25 && b === 'Eat') hint = 'B: eat a berry';
        else if (p.food < 25) hint = "You're hungry – find berries";
        else if (c === 'Torch') hint = 'C: place a torch';
        else if (c === 'Wall') hint = 'C: build a wall';
        else if (s.phase === 'night' && !this.inLight(p.x, p.z)) hint = 'Stay near the light!';
        else if (s.fuel < 30) hint = 'The fire needs wood!';
      }
    }

    return {
      hp: Math.round(clamp(p.hp, 0, 100)),
      food: Math.round(clamp(p.food, 0, 100)),
      item: p.item ? { type: p.item.type, count: p.item.count } : null,
      hint,
      gear: this.gearText(p),
      a,
      b,
      c,
      downed: p.downed,
      progress: Math.round(clamp(progress, 0, 1) * 100) / 100,
    };
  }

  gearText(p: PlayerState): string {
    const parts: string[] = [];
    if (p.weapon) parts.push(p.weapon === 'pistol' ? `${GEAR_ICON.pistol}${p.ammo}` : GEAR_ICON[p.weapon]);
    else if (p.ammo > 0) parts.push(`•${p.ammo}`);
    if (p.armor) parts.push(GEAR_ICON[p.armor]);
    return parts.join(' ');
  }

  districtName(area: number): string {
    return area >= 0 ? DISTRICT_NAMES[area] : '';
  }

  /** Current target of a player, for highlight rendering. */
  targetOf(slot: number): Target | null {
    return this.targets.get(slot) ?? null;
  }
}
