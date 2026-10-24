// HTML overlay on top of the split screen: per-viewport frames, the shared
// strip across the centre, phase banners and the 4th-cell mini-map.

import { FIRE, TORCH, phaseLength } from './game/config';
import type { Layout } from './game/layout';
import type { PlayerState, Sim } from './game/sim';
import type { World } from './game/world';

const $ = (id: string) => document.getElementById(id)!;
const ITEM_ICON: Record<string, string> = { wood: '🪵', stone: '🪨', berry: '🫐', fuel: '⛽', can: '🥫' };

interface FrameEls {
  root: HTMLElement;
  name: HTMLElement;
  item: HTMLElement;
  gear: HTMLElement;
  area: HTMLElement;
  hp: HTMLElement;
  food: HTMLElement;
  hint: HTMLElement;
  progress: HTMLElement;
  progressBar: HTMLElement;
  alert: HTMLElement;
  cover: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

export function fmtTime(s: number): string {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Hud {
  private frames = new Map<number, FrameEls>();
  private bannerTimer = 0;
  private minimapBase: HTMLCanvasElement | null = null;
  private mapWorld: World | null = null;

  show(on: boolean): void {
    $('hud').hidden = !on;
  }

  banner(title: string, sub = '', ms = 3200): void {
    const b = $('banner');
    b.textContent = title;
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      b.appendChild(s);
    }
    b.classList.add('on');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('on'), ms);
  }

  private frame(p: PlayerState): FrameEls {
    let f = this.frames.get(p.slot);
    if (f) return f;
    const root = el('div', 'frame', $('frames'));
    root.style.setProperty('--c', p.color);
    const tag = el('div', 'tag', root);
    const nameRow = el('div', 'name', tag);
    el('i', '', nameRow);
    const name = el('span', '', nameRow);
    const item = el('span', 'item', nameRow);
    const hpBar = el('div', 'mini-bar hp', tag);
    const hp = el('i', '', hpBar);
    const foodBar = el('div', 'mini-bar food', tag);
    const food = el('i', '', foodBar);
    const meta = el('div', 'meta', tag);
    const gear = el('span', 'gear', meta);
    const area = el('span', 'area', meta);
    const progress = el('div', 'progress', root);
    const progressBar = el('i', '', progress);
    const hint = el('div', 'hint', root);
    const alert = el('div', 'alert', root);
    const cover = el('div', 'cover', root);
    cover.hidden = true;
    f = { root, name, item, gear, area, hp, food, hint, progress, progressBar, alert, cover };
    this.frames.set(p.slot, f);
    return f;
  }

