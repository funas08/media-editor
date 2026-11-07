// 整列・分布（回転を考慮した外接矩形を基準にする）

import { itemBounds, unionRects } from '../core/geometry';
import type { DocState, Item, Rect } from '../core/types';

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

function pick(d: DocState, ids: readonly string[]): Item[] {
  return d.items.filter((it) => ids.includes(it.id) && !it.locked);
}

/**
 * 整列。1つならキャンバス基準、複数なら選択範囲基準
 */
export function alignItems(d: DocState, ids: readonly string[], kind: AlignKind): void {
  const items = pick(d, ids);
  if (items.length === 0) return;
  const ref: Rect =
    items.length === 1 ? { x: 0, y: 0, w: d.canvas.width, h: d.canvas.height } : (unionRects(items.map(itemBounds)) as Rect);
  for (const it of items) {
    const b = itemBounds(it);
    switch (kind) {
      case 'left':
        it.cx += ref.x - b.x;
        break;
      case 'hcenter':
        it.cx += ref.x + ref.w / 2 - (b.x + b.w / 2);
        break;
      case 'right':
        it.cx += ref.x + ref.w - (b.x + b.w);
        break;
      case 'top':
        it.cy += ref.y - b.y;
        break;
      case 'vcenter':
        it.cy += ref.y + ref.h / 2 - (b.y + b.h / 2);
        break;
      case 'bottom':
        it.cy += ref.y + ref.h - (b.y + b.h);
        break;
    }
  }
}

/**
 * 等間隔に分布（3つ以上）。両端の画像は動かさず、間の画像のすき間を均等にする
 * @returns 分布できたら true
 */
export function distributeItems(d: DocState, ids: readonly string[], axis: 'h' | 'v'): boolean {
  const items = pick(d, ids);
  if (items.length < 3) return false;
  const list = items.map((it) => ({ it, b: itemBounds(it) }));
  if (axis === 'h') {
    list.sort((a, b) => a.b.x - b.b.x);
    const start = list[0].b.x;
    const end = Math.max(...list.map((e) => e.b.x + e.b.w));
    const total = list.reduce((s, e) => s + e.b.w, 0);
    const gap = (end - start - total) / (list.length - 1);
    let x = start;
    for (const e of list) {
      e.it.cx += x - e.b.x;
      x += e.b.w + gap;
    }
  } else {
    list.sort((a, b) => a.b.y - b.b.y);
    const start = list[0].b.y;
    const end = Math.max(...list.map((e) => e.b.y + e.b.h));
    const total = list.reduce((s, e) => s + e.b.h, 0);
    const gap = (end - start - total) / (list.length - 1);
    let y = start;
    for (const e of list) {
      e.it.cy += y - e.b.y;
      y += e.b.h + gap;
    }
  }
  return true;
}
