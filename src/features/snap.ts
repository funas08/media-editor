// スナップ：移動中の範囲をキャンバスや他の画像の端・中央に吸着させる

import { itemBounds } from '../core/geometry';
import type { DocState, Rect } from '../core/types';

/** スナップの設定（アプリ全体で共有） */
export const snapSettings = { enabled: true };

/** 吸着先の座標の一覧 */
export interface SnapTargets {
  xs: number[];
  ys: number[];
}

/** 吸着したときに表示するガイド線（キャンバス座標） */
export interface Guides {
  xs: number[];
  ys: number[];
}

/** 吸着先：キャンバスの端・中央と、対象外の画像の端・中央 */
export function collectSnapTargets(doc: DocState, excludeIds: readonly string[]): SnapTargets {
  const { width: W, height: H } = doc.canvas;
  const xs = [0, W / 2, W];
  const ys = [0, H / 2, H];
  for (const it of doc.items) {
    if (!it.visible || excludeIds.includes(it.id)) continue;
    const b = itemBounds(it);
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

/** 1軸ぶんの吸着計算。最も近い吸着先までの補正量（なければ 0）と、そろった座標を返す */
function snapAxis(edges: number[], targets: number[], threshold: number): { delta: number; lines: number[] } {
  let best: number | null = null;
  for (const e of edges) {
    for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  if (best === null) return { delta: 0, lines: [] };
  const delta = best;
  const lines = targets.filter((t) => edges.some((e) => Math.abs(e + delta - t) < 0.01));
  return { delta, lines: [...new Set(lines)] };
}

/**
 * 移動中の範囲 box を吸着させる。
 * @param threshold 吸着する距離（キャンバス座標）
 * @param axis 'x' / 'y' のみ吸着させる場合に指定（Shift で軸を固定しているとき）
 */
export function snapRect(box: Rect, targets: SnapTargets, threshold: number, axis: 'both' | 'x' | 'y' = 'both'): { dx: number; dy: number; guides: Guides } {
  const sx = axis === 'y' ? { delta: 0, lines: [] } : snapAxis([box.x, box.x + box.w / 2, box.x + box.w], targets.xs, threshold);
  const sy = axis === 'x' ? { delta: 0, lines: [] } : snapAxis([box.y, box.y + box.h / 2, box.y + box.h], targets.ys, threshold);
  return { dx: sx.delta, dy: sy.delta, guides: { xs: sx.lines, ys: sy.lines } };
}
