// Day/night colours and light levels.

import * as THREE from 'three';
import { DAWN_BLEND, PHASE_TIME } from './config';
import type { Phase } from './sim';

interface Palette {
  sky: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemi: number;
  sun: THREE.Color;
  sunI: number;
  fogNear: number;
  fogFar: number;
  night: number;
}

const pal = (
  sky: string,
  hemiSky: string,
  hemiGround: string,
  hemi: number,
  sun: string,
  sunI: number,
  fogNear: number,
  fogFar: number,
  night: number,
): Palette => ({
  sky: new THREE.Color(sky),
  hemiSky: new THREE.Color(hemiSky),
  hemiGround: new THREE.Color(hemiGround),
  hemi,
  sun: new THREE.Color(sun),
  sunI,
  fogNear,
  fogFar,
  night,
});

const DAY = pal('#9fd4ee', '#e4f3ff', '#6d8a4a', 1.55, '#fff3dc', 2.3, 34, 66, 0);
const GOLD = pal('#f2b47e', '#ffdcb0', '#6b5a3a', 1.35, '#ffb26b', 2.0, 30, 62, 0.1);
const DUSK = pal('#a8455e', '#ff9a7a', '#3a2430', 0.85, '#ff5a2a', 1.0, 22, 56, 0.55);
const NIGHT = pal('#060914', '#3a4a7c', '#0a0d16', 0.32, '#9db4ff', 0.3, 12, 46, 1);
const DAWN = pal('#f3a59a', '#ffd0c0', '#4a4040', 1.0, '#ffb0a0', 1.2, 24, 58, 0.35);

const tmp = pal('#000', '#000', '#000', 0, '#000', 0, 0, 0, 0);

function mix(a: Palette, b: Palette, t: number): Palette {
  t = Math.min(1, Math.max(0, t));
  tmp.sky.copy(a.sky).lerp(b.sky, t);
  tmp.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  tmp.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  tmp.hemi = a.hemi + (b.hemi - a.hemi) * t;
  tmp.sun.copy(a.sun).lerp(b.sun, t);
  tmp.sunI = a.sunI + (b.sunI - a.sunI) * t;
  tmp.fogNear = a.fogNear + (b.fogNear - a.fogNear) * t;
  tmp.fogFar = a.fogFar + (b.fogFar - a.fogFar) * t;
  tmp.night = a.night + (b.night - a.night) * t;
  return tmp;
}

export interface Atmosphere extends Palette {
  /** Sun direction (unit vector pointing towards the sun). */
  sunDir: THREE.Vector3;
}

const sunDir = new THREE.Vector3();

/** `firstDay` skips the dawn blend at the very start of a run. */
export function atmosphere(phase: Phase | 'lobby', phaseTime: number, firstDay: boolean): Atmosphere {
  let p: Palette;
  let dayFrac = 0.5;
  if (phase === 'lobby') {
    p = mix(GOLD, DUSK, 0.25);
    dayFrac = 0.85;
  } else if (phase === 'day') {
    const end = PHASE_TIME.day;
    dayFrac = phaseTime / end;
    if (!firstDay && phaseTime < DAWN_BLEND) {
      const t = phaseTime / DAWN_BLEND;
      p = t < 0.5 ? mix(NIGHT, DAWN, t * 2) : mix(DAWN, DAY, (t - 0.5) * 2);
    } else if (phaseTime > end - 25) {
      p = mix(DAY, GOLD, (phaseTime - (end - 25)) / 25);
    } else {
      p = mix(DAY, DAY, 0);
    }
  } else if (phase === 'dusk') {
    const t = phaseTime / PHASE_TIME.dusk;
    dayFrac = 1 + t * 0.1;
    p = t < 0.5 ? mix(GOLD, DUSK, t * 2) : mix(DUSK, NIGHT, (t - 0.5) * 2);
  } else {
    p = mix(NIGHT, NIGHT, 0);
    dayFrac = 0.5;
  }

  if (phase === 'night') {
    // Moon high in the sky.
    sunDir.set(-0.3, 1, 0.45).normalize();
  } else {
    const a = Math.PI * (0.15 + 0.7 * Math.min(1.1, dayFrac));
    sunDir.set(Math.cos(a), Math.sin(a) * 0.9 + 0.25, 0.5).normalize();
  }
  return { ...p, sunDir };
}
