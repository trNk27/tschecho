// The player character: a small low-poly survivor in the player's colour.

import * as THREE from 'three';
import type { ItemType } from '../../../shared/constants';
import type { ArmorKind, WeaponKind } from './config';
import { berryPileGeometry, foodCanGeometry, gasCanGeometry, logGeometry, stonePileGeometry, weaponGeometry } from './models';

const shared = {
  skin: new THREE.MeshLambertMaterial({ color: '#f0c08a', flatShading: true }),
  dark: new THREE.MeshLambertMaterial({ color: '#33303f', flatShading: true }),
  eye: new THREE.MeshBasicMaterial({ color: '#1a1414' }),
  tool: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  item: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  geo: {
    body: new THREE.CapsuleGeometry(0.3, 0.42, 2, 7),
    head: new THREE.IcosahedronGeometry(0.27, 1),
    hat: new THREE.SphereGeometry(0.29, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
    pom: new THREE.IcosahedronGeometry(0.08, 0),
    eye: new THREE.BoxGeometry(0.06, 0.08, 0.03),
    leg: new THREE.BoxGeometry(0.15, 0.36, 0.16).translate(0, -0.18, 0),
    arm: new THREE.BoxGeometry(0.12, 0.38, 0.12).translate(0, -0.17, 0),
    weapons: {
      axe: weaponGeometry('axe'),
      bat: weaponGeometry('bat'),
      machete: weaponGeometry('machete'),
      pistol: weaponGeometry('pistol'),
    },
    vest: new THREE.CapsuleGeometry(0.33, 0.3, 2, 7),
    log: logGeometry().scale(0.6, 0.6, 0.6),
    stones: stonePileGeometry().scale(0.85, 0.85, 0.85),
    berries: berryPileGeometry(),
    gas: gasCanGeometry(),
    cans: foodCanGeometry().scale(1.3, 1.3, 1.3),
  },
  vestMat: {
    jacket: new THREE.MeshLambertMaterial({ color: '#6b4226', flatShading: true }),
    armor: new THREE.MeshLambertMaterial({ color: '#39424e', flatShading: true }),
  },
};

export class PlayerModel {
  readonly root = new THREE.Group();
  private body: THREE.Group;
  private bodyMat: THREE.MeshLambertMaterial;
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private armL: THREE.Object3D;
  private armR: THREE.Object3D;
  private tools: Record<'axe' | WeaponKind, THREE.Mesh>;
  private vest: THREE.Mesh;
  private items: Record<ItemType, THREE.Mesh[]>;
  private walk = 0;
  private downAmount = 0;

  constructor(color: string) {
    this.bodyMat = new THREE.MeshLambertMaterial({ color, flatShading: true });
    const hatMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(color).multiplyScalar(0.7),
      flatShading: true,
    });

    this.body = new THREE.Group();
    this.root.add(this.body);

    const torso = new THREE.Mesh(shared.geo.body, this.bodyMat);
    torso.position.y = 0.72;
    const head = new THREE.Mesh(shared.geo.head, shared.skin);
    head.position.y = 1.3;
    const hat = new THREE.Mesh(shared.geo.hat, hatMat);
    hat.position.y = 1.36;
    hat.scale.set(1, 0.85, 1);
    const pom = new THREE.Mesh(shared.geo.pom, shared.skin);
    pom.material = new THREE.MeshLambertMaterial({ color: '#fdf6ec', flatShading: true });
    pom.position.y = 1.63;
    const eyeL = new THREE.Mesh(shared.geo.eye, shared.eye);
    eyeL.position.set(0.1, 1.3, 0.25);
    const eyeR = eyeL.clone();
    eyeR.position.x = -0.1;
    this.body.add(torso, head, hat, pom, eyeL, eyeR);

    this.legL = new THREE.Mesh(shared.geo.leg, shared.dark);
    this.legL.position.set(0.13, 0.4, 0);
    this.legR = new THREE.Mesh(shared.geo.leg, shared.dark);
    this.legR.position.set(-0.13, 0.4, 0);
    this.body.add(this.legL, this.legR);

    const armMat = this.bodyMat;
    this.armL = new THREE.Mesh(shared.geo.arm, armMat);
    this.armL.position.set(0.37, 0.98, 0);
    this.armR = new THREE.Mesh(shared.geo.arm, armMat);
    this.armR.position.set(-0.37, 0.98, 0);
    const tool = (geo: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(geo, shared.tool);
      m.position.set(0, -0.3, 0.04);
      m.rotation.x = Math.PI / 2;
      m.visible = false;
      this.armR.add(m);
      return m;
    };
    const w = shared.geo.weapons;
    this.tools = { axe: tool(w.axe), bat: tool(w.bat), machete: tool(w.machete), pistol: tool(w.pistol) };
    this.vest = new THREE.Mesh(shared.geo.vest, shared.vestMat.jacket);
    this.vest.position.y = 0.76;
    this.vest.visible = false;
    this.body.add(this.armL, this.armR, this.vest);

    const mk = (geo: THREE.BufferGeometry, n: number, dy: number) =>
      Array.from({ length: n }, (_, i) => {
        const m = new THREE.Mesh(geo, shared.item);
        m.position.set(0, 0.82 + i * dy, 0.42);
        m.rotation.y = i * 0.7;
        m.visible = false;
        this.body.add(m);
        return m;
      });
    this.items = {
      wood: mk(shared.geo.log, 3, 0.2),
      stone: mk(shared.geo.stones, 2, 0.28),
      berry: mk(shared.geo.berries, 2, 0.2),
      fuel: mk(shared.geo.gas, 2, 0.5),
      can: mk(shared.geo.cans, 2, 0.25),
    };
  }

  update(opts: {
    x: number;
    y: number;
    z: number;
    fx: number;
    fz: number;
    speed: number;
    downed: boolean;
    item: { type: ItemType; count: number } | null;
    swingT: number;
    action: string;
    actionTime: number;
    hurtT: number;
    time: number;
    dt: number;
    weapon: WeaponKind | '';
    armor: ArmorKind | '';
  }): void {
    const { root, body } = this;
    root.position.set(opts.x, opts.y, opts.z);
    const targetYaw = Math.atan2(opts.fx, opts.fz);
    let dy = targetYaw - root.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    root.rotation.y += dy * Math.min(1, opts.dt * 14);

    // Downed: lie on the ground.
    const downTarget = opts.downed ? 1 : 0;
    this.downAmount += (downTarget - this.downAmount) * Math.min(1, opts.dt * 6);
    body.rotation.x = -this.downAmount * (Math.PI / 2) * 0.95;
    body.position.y = this.downAmount * 0.3;

    // Walk cycle.
    this.walk += opts.dt * (4 + 8 * opts.speed) * (opts.speed > 0.05 ? 1 : 0);
    const swingAmp = opts.speed > 0.05 ? 0.7 * Math.min(1, opts.speed + 0.3) : 0;
    const s = Math.sin(this.walk) * swingAmp;
    this.legL.rotation.x = s;
    this.legR.rotation.x = -s;
    body.position.y += Math.abs(Math.cos(this.walk)) * 0.06 * (swingAmp > 0 ? 1 : 0);

    // Arms: carrying, swinging or chopping.
    const carrying = !!opts.item;
    let armR = carrying ? -1.2 : -s * 0.8;
    let armL = carrying ? -1.2 : s * 0.8;
    const acting = opts.action === 'chop' || opts.action === 'mine';
    const swinging = opts.swingT < 0.35;
    const shown: 'axe' | WeaponKind | '' = acting ? 'axe' : opts.weapon || (swinging ? 'axe' : '');
    for (const [k, m] of Object.entries(this.tools)) m.visible = k === shown && !(carrying && !acting && !swinging);
    this.vest.visible = !!opts.armor;
    if (opts.armor) this.vest.material = shared.vestMat[opts.armor];
    if (acting) {
      const period = opts.action === 'chop' ? 0.85 : 1.15;
      const ph = (opts.actionTime % period) / period;
      armR = ph < 0.7 ? -2.6 + ph * 1.2 : -1.76 + (ph - 0.7) * 8;
      armL = -0.5;
    } else if (opts.action === 'revive') {
      armR = armL = -1.3 + Math.sin(opts.time * 10) * 0.1;
    } else if (swinging && opts.weapon === 'pistol') {
      armR = -1.5 + Math.max(0, 0.15 - opts.swingT) * 3; // aim and recoil
    } else if (swinging) {
      const t = opts.swingT / 0.35;
      armR = t < 0.3 ? -2.8 * (t / 0.3) : -2.8 + (t - 0.3) * 4.6;
    } else if (opts.weapon && !carrying) {
      armR = -0.5 - s * 0.3;
    }
    this.armR.rotation.x = armR;
    this.armL.rotation.x = armL;

    // Held items.
    for (const type of ['wood', 'stone', 'berry', 'fuel', 'can'] as ItemType[]) {
      const meshes = this.items[type];
      const n = opts.item?.type === type ? Math.min(meshes.length, Math.ceil(opts.item.count / (type === 'wood' ? 3 : 3))) : 0;
      meshes.forEach((m, i) => (m.visible = i < Math.max(n, opts.item?.type === type ? 1 : 0)));
    }

    // Hurt flash.
    const hurt = Math.max(0, 1 - opts.hurtT / 0.3);
    this.bodyMat.emissive.setRGB(hurt * 0.9, 0, 0);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.bodyMat.dispose();
  }
}
