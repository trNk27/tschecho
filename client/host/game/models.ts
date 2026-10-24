// Low-poly geometry, built in code. Each prop type is merged into one geometry
// with vertex colours so it can be drawn as a single InstancedMesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './rng';

/** Non-indexed copy with a solid vertex colour and no uvs, ready to merge. */
export function colored(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.dispose();
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('merge failed');
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function jitter(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  // Move shared vertices together so the shape stays closed.
  const rnd = mulberry32(seed);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const offsets = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let o = offsets.get(key);
    if (!o) offsets.set(key, (o = [(rnd() - 0.5) * amount, (rnd() - 0.5) * amount, (rnd() - 0.5) * amount]));
    pos.setXYZ(i, pos.getX(i) + o[0], pos.getY(i) + o[1], pos.getZ(i) + o[2]);
  }
  return geo;
}

export function pineGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.CylinderGeometry(0.16, 0.24, 1.3, 5).translate(0, 0.65, 0), '#6b4a2f'),
    colored(new THREE.ConeGeometry(1.15, 1.7, 7).translate(0, 1.75, 0), '#2d6a3e'),
    colored(new THREE.ConeGeometry(0.9, 1.45, 7).translate(0, 2.55, 0), '#367a45'),
    colored(new THREE.ConeGeometry(0.58, 1.15, 7).translate(0, 3.25, 0), '#418a4d'),
  ]);
}

export function roundTreeGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.CylinderGeometry(0.15, 0.22, 1.7, 5).translate(0, 0.85, 0), '#74502f'),
    colored(jitter(new THREE.IcosahedronGeometry(1.15, 0), 0.25, 3).scale(1, 0.9, 1).translate(0, 2.3, 0), '#5c9a3c'),
    colored(jitter(new THREE.IcosahedronGeometry(0.75, 0), 0.2, 4).translate(0.55, 2.85, 0.2), '#6cae48'),
    colored(jitter(new THREE.IcosahedronGeometry(0.6, 0), 0.2, 5).translate(-0.5, 2.0, -0.35), '#528e36'),
  ]);
}

export function stumpGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.CylinderGeometry(0.24, 0.3, 0.35, 6).translate(0, 0.17, 0), '#6b4a2f'),
    colored(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 6).translate(0, 0.355, 0), '#c9a26b'),
  ]);
}

export function rockGeometry(): THREE.BufferGeometry {
  return merge([
    colored(jitter(new THREE.DodecahedronGeometry(0.85, 0), 0.3, 7).scale(1.1, 0.75, 1).translate(0, 0.35, 0), '#8f8c86'),
    colored(jitter(new THREE.DodecahedronGeometry(0.45, 0), 0.2, 8).translate(0.75, 0.15, 0.3), '#7d7a75'),
  ]);
}

export function bushGeometry(): THREE.BufferGeometry {
  return merge([
    colored(jitter(new THREE.IcosahedronGeometry(0.7, 0), 0.2, 9).scale(1.1, 0.75, 1.1).translate(0, 0.45, 0), '#3f7f37'),
    colored(jitter(new THREE.IcosahedronGeometry(0.45, 0), 0.15, 10).translate(0.45, 0.4, 0.25), '#4b8f3f'),
    colored(jitter(new THREE.IcosahedronGeometry(0.4, 0), 0.15, 11).translate(-0.4, 0.35, -0.2), '#37712f'),
  ]);
}

/** Positions of the berries on a bush, in bush-local space (before scale/rotation). */
export const BERRY_OFFSETS: [number, number, number][] = [
  [0.35, 0.82, 0.32],
  [-0.4, 0.7, 0.22],
  [0.05, 0.72, -0.48],
];

export function berryGeometry(): THREE.BufferGeometry {
  return colored(new THREE.IcosahedronGeometry(0.13, 0), '#ffffff');
}

export function grassGeometry(): THREE.BufferGeometry {
  // Three thin blades, each with both windings and an "up" normal so they
  // are lit like the ground from every side (no dark back faces).
  const base = new THREE.Color('#3f7a2c');
  const tip = new THREE.Color('#9ccf5e');
  const pos: number[] = [];
  const col: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const w = 0.09;
    const h = 0.42 + k * 0.08;
    const ox = Math.cos(a) * 0.08;
    const oz = Math.sin(a) * 0.08;
    const lean = 0.12 * (k - 1);
    const p0 = [ox - Math.cos(a + Math.PI / 2) * w, 0, oz - Math.sin(a + Math.PI / 2) * w];
    const p1 = [ox + Math.cos(a + Math.PI / 2) * w, 0, oz + Math.sin(a + Math.PI / 2) * w];
    const p2 = [ox + lean, h, oz + lean * 0.5];
    pos.push(...p0, ...p1, ...p2, ...p1, ...p0, ...p2);
    for (const c of [base, base, tip, base, base, tip]) col.push(c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.computeBoundingSphere();
  return g;
}

export function flowerGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 3).translate(0, 0.15, 0), '#4b7f33'),
    colored(new THREE.OctahedronGeometry(0.09, 0).scale(1, 0.6, 1).translate(0, 0.32, 0), '#ffffff'),
  ]);
}

export function campfireStones(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    parts.push(
      colored(
        jitter(new THREE.DodecahedronGeometry(0.26, 0), 0.08, 20 + i)
          .scale(1.2, 0.8, 1)
          .rotateY(-a)
          .translate(Math.cos(a) * 0.95, 0.12, Math.sin(a) * 0.95),
        i % 2 ? '#77736d' : '#8c8882',
      ),
    );
  }
  return merge(parts);
}

