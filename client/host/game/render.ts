// Three.js renderer: one scene, one WebGLRenderer, one camera per player drawn
// into its own scissor rectangle of the same canvas.

import * as THREE from 'three';
import { atmosphere } from './atmosphere';
import { PlayerModel } from './characters';
import { FIRE, MAX_ITEMS_ON_GROUND, TORCH, WALL, WATER_LEVEL } from './config';
import type { Rect } from './layout';
import {
  BERRY_OFFSETS,
  berryGeometry,
  berryPileGeometry,
  bushGeometry,
  campfireLogs,
  campfireStones,
  creatureBodyGeometry,
  creatureEyesGeometry,
  flameGeometry,
  flowerGeometry,
  grassGeometry,
  logGeometry,
  pineGeometry,
  radialTexture,
  rockGeometry,
  roundTreeGeometry,
  stonePileGeometry,
  stumpGeometry,
  torchGeometry,
  wallGeometry,
} from './models';
import { fbm, mulberry32, smoothstep } from './rng';
import type { SimState } from './sim';
import type { World } from './world';

export type Quality = 'high' | 'low';

export interface ViewSpec {
  slot: number;
  rect: Rect;
}

export interface TargetMark {
  x: number;
  z: number;
  r: number;
  color: string;
}

export interface FrameInput {
  state: SimState;
  alpha: number;
  dt: number;
  time: number;
  views: ViewSpec[];
  /** Lobby / game-over: one slowly orbiting camera instead of player cameras. */
  orbit: boolean;
  phase: 'lobby' | SimState['phase'];
  targets: (TargetMark | null)[];
}

const MAX_LIGHTS = 8;
const MAX_CREATURES = 34;
const MAX_SHADOWS = 4 + MAX_CREATURES;
const MAX_PARTICLES = 320;
const RING_SLOTS = 1 + TORCH.max;

// Uniforms shared by the patched materials.
const U = {
  uTime: { value: 0 },
  uFocus: { value: new THREE.Vector3() },
  uCamPos: { value: new THREE.Vector3() },
  uNight: { value: 0 },
  uLights: { value: Array.from({ length: RING_SLOTS }, () => new THREE.Vector4()) },
};

interface PatchOpts {
  occlude?: boolean;
  rings?: boolean;
  wave?: boolean;
  sway?: boolean;
}

/** Inject small shader tweaks into built-in materials (keeps three's lighting and fog). */
function patch<T extends THREE.Material>(mat: T, opts: PatchOpts): T {
  const key = JSON.stringify(opts);
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    let vs = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       varying vec3 vEWorld;
       uniform float uTime;`,
    );
    if (opts.wave) {
      vs = vs.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed.y += sin(position.x * 0.32 + uTime * 1.1) * 0.12 + cos(position.z * 0.27 + uTime * 0.8) * 0.12;`,
      );
    }
    if (opts.sway) {
      vs = vs.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         #ifdef USE_INSTANCING
           vec3 ip = instanceMatrix[3].xyz;
           float sw = position.y * position.y;
           transformed.x += sin(uTime * 1.7 + ip.x * 0.35 + ip.z * 0.2) * 0.3 * sw;
           transformed.z += cos(uTime * 1.3 + ip.x * 0.2 - ip.z * 0.3) * 0.2 * sw;
         #endif`,
      );
    }
    vs = vs.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       vec4 eW = vec4(transformed, 1.0);
       #ifdef USE_INSTANCING
         eW = instanceMatrix * eW;
       #endif
       vEWorld = (modelMatrix * eW).xyz;`,
    );
    shader.vertexShader = vs;

    let fs = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       varying vec3 vEWorld;
       uniform vec3 uFocus;
       uniform vec3 uCamPos;
       uniform float uNight;
       uniform float uTime;
       uniform vec4 uLights[${RING_SLOTS}];`,
    );
    if (opts.occlude) {
      // Dither away whatever stands between the camera and its player.
      fs = fs.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         {
           vec3 seg = uFocus - uCamPos;
           float t = clamp(dot(vEWorld - uCamPos, seg) / dot(seg, seg), 0.0, 1.0);
           float d = distance(vEWorld, uCamPos + seg * t);
           float fade = smoothstep(2.6, 1.3, d) * smoothstep(1.0, 0.85, t);
           float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
           if (fade > ign * 0.9 + 0.05) discard;
         }`,
      );
    }
    if (opts.rings) {
      // Glowing line on the ground where the fire's and torches' safe light ends.
      fs = fs.replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
         {
           float ring = 0.0;
           for (int i = 0; i < ${RING_SLOTS}; i++) {
             vec4 L = uLights[i];
             if (L.z <= 0.0) continue;
             float d = distance(vEWorld.xz, L.xy);
             float edge = 1.0 - smoothstep(0.0, 0.32, abs(d - L.z));
             ring = max(ring, edge * L.w);
           }
           float pulse = 0.75 + 0.25 * sin(uTime * 3.0);
           gl_FragColor.rgb += vec3(1.0, 0.42, 0.1) * ring * uNight * 0.5 * pulse;
         }`,
      );
    }
    shader.fragmentShader = fs;
  };
  return mat;
}

