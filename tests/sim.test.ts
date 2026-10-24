import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BTN_A, BTN_B, BTN_C } from '../shared/constants';
import { CREATURE, FIRE, PHASE_TIME, TICK_HZ } from '../client/host/game/config';
import { Sim } from '../client/host/game/sim';
import { World } from '../client/host/game/world';

const world = new World(12345);

function newSim(players = 1, nights = 5): Sim {
  const sim = new Sim(world, Sim.newState(world, nights));
  for (let i = 1; i <= players; i++) sim.addPlayer(i, `P${i}`, '#fff');
  return sim;
}

function run(sim: Sim, seconds: number, each?: () => void): void {
  for (let i = 0; i < seconds * TICK_HZ; i++) {
    each?.();
    sim.step();
    sim.events.length = 0;
    if (sim.state.over) return;
  }
}

/** Steer a player towards a point using joystick input (y up = world -z). */
function steer(sim: Sim, slot: number, x: number, z: number, b = 0): number {
  const p = sim.player(slot)!;
  const dx = x - p.x;
  const dz = z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.3) sim.setInput(slot, 0, 0, b);
  else sim.setInput(slot, dx / d, -dz / d, b);
  return d;
}

test('island is deterministic and the camp is walkable', () => {
  const a = new World(777);
  const b = new World(777);
  assert.deepEqual(a.trees.slice(0, 5), b.trees.slice(0, 5));
  assert.ok(world.isWalkable(0, 3));
  assert.ok(!world.isWalkable(0, 69), 'edge of the map is water');
  assert.ok(world.trees.length > 100, `trees: ${world.trees.length}`);
  assert.ok(world.rocks.length > 20, `rocks: ${world.rocks.length}`);
  assert.ok(world.bushes.length > 20, `bushes: ${world.bushes.length}`);
});

test('joystick input is clamped on the laptop', () => {
  const sim = newSim();
  const p = sim.player(1)!;
  const x0 = p.x;
  sim.setInput(1, 50, 0, 0);
  sim.step();
  assert.ok(p.x - x0 <= 5.4 / TICK_HZ + 1e-6, 'cannot move faster than max speed');
});

test('chop a tree, carry wood back and feed the fire', () => {
  const sim = newSim();
  // Nearest tree to the fire.
  const ti = world.trees.map((t, i) => [Math.hypot(t.x, t.z), i]).sort((a, b) => a[0] - b[0])[0][1];
  const tree = world.trees[ti];
  let ticks = 0;
  // Walk next to the tree, then hold A.
  while (ticks++ < 30 * 20) {
    const d = steer(sim, 1, tree.x - 1.0, tree.z, BTN_A);
    if (d < 0.3) break;
    sim.step();
  }
  run(sim, 4, () => sim.setInput(1, 0, 0, BTN_A));
  const p = sim.player(1)!;
  assert.equal(p.item?.type, 'wood');
  assert.ok(p.item!.count >= 3, `wood: ${p.item?.count}`);
  // Back to the fire, press B.
  for (let i = 0; i < 30 * 20 && steer(sim, 1, 1.8, 0) > 0.3; i++) sim.step();
  const before = sim.state.fuel;
  sim.setInput(1, 0, 0, 0);
  sim.step();
  sim.setInput(1, 0, 0, BTN_B);
  sim.step();
  assert.equal(p.item, null);
  assert.ok(sim.state.fuel > before + FIRE.woodFuel * 2, 'fuel went up');
});

test('short taps between ticks are not lost', () => {
  const sim = newSim();
  const p = sim.player(1)!;
  p.item = { type: 'berry', count: 2 };
  p.food = 50;
  sim.setInput(1, 0, 0, BTN_B);
  sim.setInput(1, 0, 0, 0); // released before the tick
  sim.step();
  assert.equal(p.item?.count, 1);
  assert.ok(p.food > 50);
});

test('torches and walls are built with C', () => {
  const sim = newSim();
  const p = sim.player(1)!;
  p.item = { type: 'wood', count: 4 };
  sim.setInput(1, 0, 0, BTN_C);
  sim.step();
  assert.equal(sim.state.torches.length, 1);
  assert.equal(p.item?.count, 2);
  p.item = { type: 'stone', count: 3 };
  p.x = 5;
  p.z = 5;
  sim.setInput(1, 0, 0, 0);
  sim.step();
  sim.setInput(1, 0, 0, BTN_C);
  sim.step();
  assert.equal(sim.state.walls.length, 1);
  assert.equal(p.item, null);
});

test('creatures come at night, avoid the light and attack players outside it', () => {
  const sim = newSim(2);
  const inside = sim.player(1)!;
  const outside = sim.player(2)!;
  sim.state.phase = 'dusk';
  sim.state.phaseTime = PHASE_TIME.dusk - 0.05;
  run(sim, 30);
  assert.equal(sim.state.phase, 'night');
  assert.ok(sim.state.creatures.length > 0, 'creatures spawned');
  // Keep player 1 by the fire, put player 2 out in the dark next to a creature.
  const c = sim.state.creatures[0];
  outside.x = c.x + 1.2;
  outside.z = c.z;
  let minFireDist = Infinity;
  run(sim, 6, () => {
    for (const cr of sim.state.creatures) minFireDist = Math.min(minFireDist, Math.hypot(cr.x, cr.z));
  });
  assert.ok(outside.hp < 100 || outside.downed, 'player outside the light got hurt');
  assert.equal(inside.hp, 100, 'player in the light is safe');
  assert.ok(minFireDist >= sim.fireRadius() - 0.5, `creature stayed out of the light (${minFireDist.toFixed(1)})`);
  assert.ok(sim.state.creatures.length <= CREATURE.maxAlive);
});

test('downed players can be revived by holding A', () => {
  const sim = newSim(2);
  const a = sim.player(1)!;
  const b = sim.player(2)!;
  b.hp = 0;
  b.downed = true;
  a.x = b.x + 1;
  a.z = b.z;
  run(sim, 3.2, () => sim.setInput(1, 0, 0, BTN_A));
  assert.equal(b.downed, false);
  assert.ok(b.hp > 0);
});

test('everyone downed ends the run', () => {
  const sim = newSim(1);
  sim.player(1)!.food = 0;
  sim.player(1)!.hp = 1;
  run(sim, 2);
  assert.equal(sim.state.over?.won, false);
});

test('the fire going out ends the run', () => {
  const sim = newSim(1);
  sim.state.fuel = 0.1;
  run(sim, 2);
  assert.equal(sim.state.over?.won, false);
  assert.match(sim.state.over!.reason, /fire went out/);
});

test('surviving the last night wins and the state survives JSON', () => {
  const sim = newSim(1, 3);
  sim.state.night = 3;
  sim.state.phase = 'night';
  sim.state.phaseTime = PHASE_TIME.night - 1;
  sim.state.fuel = 100;
  const restored = new Sim(world, JSON.parse(JSON.stringify(sim.state)));
  run(restored, 2);
  assert.equal(restored.state.over?.won, true);
});

test('a full five-night run with idle players ends without errors', () => {
  const sim = newSim(4);
  const t0 = performance.now();
  let ticks = 0;
  while (!sim.state.over && ticks < 30 * 60 * 25) {
    sim.step();
    sim.events.length = 0;
    ticks++;
    if (ticks % 300 === 0) sim.state.fuel = Math.min(100, sim.state.fuel + 20);
  }
  const ms = (performance.now() - t0) / ticks;
  assert.ok(sim.state.over, 'run ended');
  assert.ok(ms < 1, `tick takes ${ms.toFixed(3)} ms`);
});