export function campfireLogs(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(
      colored(
        new THREE.CylinderGeometry(0.09, 0.11, 1.2, 5)
          .rotateZ(Math.PI / 2 - 0.55)
          .translate(0.4, 0.3, 0)
          .rotateY(a),
        i % 2 ? '#5a3a22' : '#6b4429',
      ),
    );
  }
  parts.push(colored(new THREE.CylinderGeometry(0.55, 0.6, 0.06, 8).translate(0, 0.03, 0), '#2b1d16'));
  return merge(parts);
}

export function flameGeometry(): THREE.BufferGeometry {
  return new THREE.ConeGeometry(0.5, 1.4, 6, 1, true).translate(0, 0.7, 0);
}

export function logGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 6).rotateZ(Math.PI / 2).translate(0, 0.12, 0.1), '#7a5232'),
    colored(new THREE.CylinderGeometry(0.11, 0.11, 0.75, 6).rotateZ(Math.PI / 2).rotateY(0.6).translate(0, 0.12, -0.12), '#6b4429'),
    colored(new THREE.CylinderGeometry(0.11, 0.11, 0.7, 6).rotateZ(Math.PI / 2).rotateY(-0.3).translate(0, 0.33, 0), '#83593a'),
  ]);
}

export function stonePileGeometry(): THREE.BufferGeometry {
  return merge([
    colored(jitter(new THREE.DodecahedronGeometry(0.2, 0), 0.06, 31).translate(-0.15, 0.15, 0), '#9a968f'),
    colored(jitter(new THREE.DodecahedronGeometry(0.18, 0), 0.06, 32).translate(0.17, 0.13, 0.08), '#86837d'),
    colored(jitter(new THREE.DodecahedronGeometry(0.16, 0), 0.06, 33).translate(0.0, 0.33, -0.02), '#a3a099'),
  ]);
}

export function berryPileGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const offs = [
    [0, 0.1, 0],
    [0.18, 0.1, 0.05],
    [-0.12, 0.1, 0.14],
    [0.05, 0.25, 0.05],
    [-0.05, 0.1, -0.16],
  ];
  offs.forEach(([x, y, z], i) => parts.push(colored(new THREE.IcosahedronGeometry(0.1, 0).translate(x, y, z), i % 2 ? '#c2255c' : '#e64980')));
  parts.push(colored(new THREE.ConeGeometry(0.06, 0.12, 4).translate(0, 0.35, 0.05), '#4b8f3f'));
  return merge(parts);
}

export function torchGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.CylinderGeometry(0.05, 0.07, 1.35, 5).translate(0, 0.67, 0), '#6b4429'),
    colored(new THREE.CylinderGeometry(0.11, 0.08, 0.22, 6).translate(0, 1.4, 0), '#3a2a20'),
  ]);
}

export function wallGeometry(len: number, thick: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rnd = mulberry32(77);
  const n = 3;
  const bw = len / n;
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + bw * (i + 0.5);
    parts.push(
      colored(
        jitter(new THREE.BoxGeometry(bw * 0.96, 0.55, thick), 0.06, 40 + i)
          .rotateY((rnd() - 0.5) * 0.12)
          .translate(x, 0.27, (rnd() - 0.5) * 0.05),
        i % 2 ? '#8a867f' : '#9b968e',
      ),
    );
  }
  for (let i = 0; i < n - 1; i++) {
    const x = -len / 2 + bw * (i + 1);
    parts.push(
      colored(
        jitter(new THREE.BoxGeometry(bw * 0.95, 0.5, thick * 0.9), 0.06, 50 + i)
          .rotateY((rnd() - 0.5) * 0.15)
          .translate(x, 0.8, 0),
        i % 2 ? '#a19d95' : '#85817a',
      ),
    );
  }
  parts.push(colored(jitter(new THREE.BoxGeometry(bw * 0.7, 0.4, thick * 0.85), 0.05, 60).translate(0, 1.22, 0), '#928e87'));
  return merge(parts);
}

export function creatureBodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    colored(jitter(new THREE.IcosahedronGeometry(0.58, 1), 0.12, 70).scale(1, 0.85, 1.15).translate(0, 0.55, 0), '#2a1d3a'),
    colored(new THREE.ConeGeometry(0.12, 0.45, 4).rotateX(-0.5).translate(0.2, 1.05, -0.05), '#150d20'),
    colored(new THREE.ConeGeometry(0.12, 0.45, 4).rotateX(-0.5).translate(-0.2, 1.05, -0.05), '#150d20'),
    colored(new THREE.ConeGeometry(0.1, 0.35, 4).rotateX(-1.1).translate(0, 0.95, -0.4), '#150d20'),
    // Teeth
    colored(new THREE.ConeGeometry(0.05, 0.14, 3).rotateX(Math.PI).translate(0.1, 0.36, 0.6), '#d9d2c5'),
    colored(new THREE.ConeGeometry(0.05, 0.14, 3).rotateX(Math.PI).translate(-0.1, 0.36, 0.6), '#d9d2c5'),
  ];
  return merge(parts);
}

export function creatureEyesGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.IcosahedronGeometry(0.12, 0).scale(1, 0.75, 0.6).translate(0.2, 0.74, 0.56), '#ffffff'),
    colored(new THREE.IcosahedronGeometry(0.12, 0).scale(1, 0.75, 0.6).translate(-0.2, 0.74, 0.56), '#ffffff'),
  ]);
}

/** A soft round texture for blob shadows and glows. */
export function radialTexture(inner: string, outer: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