class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX_PARTICLES * 3);
  private col = new Float32Array(MAX_PARTICLES * 3);
  private vel = new Float32Array(MAX_PARTICLES * 3);
  private life = new Float32Array(MAX_PARTICLES);
  private next = 0;
  private geo = new THREE.BufferGeometry();

  constructor() {
    this.pos.fill(-1000);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new THREE.PointsMaterial({ size: 0.2, vertexColors: true, sizeAttenuation: true });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  burst(x: number, y: number, z: number, color: string, n: number, speed = 3, up = 3): void {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.pos[i * 3] = x + (Math.random() - 0.5) * 0.3;
      this.pos[i * 3 + 1] = y + Math.random() * 0.3;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
      this.vel[i * 3] = Math.cos(a) * s;
      this.vel[i * 3 + 1] = up * (0.5 + Math.random());
      this.vel[i * 3 + 2] = Math.sin(a) * s;
      const v = 0.8 + Math.random() * 0.4;
      this.col[i * 3] = c.r * v;
      this.col[i * 3 + 1] = c.g * v;
      this.col[i * 3 + 2] = c.b * v;
      this.life[i] = 0.6 + Math.random() * 0.5;
    }
  }

  update(dt: number, groundAt: (x: number, z: number) => number): void {
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -1000;
        continue;
      }
      this.vel[i * 3 + 1] -= 12 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const g = groundAt(this.pos[i * 3], this.pos[i * 3 + 2]) + 0.05;
      if (this.pos[i * 3 + 1] < g) {
        this.pos[i * 3 + 1] = g;
        this.vel[i * 3] *= 0.5;
        this.vel[i * 3 + 2] *= 0.5;
        this.vel[i * 3 + 1] = 0;
      }
    }
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpE = new THREE.Euler();
const tmpC = new THREE.Color();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

function setInst(
  mesh: THREE.InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  rotY: number,
  sx: number,
  sy = sx,
  sz = sx,
  rotX = 0,
  rotZ = 0,
): void {
  tmpE.set(rotX, rotY, rotZ, 'YXZ');
  tmpQ.setFromEuler(tmpE);
  tmpP.set(x, y, z);
  tmpS.set(sx, sy, sz);
  tmpM.compose(tmpP, tmpQ, tmpS);
  mesh.setMatrixAt(i, tmpM);
}

interface View {
  cam: THREE.PerspectiveCamera;
  target: THREE.Vector3;
  init: boolean;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private world: World | null = null;
  private worldGroup = new THREE.Group();
  private hemi = new THREE.HemisphereLight('#ffffff', '#445533', 1);
  private sun = new THREE.DirectionalLight('#ffffff', 2);
  private lights: THREE.PointLight[] = [];
  private fog = new THREE.Fog('#9fd4ee', 30, 60);
  private views = new Map<number, View>();
  private orbitCam = new THREE.PerspectiveCamera(48, 1, 0.5, 120);
  private particles = new Particles();
  private pixelScale = 1;
  private maxPixelRatio: number;

  // World meshes (rebuilt per island).
  private trees: THREE.InstancedMesh[] = [];
  private treeIndex: [number, number][] = []; // tree i -> [mesh, instance]
  private stumps!: THREE.InstancedMesh;
  private rocks!: THREE.InstancedMesh;
  private bushes!: THREE.InstancedMesh;
  private berries!: THREE.InstancedMesh;
  private fireflies!: THREE.Points;
  private lastTrees: number[] = [];
  private lastRocks: number[] = [];
  private lastBushes: number[] = [];
  private treeAnim = new Map<number, { start: number; fell: boolean; dir: number }>();
  private rockAnim = new Map<number, number>();

  // Dynamic meshes.
  private players = new Map<number, PlayerModel>();
  private creatureBody: THREE.InstancedMesh;
  private creatureEyes: THREE.InstancedMesh;
  private torchSticks: THREE.InstancedMesh;
  private torchFlames: THREE.InstancedMesh;
  private walls: THREE.InstancedMesh;
  private items: Record<'wood' | 'stone' | 'berry', THREE.InstancedMesh>;
  private shadows: THREE.InstancedMesh;
  private rings: THREE.Mesh[] = [];
  private downRings: THREE.Mesh[] = [];
  private torchGlow: THREE.Points;
  private fire = new THREE.Group();
  private flames: THREE.Mesh[] = [];
  private fireGlow: THREE.Sprite;
  private embers: THREE.Points;
  private emberData: Float32Array;
  private fireY = 1.1;