  update(sim: Sim, layout: Layout, slots: number[], paused: boolean): void {
    const s = sim.state;
    const used = new Set<number>();

    slots.forEach((slot, i) => {
      const p = sim.player(slot);
      const rect = layout.views[i];
      if (!p || !rect) return;
      used.add(slot);
      const f = this.frame(p);
      f.root.style.cssText = `--c:${p.color};left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
      // Right-column frames keep their name tag on the outside, away from the shared strip.
      f.root.classList.toggle('flip', rect.x > 0);
      f.name.textContent = p.name;
      f.item.textContent = p.item ? `${ITEM_ICON[p.item.type]}×${p.item.count}` : '';
      f.hp.style.transform = `scaleX(${Math.max(0, p.hp) / 100})`;
      f.gear.textContent = sim.gearText(p);
      f.area.textContent = p.area >= 0 ? `📍 ${sim.districtName(p.area)}` : '';
      f.area.className = `area tier${p.area}`;
      f.food.style.transform = `scaleX(${p.food / 100})`;
      const hud = sim.hudFor(slot);
      // Goals already show in the shared pill at the top.
      const hint = hud?.hint ?? '';
      f.hint.textContent = p.downed || hint.startsWith('🎯') ? '' : hint;
      const prog = hud?.progress ?? 0;
      f.progress.classList.toggle('on', prog > 0 && !p.downed);
      f.progressBar.style.transform = `scaleX(${prog})`;
      const down = s.players.find((q) => q !== p && q.downed);
      f.alert.textContent = down && !p.downed ? `⚠ ${down.name} is down!` : '';

      if (!p.connected) {
        f.cover.hidden = false;
        f.cover.className = 'cover offline';
        f.cover.textContent = '📵 Controller disconnected';
        const small = document.createElement('small');
        small.textContent = 'Reopen the page on the phone to reconnect';
        f.cover.appendChild(small);
      } else if (p.downed) {
        f.cover.hidden = false;
        f.cover.className = 'cover downed';
        f.cover.textContent = p.reviveProgress > 0 ? `Reviving… ${Math.round(p.reviveProgress * 100)}%` : 'Downed!';
        const small = document.createElement('small');
        small.textContent = 'A teammate can hold A next to you';
        f.cover.appendChild(small);
      } else {
        f.cover.hidden = true;
      }
    });
    for (const [slot, f] of this.frames) {
      if (!used.has(slot)) {
        f.root.remove();
        this.frames.delete(slot);
      }
    }

    // Shared strip.
    const strip = $('strip');
    strip.classList.toggle('center', slots.length >= 3);
    const phaseName =
      s.phase === 'day' ? `☀️ Day ${s.night}` : s.phase === 'dusk' ? `🌇 Dusk ${s.night}` : `🌙 Night ${s.night}`;
    $('strip-phase').textContent = `${phaseName} / ${s.nights}`;
    const left =
      s.phase === 'day'
        ? `Dusk in ${fmtTime(phaseLength('day', s.night) - s.phaseTime)}`
        : s.phase === 'dusk'
          ? `Night in ${fmtTime(phaseLength('dusk', s.night) - s.phaseTime)}`
          : `Dawn in ${fmtTime(phaseLength('night', s.night) - s.phaseTime)}`;
    $('strip-time').textContent = left;
    const fuel = s.fuel / FIRE.maxFuel;
    for (const id of ['strip-fuel', 'extra-fuel']) {
      const bar = $(id);
      bar.style.transform = `scaleX(${fuel})`;
      bar.parentElement!.classList.toggle('low', fuel < 0.25);
    }
    $('paused').hidden = !paused;

    // Guided goals during the first days.
    const goal = sim.currentGoal();
    const goalEl = $('goal');
    goalEl.hidden = !goal;
    goalEl.classList.toggle('center', slots.length >= 3);
    if (goal) goalEl.textContent = `🎯 ${goal.text}  (${goal.index}/${goal.total})`;

    // Fourth cell (3 players): mini-map + fire status.
    const extra = $('extra-cell');
    if (layout.extra) {
      extra.hidden = false;
      const r = layout.extra;
      extra.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
      $('extra-text').textContent = `${Math.round(fuel * 100)}% · ${s.torches.length} torch${s.torches.length === 1 ? '' : 'es'}`;
      this.drawMinimap(sim);
    } else {
      extra.hidden = true;
    }
  }

  private drawMinimap(sim: Sim): void {
    const canvas = $('minimap') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const world = sim.world;
    const S = canvas.width;
    if (this.mapWorld !== world || !this.minimapBase) {
      this.mapWorld = world;
      this.minimapBase = document.createElement('canvas');
      this.minimapBase.width = this.minimapBase.height = S;
      const b = this.minimapBase.getContext('2d')!;
      const img = b.createImageData(S, S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const wx = (x / S - 0.5) * world.size;
          const wz = (y / S - 0.5) * world.size;
          const h = world.heightAt(wx, wz);
          const i = (y * S + x) * 4;
          let c: [number, number, number];
          if (h < 0) c = [40, 110, 160];
          else if (h < 0.6) c = [222, 200, 148];
          else {
            const f = world.forestAt(wx, wz);
            c = [Math.round(100 - f * 40), Math.round(170 - f * 50), Math.round(80 - f * 25)];
          }
          img.data[i] = c[0];
          img.data[i + 1] = c[1];
          img.data[i + 2] = c[2];
          img.data[i + 3] = 255;
        }
      }
      b.putImageData(img, 0, 0);
      // The city: streets, then buildings tinted by district.
      const c = world.city;
      const px = (v: number) => (v / world.size + 0.5) * S;
      b.fillStyle = '#4a4c50';
      b.fillRect(px(c.x0), px(c.z0), px(c.x1) - px(c.x0), px(c.z1) - px(c.z0));
      const tint = ['#9a948a', '#a0705a', '#7a3030'];
      for (const bl of c.blocks) {
        b.fillStyle = bl.park ? '#5f9f41' : tint[bl.tier];
        b.fillRect(px(bl.x0), px(bl.z0), px(bl.x1) - px(bl.x0), px(bl.z1) - px(bl.z0));
      }
    }
    const s = sim.state;
    const toPx = (v: number) => (v / world.size + 0.5) * S;
    ctx.drawImage(this.minimapBase, 0, 0);
    if (s.phase !== 'day') {
      ctx.fillStyle = s.phase === 'night' ? 'rgba(5,8,25,0.55)' : 'rgba(60,20,40,0.3)';
      ctx.fillRect(0, 0, S, S);
    }
    ctx.fillStyle = 'rgba(255,150,60,0.35)';
    ctx.beginPath();
    ctx.arc(toPx(0), toPx(0), (sim.fireRadius() / world.size) * S, 0, Math.PI * 2);
    ctx.fill();
    for (const t of s.torches) {
      ctx.beginPath();
      ctx.arc(toPx(t.x), toPx(t.z), (TORCH.radius / world.size) * S, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffcf4a';
    ctx.beginPath();
    ctx.arc(toPx(0), toPx(0), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b02020';
    for (const c of s.creatures) {
      if (c.flee) continue;
      ctx.fillRect(toPx(c.x) - 2, toPx(c.z) - 2, 4, 4);
    }
    ctx.fillStyle = '#9be15d';
    for (const z of s.zombies) ctx.fillRect(toPx(z.x) - 1.5, toPx(z.z) - 1.5, 3, 3);
    for (const p of s.players) {
      ctx.fillStyle = p.color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(toPx(p.x), toPx(p.z), 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
