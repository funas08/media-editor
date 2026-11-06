// 幾何計算（アイテムの大きさ・四隅・当たり判定など）

import type { Item, Point, Rect } from './types';

export const DEG = Math.PI / 180;

/** アイテムのキャンバス上での大きさ（回転前） */
export function itemSize(it: Item): { w: number; h: number } {
  switch (it.type) {
    case 'image':
      return { w: it.crop.w * it.scaleX, h: it.crop.h * it.scaleY };
  }
}

/** アイテムの四隅（左上・右上・右下・左下）をキャンバス座標で返す */
export function itemCorners(it: Item): Point[] {
  const { w, h } = itemSize(it);
  const c = Math.cos(it.rotation * DEG);
  const s = Math.sin(it.rotation * DEG);
  const local: Point[] = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  return local.map((p) => ({ x: it.cx + p.x * c - p.y * s, y: it.cy + p.x * s + p.y * c }));
}

/** 回転を考慮した外接矩形 */
export function itemBounds(it: Item): Rect {
  return boundsOfPoints(itemCorners(it));
}

export function boundsOfPoints(pts: Point[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const pts: Point[] = [];
  for (const r of rects) pts.push({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h });
  return boundsOfPoints(pts);
}

/** キャンバス座標をアイテムのローカル座標（中心原点・回転なし）に変換 */
export function toLocal(it: Item, p: Point): Point {
  const dx = p.x - it.cx;
  const dy = p.y - it.cy;
  const c = Math.cos(-it.rotation * DEG);
  const s = Math.sin(-it.rotation * DEG);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function hitTest(it: Item, p: Point): boolean {
  const { w, h } = itemSize(it);
  const l = toLocal(it, p);
  return Math.abs(l.x) <= w / 2 && Math.abs(l.y) <= h / 2;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