  constructor(
    container: HTMLElement,
    readonly quality: Quality,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: quality === 'high',
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.maxPixelRatio = quality === 'high' ? 1 : 0.75;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1) * this.maxPixelRatio);
    this.renderer.setScissorTest(true);
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    const s = this.scene;
    s.fog = this.fog;
    s.background = new THREE.Color('#9fd4ee');
    s.add(this.hemi, this.sun, this.sun.target, this.worldGroup);

    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(i === 0 ? '#ff8a3d' : '#ff9a4a', 0, 10, 1.15);
      this.lights.push(l);
      s.add(l);
    }

    // Creatures.
    const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.creatureBody = new THREE.InstancedMesh(creatureBodyGeometry(), bodyMat, MAX_CREATURES);
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#ffd44a', fog: false, toneMapped: false });
    this.creatureEyes = new THREE.InstancedMesh(creatureEyesGeometry(), eyeMat, MAX_CREATURES);
    for (let i = 0; i < MAX_CREATURES; i++) {
      this.creatureBody.setColorAt(i, tmpC.set('#ffffff'));
    }
    this.creatureBody.count = this.creatureEyes.count = 0;
    s.add(this.creatureBody, this.creatureEyes);

    // Torches.
    const propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.torchSticks = new THREE.InstancedMesh(torchGeometry(), propMat, TORCH.max);
    const flameMat = new THREE.MeshBasicMaterial({
      color: '#ffb347',
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.torchFlames = new THREE.InstancedMesh(flameGeometry(), flameMat, TORCH.max);
    this.torchSticks.count = this.torchFlames.count = 0;
    s.add(this.torchSticks, this.torchFlames);

    const glowTex = radialTexture('rgba(255,170,90,0.85)', 'rgba(255,120,40,0)');
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TORCH.max * 3).fill(-1000), 3));
    this.torchGlow = new THREE.Points(
      glowGeo,
      new THREE.PointsMaterial({
        map: glowTex,
        size: 3.2,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.5,
      }),
    );
    this.torchGlow.frustumCulled = false;
    s.add(this.torchGlow);

    // Walls and dropped items.
    this.walls = new THREE.InstancedMesh(wallGeometry(WALL.length, WALL.thickness), propMat, WALL.max);
    for (let i = 0; i < WALL.max; i++) this.walls.setColorAt(i, tmpC.set('#ffffff'));
    this.walls.count = 0;
    this.items = {
      wood: new THREE.InstancedMesh(logGeometry(), propMat, MAX_ITEMS_ON_GROUND),
      stone: new THREE.InstancedMesh(stonePileGeometry(), propMat, MAX_ITEMS_ON_GROUND),
      berry: new THREE.InstancedMesh(berryPileGeometry(), propMat, MAX_ITEMS_ON_GROUND),
    };
    s.add(this.walls, this.items.wood, this.items.stone, this.items.berry);
    for (const m of Object.values(this.items)) m.count = 0;

    // Blob shadows.
    const shadowTex = radialTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)');
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat, MAX_SHADOWS);
    this.shadows.count = 0;
    this.shadows.renderOrder = 2;
    s.add(this.shadows);

    // Target rings.
    const ringGeo = new THREE.RingGeometry(0.62, 0.78, 28).rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
      );
      m.visible = false;
      m.renderOrder = 3;
      this.rings.push(m);
      const d = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: '#ff3030', transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
      );
      d.visible = false;
      d.renderOrder = 3;
      this.downRings.push(d);
      s.add(m, d);
    }

    // Campfire.
    const stones = new THREE.Mesh(campfireStones(), propMat);
    const logs = new THREE.Mesh(campfireLogs(), propMat);
    this.fire.add(stones, logs);
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(2.3, 24).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({
        map: radialTexture('rgba(45,28,18,0.85)', 'rgba(45,28,18,0)'),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    scorch.position.y = 0.02;
    scorch.renderOrder = 1;
    this.fire.add(scorch);
    // A tall core flame plus smaller tongues around it.
    const flameDefs: [string, number, number, number][] = [
      ['#ff5a1f', 0, 0, 1],
      ['#ff8c2a', 0, 0, 0.75],
      ['#ffd166', 0, 0, 0.5],
      ['#ff6a24', 0.28, 0.1, 0.55],
      ['#ff7a2a', -0.22, 0.22, 0.5],
      ['#ff6a24', -0.05, -0.3, 0.5],
    ];
    const flameGeo = flameGeometry();
    for (const [c, x, z, scale] of flameDefs) {
      const m = new THREE.Mesh(
        flameGeo,
        new THREE.MeshBasicMaterial({
          color: c,
          transparent: true,
          opacity: 0.6,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      m.position.set(x, 0.15, z);
      m.userData.base = scale;
      this.flames.push(m);
      this.fire.add(m);
    }
    this.fireGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialTexture('rgba(255,160,70,0.9)', 'rgba(255,90,20,0)'),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        toneMapped: false,
      }),
    );
    this.fireGlow.position.y = 1.0;
    this.fireGlow.scale.setScalar(7);
    this.fire.add(this.fireGlow);

    const emberCount = 48;
    this.emberData = new Float32Array(emberCount * 4);
    const ePos = new Float32Array(emberCount * 3);
    for (let i = 0; i < emberCount; i++) this.emberData[i * 4 + 3] = Math.random() * 2;
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.embers = new THREE.Points(
      eGeo,
      new THREE.PointsMaterial({
        color: '#ffb35c',
        size: 0.12,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.embers.frustumCulled = false;
    this.fire.add(this.embers);
    s.add(this.fire);
    s.add(this.particles.points);

    this.resize();
  }

  // -------------------------------------------------------------------------
  // World
  // -------------------------------------------------------------------------

  setWorld(world: World): void {
    if (this.world === world) return;
    this.world = world;
    for (const child of [...this.worldGroup.children]) {
      child.removeFromParent();
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
    this.trees = [];
    this.treeIndex = [];
    this.treeAnim.clear();
    this.rockAnim.clear();
    this.fireY = world.heightAt(0, 0);
    this.fire.position.set(0, this.fireY, 0);
    this.buildTerrain(world);
    this.buildWater();
    this.buildProps(world);
    this.lastTrees = world.trees.map(() => -1);
    this.lastRocks = world.rocks.map(() => -1);
    this.lastBushes = world.bushes.map(() => -1);
  }

  private buildTerrain(world: World): void {
    const CH = 4;
    const n = world.res + 1;
    const per = world.res / CH;
    const mat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { rings: true });
    const rnd = mulberry32(world.seed + 5);
    const sand = new THREE.Color('#e3cd95');
    const wetSand = new THREE.Color('#b99d63');
    const grassA = new THREE.Color('#5f9f41');
    const grassB = new THREE.Color('#8cc25a');
    const forest = new THREE.Color('#3f7a36');
    const rock = new THREE.Color('#8c877e');
    const c = new THREE.Color();

    for (let cz = 0; cz < CH; cz++) {
      for (let cx = 0; cx < CH; cx++) {
        const tris = per * per * 2;
        const pos = new Float32Array(tris * 9);
        const col = new Float32Array(tris * 9);
        let o = 0;
        const put = (i: number, j: number) => {
          pos[o] = -world.half + i * world.cell;
          pos[o + 1] = world.heights[j * n + i];
          pos[o + 2] = -world.half + j * world.cell;
          o += 3;
        };
        for (let j = cz * per; j < (cz + 1) * per; j++) {
          for (let i = cx * per; i < (cx + 1) * per; i++) {
            for (let t = 0; t < 2; t++) {
              const start = o;
              if (t === 0) {
                put(i, j);
                put(i, j + 1);
                put(i + 1, j);
              } else {
                put(i + 1, j);
                put(i, j + 1);
                put(i + 1, j + 1);
              }
              // Face colour from the triangle's centre.
              const x = (pos[start] + pos[start + 3] + pos[start + 6]) / 3;
              const y = (pos[start + 1] + pos[start + 4] + pos[start + 7]) / 3;
              const z = (pos[start + 2] + pos[start + 5] + pos[start + 8]) / 3;
              const hmin = Math.min(pos[start + 1], pos[start + 4], pos[start + 7]);
              const hmax = Math.max(pos[start + 1], pos[start + 4], pos[start + 7]);
              const steep = (hmax - hmin) / world.cell;
              if (y < 0.15) {
                c.copy(wetSand).multiplyScalar(0.75 + 0.25 * smoothstep(-3, 0.1, y));
              } else if (y < 0.6) {
                c.copy(sand).lerp(wetSand, smoothstep(0.45, 0.15, y) * 0.5);
              } else {
                const v = fbm(x * 0.08, z * 0.08, world.seed + 40, 2);
                c.copy(grassA).lerp(grassB, v);
                c.lerp(forest, world.forestAt(x, z) * 0.55);
                if (y < 0.72) c.lerp(sand, smoothstep(0.72, 0.6, y) * 0.6);
                if (y > 3.6) c.lerp(new THREE.Color('#9bbf68'), smoothstep(3.6, 5, y) * 0.5);
                if (steep > 0.85) c.lerp(rock, smoothstep(0.85, 1.4, steep));
              }
              const jit = 0.94 + rnd() * 0.1;
              for (let k = 0; k < 3; k++) {
                col[start + k * 3] = c.r * jit;
                col[start + k * 3 + 1] = c.g * jit;
                col[start + k * 3 + 2] = c.b * jit;
              }
            }
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        const mesh = new THREE.Mesh(geo, mat);
        this.worldGroup.add(mesh);
      }
    }
  }

  private buildWater(): void {
    const geo = new THREE.PlaneGeometry(360, 360, 90, 90).rotateX(-Math.PI / 2);
    const mat = patch(
      new THREE.MeshLambertMaterial({ color: '#3b8fc4', transparent: true, opacity: 0.8, flatShading: true }),
      { wave: true },
    );
    const water = new THREE.Mesh(geo, mat);
    water.position.y = WATER_LEVEL;
    water.renderOrder = 1;
    this.worldGroup.add(water);
  }

  private buildProps(world: World): void {
    const treeMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), { occlude: true });
    const propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const rnd = mulberry32(world.seed + 99);

    const kinds = [pineGeometry(), roundTreeGeometry()];
    const counts = [0, 0];
    world.trees.forEach((t) => counts[t.kind]++);
    this.trees = kinds.map((g, k) => {
      const m = new THREE.InstancedMesh(g, treeMat, Math.max(1, counts[k]));
      m.count = counts[k];
      this.worldGroup.add(m);
      return m;
    });
    const used = [0, 0];
    const autumn = ['#e8a33c', '#d9662b', '#f2c94c'];
    world.trees.forEach((t, i) => {
      const idx = used[t.kind]++;
      this.treeIndex[i] = [t.kind, idx];
      const mesh = this.trees[t.kind];
      if (t.kind === 1 && rnd() < 0.18) tmpC.set(autumn[Math.floor(rnd() * autumn.length)]).lerp(new THREE.Color('#ffffff'), 0.25);
      else tmpC.setRGB(0.85 + rnd() * 0.25, 0.88 + rnd() * 0.22, 0.85 + rnd() * 0.2);
      mesh.setColorAt(idx, tmpC);
    });

    this.stumps = new THREE.InstancedMesh(stumpGeometry(), propMat, Math.max(1, world.trees.length));
    this.rocks = new THREE.InstancedMesh(rockGeometry(), propMat, Math.max(1, world.rocks.length));
    world.rocks.forEach((_, i) => {
      const v = 0.85 + rnd() * 0.3;
      this.rocks.setColorAt(i, tmpC.setRGB(v, v * (0.97 + rnd() * 0.05), v));
    });
    this.bushes = new THREE.InstancedMesh(bushGeometry(), propMat, Math.max(1, world.bushes.length));
    world.bushes.forEach((b, i) => {
      setInst(this.bushes, i, b.x, world.heightAt(b.x, b.z) - 0.05, b.z, b.rot, b.scale);
      this.bushes.setColorAt(i, tmpC.setRGB(0.9 + b.shade * 0.2, 0.95 + b.shade * 0.1, 0.9));
    });
    const berryMat = new THREE.MeshLambertMaterial({ color: '#e0306a', emissive: '#5a0a22', flatShading: true });
    this.berries = new THREE.InstancedMesh(berryGeometry(), berryMat, Math.max(1, world.bushes.length * 3));

    const grassMat = patch(new THREE.MeshLambertMaterial({ vertexColors: true }), { sway: true });
    const grass = new THREE.InstancedMesh(grassGeometry(), grassMat, world.grass.length);
    world.grass.forEach((g, i) => {
      setInst(grass, i, g.x, world.heightAt(g.x, g.z) - 0.02, g.z, g.rot, g.scale, g.scale * (0.8 + g.shade * 0.6), g.scale);
      grass.setColorAt(i, tmpC.setRGB(0.8 + g.shade * 0.35, 0.85 + g.shade * 0.25, 0.75 + g.shade * 0.2));
    });
    const flowerColors = ['#ffffff', '#ffd43b', '#f783ac', '#b197fc', '#ff8787'];
    const flowers = new THREE.InstancedMesh(flowerGeometry(), propMat, Math.max(1, world.flowers.length));
    world.flowers.forEach((f, i) => {
      setInst(flowers, i, f.x, world.heightAt(f.x, f.z) - 0.02, f.z, f.rot, f.scale);
      flowers.setColorAt(i, tmpC.set(flowerColors[Math.floor(f.shade * flowerColors.length)]));
    });

    this.worldGroup.add(this.stumps, this.rocks, this.bushes, this.berries, grass, flowers);
    this.buildFireflies(world);
  }

  private buildFireflies(world: World): void {
    const n = 180;
    const pos = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const rnd = mulberry32(world.seed + 123);
    let k = 0;
    for (let tries = 0; tries < 4000 && k < n; tries++) {
      const x = (rnd() - 0.5) * world.size * 0.8;
      const z = (rnd() - 0.5) * world.size * 0.8;
      const h = world.heightAt(x, z);
      if (h < 0.8 || Math.hypot(x, z) < 8) continue;
      pos[k * 3] = x;
      pos[k * 3 + 1] = h + 0.6 + rnd() * 1.4;
      pos[k * 3 + 2] = z;
      phase[k] = rnd() * 100;
      k++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
    geo.setDrawRange(0, k);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uNight: U.uNight, uScale: { value: 400 } },
      vertexShader: `
        attribute float phase;
        uniform float uTime;
        uniform float uScale;
        varying float vBlink;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.6 + phase) * 0.8;
          p.y += sin(uTime * 0.9 + phase * 1.3) * 0.35;
          p.z += cos(uTime * 0.5 + phase * 0.7) * 0.8;
          vBlink = smoothstep(0.2, 1.0, sin(uTime * 2.2 + phase * 3.1));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = uScale * 0.09 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uNight;
        varying float vBlink;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * vBlink * uNight;
          gl_FragColor = vec4(vec3(0.75, 1.0, 0.45) * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.fireflies = new THREE.Points(geo, mat);
    this.fireflies.frustumCulled = false;
    this.worldGroup.add(this.fireflies);
  }

  // -------------------------------------------------------------------------
  // Per-frame updates
  // -------------------------------------------------------------------------

  /** One-off effects for simulation events. */
  fx(kind: 'chop' | 'mine' | 'fuel' | 'hit' | 'die' | 'build' | 'eat' | 'wall' | 'spawn' | 'burn', x: number, z: number): void {
    if (!this.world) return;
    const y = this.world.heightAt(x, z);
    switch (kind) {
      case 'chop':
        this.particles.burst(x, y + 1, z, '#c9a26b', 8, 3, 3);
        break;
      case 'mine':
        this.particles.burst(x, y + 0.6, z, '#b0aca4', 8, 3, 3);
        this.rockAnim.set(this.nearestRock(x, z), performance.now());
        break;
      case 'fuel':
        this.particles.burst(0, this.fireY + 0.8, 0, '#ffb347', 26, 2, 6);
        break;
      case 'hit':
        this.particles.burst(x, y + 0.7, z, '#5b2f8a', 10, 3.5, 3);
        break;
      case 'die':
        this.particles.burst(x, y + 0.6, z, '#2a1d3a', 18, 4, 4);
        this.particles.burst(x, y + 0.6, z, '#ffd44a', 6, 3, 4);
        break;
      case 'burn':
        this.particles.burst(x, y + 0.6, z, '#ff7a2a', 14, 2, 5);
        break;
      case 'build':
        this.particles.burst(x, y + 0.2, z, '#d8c7a3', 12, 2.5, 2);
        break;
      case 'eat':
        this.particles.burst(x, y + 1.2, z, '#e64980', 6, 1.5, 2);
        break;
      case 'wall':
        this.particles.burst(x, y + 0.8, z, '#9b968e', 8, 3, 3);
        break;
      case 'spawn':
        this.particles.burst(x, y + 0.3, z, '#1c1426', 10, 1.5, 2);
        break;
    }
  }

  private nearestRock(x: number, z: number): number {
    let best = -1;
    let bd = 1e9;
    this.world?.rocks.forEach((r, i) => {
      const d = (r.x - x) ** 2 + (r.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  private updateResources(state: SimState, now: number): void {
    const world = this.world!;
    let treesDirty = false;
    const animating = this.treeAnim.size > 0;
    for (let i = 0; i < world.trees.length; i++) {
      const wood = state.trees[i];
      const last = this.lastTrees[i];
      if (wood !== last) {
        if (last > 0 && wood === 0) this.treeAnim.set(i, { start: now, fell: true, dir: Math.random() * Math.PI * 2 });
        else if (last > 0 && wood < last) this.treeAnim.set(i, { start: now, fell: false, dir: 0 });
        else this.placeTree(i, wood > 0, 0, 0, 0);
        this.lastTrees[i] = wood;
        treesDirty = true;
      }
    }
    if (animating || treesDirty) {
      for (const [i, a] of this.treeAnim) {
        const t = (now - a.start) / 1000;
        if (a.fell) {
          if (t > 1.1) {
            this.treeAnim.delete(i);
            this.placeTree(i, false, 0, 0, 0);
          } else {
            const tilt = Math.min(1, (t / 0.9) ** 2) * (Math.PI / 2) * 0.95;
            const sink = Math.max(0, t - 0.8) * 3;
            this.placeTree(i, true, tilt, a.dir, sink);
          }
        } else if (t > 0.3) {
          this.treeAnim.delete(i);
          this.placeTree(i, state.trees[i] > 0, 0, 0, 0);
        } else {
          this.placeTree(i, true, Math.sin(t * 40) * 0.06 * (1 - t / 0.3), 0, 0);
        }
      }
      for (const m of this.trees) m.instanceMatrix.needsUpdate = true;
      this.stumps.instanceMatrix.needsUpdate = true;
    }

    let rocksDirty = false;
    for (let i = 0; i < world.rocks.length; i++) {
      const stone = state.rocks[i];
      const shake = this.rockAnim.get(i);
      const shaking = shake !== undefined && now - shake < 250;
      if (stone !== this.lastRocks[i] || shaking || (shake !== undefined && !shaking)) {
        const r = world.rocks[i];
        const s = stone > 0 ? r.scale * (0.55 + 0.15 * stone) : 0;
        const jig = shaking ? Math.sin((now - shake) * 0.12) * 0.05 : 0;
        setInst(this.rocks, i, r.x + jig, world.heightAt(r.x, r.z) - 0.1, r.z, r.rot, s);
        this.lastRocks[i] = stone;
        if (shake !== undefined && !shaking) this.rockAnim.delete(i);
        rocksDirty = true;
      }
    }
    if (rocksDirty) this.rocks.instanceMatrix.needsUpdate = true;

    let berriesDirty = false;
    for (let i = 0; i < world.bushes.length; i++) {
      const n = state.bushes[i];
      if (n === this.lastBushes[i]) continue;
      this.lastBushes[i] = n;
      berriesDirty = true;
      const b = world.bushes[i];
      const y = world.heightAt(b.x, b.z) - 0.05;
      const cos = Math.cos(b.rot);
      const sin = Math.sin(b.rot);
      for (let k = 0; k < 3; k++) {
        const [ox, oy, oz] = BERRY_OFFSETS[k];
        if (k < n) {
          const lx = (ox * cos + oz * sin) * b.scale;
          const lz = (-ox * sin + oz * cos) * b.scale;
          setInst(this.berries, i * 3 + k, b.x + lx, y + oy * b.scale, b.z + lz, 0, 1);
        } else {
          this.berries.setMatrixAt(i * 3 + k, HIDDEN);
        }
      }
    }
    if (berriesDirty) this.berries.instanceMatrix.needsUpdate = true;
  }

  private placeTree(i: number, standing: boolean, tilt: number, dir: number, sink: number): void {
    const world = this.world!;
    const t = world.trees[i];
    const [k, idx] = this.treeIndex[i];
    const y = world.heightAt(t.x, t.z) - 0.1;
    const mesh = this.trees[k];
    if (standing) {
      tmpE.set(0, t.rot, 0);
      tmpQ.setFromEuler(tmpE);
      if (tilt) {
        const axis = tmpP.set(Math.cos(dir), 0, Math.sin(dir));
        const q2 = new THREE.Quaternion().setFromAxisAngle(axis, tilt);
        tmpQ.premultiply(q2);
      }
      tmpS.setScalar(t.scale * (sink > 0 ? Math.max(0, 1 - sink * 0.5) : 1));
      tmpM.compose(new THREE.Vector3(t.x, y - sink, t.z), tmpQ, tmpS);
      mesh.setMatrixAt(idx, tmpM);
    } else {
      mesh.setMatrixAt(idx, HIDDEN);
    }
    const stump = !standing || sink > 0 || tilt > 0.2;
    if (stump) setInst(this.stumps, i, t.x, y, t.z, t.rot, t.scale);
    else this.stumps.setMatrixAt(i, HIDDEN);
  }

  private updateDynamic(state: SimState, alpha: number, time: number, dt: number, targets: (TargetMark | null)[]): void {
    const world = this.world!;
    const h = (x: number, z: number) => world.heightAt(x, z);
    let shadowN = 0;
    const shadow = (x: number, z: number, size: number) => {
      if (shadowN >= MAX_SHADOWS) return;
      setInst(this.shadows, shadowN++, x, h(x, z) + 0.04, z, 0, size);
    };

    // Players.
    const seen = new Set<number>();
    for (const p of state.players) {
      seen.add(p.slot);
      let model = this.players.get(p.slot);
      if (!model) {
        model = new PlayerModel(p.color);
        this.players.set(p.slot, model);
        this.scene.add(model.root);
      }
      const x = p.px + (p.x - p.px) * alpha;
      const z = p.pz + (p.z - p.pz) * alpha;
      model.update({
        x,
        y: h(x, z),
        z,
        fx: p.fx,
        fz: p.fz,
        speed: p.speed,
        downed: p.downed,
        item: p.item,
        swingT: p.swingT,
        action: p.actionKind,
        actionTime: p.actionTime,
        hurtT: p.hurtT,
        time,
        dt,
      });
      shadow(x, z, 1.1);
      const dr = this.downRings[p.slot - 1];
      dr.visible = p.downed;
      if (p.downed) {
        dr.position.set(x, h(x, z) + 0.08, z);
        const s = 1.3 + Math.sin(time * 6) * 0.15;
        dr.scale.setScalar(s);
        (dr.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.4 * Math.sin(time * 6);
      }
    }
    for (const [slot, model] of this.players) {
      if (!seen.has(slot)) {
        model.dispose();
        this.players.delete(slot);
        this.downRings[slot - 1].visible = false;
      }
    }

    // Target rings.
    for (let i = 0; i < 4; i++) {
      const t = targets[i];
      const ring = this.rings[i];
      ring.visible = !!t;
      if (!t) continue;
      ring.position.set(t.x, h(t.x, t.z) + 0.07, t.z);
      ring.scale.setScalar(t.r * (1 + Math.sin(time * 7) * 0.06));
      (ring.material as THREE.MeshBasicMaterial).color.set(t.color);
    }

    // Creatures.
    const cs = state.creatures;
    const n = Math.min(cs.length, MAX_CREATURES);
    for (let i = 0; i < n; i++) {
      const c = cs[i];
      const x = c.px + (c.x - c.px) * alpha;
      const z = c.pz + (c.z - c.pz) * alpha;
      const hop = Math.abs(Math.sin(time * 7 + c.id)) * 0.22;
      const lunge = c.attackT < 0.3 ? Math.sin((c.attackT / 0.3) * Math.PI) * 0.35 : 0;
      const spawn = Math.min(1, c.age / 0.7);
      const fade = c.flee ? Math.max(0, 1 - c.fleeT / 3) : 1;
      const s = spawn * fade;
      const squash = 1 + Math.sin(time * 14 + c.id) * 0.05;
      const yaw = Math.atan2(c.fx, c.fz);
      const lx = x + Math.sin(yaw) * lunge;
      const lz = z + Math.cos(yaw) * lunge;
      const y = h(x, z) + hop - (1 - spawn) * 1.0;
      setInst(this.creatureBody, i, lx, y, lz, yaw, s, s * squash, s);
      setInst(this.creatureEyes, i, lx, y, lz, yaw, s, s * squash, s);
      const hurt = Math.max(0, 1 - c.hurtT / 0.25);
      this.creatureBody.setColorAt(i, tmpC.setRGB(1 + hurt * 3, 1 + hurt * 1.5, 1 + hurt * 1.5));
      shadow(x, z, 1.4 * s);
    }
    this.creatureBody.count = this.creatureEyes.count = n;
    this.creatureBody.instanceMatrix.needsUpdate = true;
    this.creatureEyes.instanceMatrix.needsUpdate = true;
    if (this.creatureBody.instanceColor) this.creatureBody.instanceColor.needsUpdate = true;

    // Torches.
    const glowPos = this.torchGlow.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < TORCH.max; i++) {
      const t = state.torches[i];
      if (!t) {
        glowPos.setXYZ(i, 0, -1000, 0);
        continue;
      }
      const y = h(t.x, t.z);
      const grow = Math.min(1, t.age / 0.4);
      setInst(this.torchSticks, i, t.x, y, t.z, 0, grow);
      const flick = 0.85 + Math.sin(time * 17 + t.id * 3) * 0.1 + Math.sin(time * 23 + t.id) * 0.06;
      setInst(this.torchFlames, i, t.x, y + 1.45 * grow, t.z, time * 2 + t.id, 0.36 * grow, 0.5 * flick * grow, 0.36 * grow);
      glowPos.setXYZ(i, t.x, y + 1.6, t.z);
    }
    glowPos.needsUpdate = true;
    this.torchSticks.count = this.torchFlames.count = Math.min(state.torches.length, TORCH.max);
    this.torchSticks.instanceMatrix.needsUpdate = true;
    this.torchFlames.instanceMatrix.needsUpdate = true;

    // Walls.
    const wn = Math.min(state.walls.length, WALL.max);
    for (let i = 0; i < wn; i++) {
      const w = state.walls[i];
      setInst(this.walls, i, w.x, h(w.x, w.z) - 0.05, w.z, -Math.atan2(w.az, w.ax), 1);
      const v = 0.55 + 0.45 * (w.hp / WALL.hp);
      this.walls.setColorAt(i, tmpC.setRGB(v, v, v));
    }
    this.walls.count = wn;
    this.walls.instanceMatrix.needsUpdate = true;
    if (this.walls.instanceColor) this.walls.instanceColor.needsUpdate = true;

    // Dropped items.
    const counts = { wood: 0, stone: 0, berry: 0 };
    for (const it of state.items) {
      const mesh = this.items[it.type];
      const i = counts[it.type]++;
      if (i >= MAX_ITEMS_ON_GROUND) continue;
      const bob = Math.sin(time * 3 + it.id) * 0.06;
      setInst(mesh, i, it.x, h(it.x, it.z) + 0.05 + bob, it.z, time * 0.8 + it.id, 1.1);
      shadow(it.x, it.z, 0.9);
    }
    for (const type of ['wood', 'stone', 'berry'] as const) {
      this.items[type].count = Math.min(counts[type], MAX_ITEMS_ON_GROUND);
      this.items[type].instanceMatrix.needsUpdate = true;
    }

    this.shadows.count = shadowN;
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  private updateFire(state: SimState, time: number, dt: number): number {
    const fuel = state.fuel / FIRE.maxFuel;
    const out = state.fuel <= 0;
    const size = out ? 0 : 0.35 + 0.85 * Math.sqrt(fuel);
    this.flames.forEach((m, i) => {
      const flick = 1 + Math.sin(time * (11 + i * 3) + i) * 0.1 + Math.sin(time * (17 + i * 5)) * 0.07;
      const base = (m.userData.base as number) * size;
      m.scale.set(base * 0.9, base * flick * (1.1 + (i % 3) * 0.1), base * 0.9);
      m.rotation.y = time * (0.8 + i * 0.5);
      m.visible = size > 0;
    });
    const night = U.uNight.value;
    this.fireGlow.scale.setScalar(2 + size * (4 + 4 * night));
    (this.fireGlow.material as THREE.SpriteMaterial).opacity = size > 0 ? (0.2 + 0.4 * night) + Math.sin(time * 9) * 0.04 : 0;

    // Embers rise from the fire.
    const pos = this.embers.geometry.attributes.position as THREE.BufferAttribute;
    const d = this.emberData;
    for (let i = 0; i < pos.count; i++) {
      d[i * 4 + 3] += dt;
      if (d[i * 4 + 3] > 1.8) {
        d[i * 4 + 3] = 0;
        d[i * 4] = (Math.random() - 0.5) * 0.6;
        d[i * 4 + 1] = (Math.random() - 0.5) * 0.6;
        d[i * 4 + 2] = 1.2 + Math.random() * 1.4;
      }
      const t = d[i * 4 + 3];
      pos.setXYZ(
        i,
        d[i * 4] + Math.sin(time * 2 + i) * 0.25 * t,
        size > 0 ? 0.4 + t * d[i * 4 + 2] * size : -100,
        d[i * 4 + 1] + Math.cos(time * 1.7 + i) * 0.25 * t,
      );
    }
    pos.needsUpdate = true;

    const radius = out ? 0 : FIRE.minRadius + (FIRE.maxRadius - FIRE.minRadius) * Math.sqrt(fuel);
    const l = this.lights[0];
    l.position.set(0, this.fireY + 1.6, 0);
    const flicker = 1 + Math.sin(time * 13) * 0.05 + Math.sin(time * 7.3) * 0.05;
    l.intensity = out ? 0 : (6 + radius * 1.6) * flicker * (0.3 + 0.7 * night);
    l.distance = radius * 2.0 + 4;
    return radius;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  resize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight, true);
  }

  setPixelScale(scale: number): void {
    this.pixelScale = Math.max(0.5, Math.min(1, scale));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1) * this.maxPixelRatio * this.pixelScale);
    this.resize();
  }

  get currentPixelScale(): number {
    return this.pixelScale;
  }

  private view(slot: number): View {
    let v = this.views.get(slot);
    if (!v) {
      v = { cam: new THREE.PerspectiveCamera(50, 1, 0.5, 64), target: new THREE.Vector3(), init: false };
      this.views.set(slot, v);
    }
    return v;
  }

  render(f: FrameInput): void {
    if (!this.world) return;
    const { state, alpha, dt, time } = f;
    const world = this.world;
    const now = performance.now();
    U.uTime.value = time;

    // Atmosphere.
    const firstDay = state.night === 1 && state.phase === 'day';
    const atm = atmosphere(f.phase, f.phase === 'lobby' ? 0 : state.phaseTime, firstDay);
    (this.scene.background as THREE.Color).copy(atm.sky);
    this.fog.color.copy(atm.sky);
    this.fog.near = atm.fogNear;
    this.fog.far = atm.fogFar;
    this.hemi.color.copy(atm.hemiSky);
    this.hemi.groundColor.copy(atm.hemiGround);
    this.hemi.intensity = atm.hemi;
    this.sun.color.copy(atm.sun);
    this.sun.intensity = atm.sunI;
    this.sun.position.copy(atm.sunDir).multiplyScalar(50);
    U.uNight.value = Math.max(atm.night, f.phase === 'lobby' ? 0.4 : 0);

    this.updateResources(state, now);
    this.updateDynamic(state, alpha, time, dt, f.targets);
    const fireR = this.updateFire(state, time, dt);
    this.particles.update(dt, (x, z) => world.heightAt(x, z));

    // Safe-zone rings on the ground.
    const L = U.uLights.value;
    L[0].set(0, 0, fireR, 1);
    for (let i = 0; i < TORCH.max; i++) {
      const t = state.torches[i];
      if (t) L[i + 1].set(t.x, t.z, TORCH.radius * Math.min(1, t.age / 0.4), 0.8);
      else L[i + 1].set(0, 0, 0, 0);
    }

    const r = this.renderer;
    r.info.reset();
    const W = window.innerWidth;
    const H = window.innerHeight;
    r.setScissor(0, 0, W, H);
    r.setViewport(0, 0, W, H);

    if (f.orbit || f.views.length === 0) {
      const a = time * 0.05;
      const cam = this.orbitCam;
      cam.aspect = W / H;
      cam.updateProjectionMatrix();
      cam.position.set(Math.cos(a) * 24, this.fireY + 14, Math.sin(a) * 24);
      cam.lookAt(0, this.fireY + 1, 0);
      U.uFocus.value.set(0, -100, 0);
      U.uCamPos.value.copy(cam.position);
      this.assignTorchLights(state, 0, 0, time);
      r.render(this.scene, cam);
      return;
    }

    for (const { slot, rect } of f.views) {
      const p = state.players.find((q) => q.slot === slot);
      const v = this.view(slot);
      const px = p ? p.px + (p.x - p.px) * alpha : 0;
      const pz = p ? p.pz + (p.z - p.pz) * alpha : 0;
      const py = world.heightAt(px, pz);
      if (!v.init) {
        v.target.set(px, py, pz);
        v.init = true;
      }
      const k = 1 - Math.exp(-dt * 6);
      v.target.x += (px - v.target.x) * k;
      v.target.y += (py - v.target.y) * k;
      v.target.z += (pz - v.target.z) * k;

      const aspect = rect.w / Math.max(1, rect.h);
      const zoom = aspect < 1 ? 1 + (1 - aspect) * 0.6 : 1;
      const cam = v.cam;
      if (cam.aspect !== aspect) {
        cam.aspect = aspect;
        cam.updateProjectionMatrix();
      }
      cam.position.set(v.target.x, v.target.y + 10.5 * zoom, v.target.z + 8.2 * zoom);
      cam.lookAt(v.target.x, v.target.y + 0.6, v.target.z);

      U.uFocus.value.set(px, py + 0.9, pz);
      U.uCamPos.value.copy(cam.position);
      this.assignTorchLights(state, px, pz, time);

      const y = H - rect.y - rect.h; // WebGL origin is bottom-left
      r.setViewport(rect.x, y, rect.w, rect.h);
      r.setScissor(rect.x, y, rect.w, rect.h);
      r.render(this.scene, cam);
    }
  }

  /** Give the 7 spare point lights to the torches nearest this viewport. */
  private assignTorchLights(state: SimState, x: number, z: number, time: number): void {
    const torches = state.torches
      .map((t) => ({ t, d: (t.x - x) ** 2 + (t.z - z) ** 2 }))
      .sort((a, b) => a.d - b.d);
    for (let i = 1; i < MAX_LIGHTS; i++) {
      const l = this.lights[i];
      const e = torches[i - 1];
      if (!e || e.d > 45 * 45) {
        l.intensity = 0;
        continue;
      }
      const t = e.t;
      const grow = Math.min(1, t.age / 0.4);
      l.position.set(t.x, this.world!.heightAt(t.x, t.z) + 1.9, t.z);
      l.intensity = (5.5 + Math.sin(time * 15 + t.id) * 0.5) * grow;
      l.distance = TORCH.radius * 2.1;
    }
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }
}

