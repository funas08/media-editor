// サイズ変更・回転・反転の計算（UIに依存しない）

import { boundsOfPoints, DEG, itemBounds, unionRects } from '../core/geometry';
import type { DocState, Item, Point } from '../core/types';

/** 角度を (-180, 180] に正規化 */
export function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return Math.round(a * 1000) / 1000;
}

/** 点 p を center の周りに deg 度回転 */
export function rotatePoint(p: Point, center: Point, deg: number): Point {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
}

/** 拡大率 1 のときの、回転込みの外接サイズ */
function rotatedNaturalSize(it: Item): { w: number; h: number } {
  const w = it.crop.w;
  const h = it.crop.h;
  const c = Math.cos(it.rotation * DEG);
  const s = Math.sin(it.rotation * DEG);
  const pts = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ].map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
  const b = boundsOfPoints(pts);
  return { w: b.w, h: b.h };
}

/** キャンバスに収める（fit）／埋める（fill）。縦横比を保ってキャンバス中央に置く */
export function fitToCanvas(d: DocState, ids: readonly string[], mode: 'fit' | 'fill'): void {
  for (const it of d.items) {
    if (!ids.includes(it.id) || it.locked) continue;
    const n = rotatedNaturalSize(it);
    const sx = d.canvas.width / n.w;
    const sy = d.canvas.height / n.h;
    const s = mode === 'fit' ? Math.min(sx, sy) : Math.max(sx, sy);
    it.scaleX = s;
    it.scaleY = s;
    it.cx = d.canvas.width / 2;
    it.cy = d.canvas.height / 2;
  }
}

/** 各アイテムを自分の中心で回転させる */
export function rotateEach(d: DocState, ids: readonly string[], deltaDeg: number): void {
  for (const it of d.items) {
    if (ids.includes(it.id) && !it.locked) it.rotation = normalizeAngle(it.rotation + deltaDeg);
  }
}

export function flipEach(d: DocState, ids: readonly string[], axis: 'x' | 'y'): void {
  for (const it of d.items) {
    if (!ids.includes(it.id) || it.locked) continue;
    if (axis === 'x') it.flipX = !it.flipX;
    else it.flipY = !it.flipY;
  }
}

/**
 * キャンバスを指定アイテムの範囲（回転込みの外接矩形）に合わせる。
 * アイテムの見た目の位置関係は変えず、範囲の左上がキャンバスの原点に来るよう全アイテムをずらす。
 * @returns 合わせられたら true（対象がなければ false）
 */
export function fitCanvasToItems(d: DocState, ids: readonly string[]): boolean {
  const b = unionRects(d.items.filter((it) => ids.includes(it.id) && it.visible).map(itemBounds));
  if (!b || b.w < 0.5 || b.h < 0.5) return false;
  for (const it of d.items) {
    it.cx -= b.x;
    it.cy -= b.y;
  }
  d.canvas.width = Math.max(1, Math.round(b.w));
  d.canvas.height = Math.max(1, Math.round(b.h));
  return true;
}
