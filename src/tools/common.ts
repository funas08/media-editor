// 複数のツールで使う共通処理（クリックで選択、ハンドルの位置と当たり判定、カーソル）

import { DEG, itemSize } from '../core/geometry';
import type { Item, Point } from '../core/types';
import { topItemAt } from '../features/commands';
import type { View } from '../render/view';
import type { ToolHost, ToolPointerEvent } from './Tool';

/** クリック位置の画像を選択する（Shift で追加・解除）。何もない所なら選択解除 */
export function selectAt(e: ToolPointerEvent, host: ToolHost): Item | undefined {
  const { editor } = host;
  const hit = topItemAt(editor.doc.items, e.doc, false, (it) => host.isShown(it));
  if (!hit) {
    if (!e.shift) editor.setSelection([]);
    return undefined;
  }
  if (e.shift) {
    const sel = editor.selection;
    editor.setSelection(sel.includes(hit.id) ? sel.filter((id) => id !== hit.id) : [...sel, hit.id]);
  } else if (!editor.isSelected(hit.id)) {
    editor.setSelection([hit.id]);
  }
  return hit;
}

/** 選択中のアイテムが1つで、編集可能ならそれを返す */
export function singleEditable(host: ToolHost): Item | null {
  const { editor } = host;
  if (editor.selection.length !== 1) return null;
  const it = editor.doc.items.find((x) => x.id === editor.selection[0]);
  return it && it.visible && !it.locked ? it : null;
}

/** 8方向のハンドル（hx, hy は -1 / 0 / 1） */
export const HANDLE_DIRS: ReadonlyArray<{ hx: number; hy: number }> = [
  { hx: -1, hy: -1 },
  { hx: 0, hy: -1 },
  { hx: 1, hy: -1 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 1 },
  { hx: 0, hy: 1 },
  { hx: -1, hy: 1 },
  { hx: -1, hy: 0 },
];

/** アイテムのローカル座標（中心原点）をキャンバス座標へ */
export function localToDoc(it: Item, l: Point): Point {
  const c = Math.cos(it.rotation * DEG);
  const s = Math.sin(it.rotation * DEG);
  return { x: it.cx + l.x * c - l.y * s, y: it.cy + l.x * s + l.y * c };
}

/** ハンドルの画面座標 */
export function handleScreenPoints(it: Item, view: View): Point[] {
  const { w, h } = itemSize(it);
  return HANDLE_DIRS.map((d) => view.docToScreen(localToDoc(it, { x: (d.hx * w) / 2, y: (d.hy * h) / 2 })));
}

/** 画面座標 p に近いハンドルの番号（なければ -1） */
export function hitHandle(points: Point[], p: Point, radius = 8): number {
  let best = -1;
  let bestD = radius;
  points.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** ハンドルの向きと回転角から、リサイズ用のカーソルを決める */
export function resizeCursor(hx: number, hy: number, rotation: number): string {
  const angle = (Math.atan2(hy, hx) / DEG + rotation + 360) % 180;
  const cursors = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
  return cursors[Math.round(angle / 45) % 4];
}
