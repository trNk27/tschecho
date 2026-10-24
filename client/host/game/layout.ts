// Split-screen layouts.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  views: Rect[];
  /** Free 4th cell when three players share a 2x2 grid. */
  extra: Rect | null;
}

export function computeLayout(w: number, h: number, n: number): Layout {
  const hw = Math.floor(w / 2);
  const hh = Math.floor(h / 2);
  if (n <= 1) return { views: [{ x: 0, y: 0, w, h }], extra: null };
  if (n === 2) {
    return {
      views: [
        { x: 0, y: 0, w: hw, h },
        { x: hw, y: 0, w: w - hw, h },
      ],
      extra: null,
    };
  }
  const grid = [
    { x: 0, y: 0, w: hw, h: hh },
    { x: hw, y: 0, w: w - hw, h: hh },
    { x: 0, y: hh, w: hw, h: h - hh },
    { x: hw, y: hh, w: w - hw, h: h - hh },
  ];
  return n === 3 ? { views: grid.slice(0, 3), extra: grid[3] } : { views: grid, extra: null };
}
