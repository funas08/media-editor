// 「並べる」の計算ロジック（UIに依存しない）

import { baseCrop, isImage } from '../core/doc';
import type { DocState, ImageItem, Rect } from '../core/types';

export type FitMode = 'fit' | 'fill';
export type ArrangeOrder = 'layer' | 'name';

export interface ArrangeOptions {
  rows: number;
  cols: number;
  /** セル同士の間隔（px） */
  gap: number;
  /** キャンバス外周の余白（px） */
  margin: number;
  /** fit = 収める（余白あり）、fill = 埋める（はみ出しを中央で切り抜き） */
  mode: FitMode;
  order: ArrangeOrder;
}

export interface GridLayout {
  cellW: number;
  cellH: number;
  cells: Rect[];
}

/** 各セルの位置と大きさを計算する */
export function computeGrid(canvasW: number, canvasH: number, rows: number, cols: number, gap: number, margin: number): GridLayout {
  const cellW = (canvasW - margin * 2 - gap * (cols - 1)) / cols;
  const cellH = (canvasH - margin * 2 - gap * (rows - 1)) / rows;
  const cells: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ x: margin + c * (cellW + gap), y: margin + r * (cellH + gap), w: cellW, h: cellH });
    }
  }
  return { cellW, cellH, cells };
}

/**
 * 枚数とキャンバスの縦横比から行・列を提案する。
 * セルの縦横比が画像の縦横比に近いこと、空きセルが少ないことを優先する。
 * 例：FHD 4枚 + WQHD → 2×2（1セル 1280×720）
 */
export function suggestGrid(n: number, canvasW: number, canvasH: number, imageAspect: number): { rows: number; cols: number } {
  if (n <= 1) return { rows: 1, cols: 1 };
  const landscape = canvasW >= canvasH;
  let best = { rows: 1, cols: n, score: Infinity };
  for (let rows = 1; rows <= n; rows++) {
    for (let cols = 1; cols <= n; cols++) {
      if (rows * cols < n) continue;
      // 丸ごと空く行・列ができる組み合わせは除外
      if ((rows - 1) * cols >= n || rows * (cols - 1) >= n) continue;
      const cellAspect = canvasW / cols / (canvasH / rows);
      const empty = rows * cols - n;
      const score = Math.abs(Math.log(cellAspect / imageAspect)) + empty * 0.35;
      const better =
        score < best.score - 1e-6 ||
        // 同点なら、横長キャンバスは列が多い方、縦長は行が多い方
        (Math.abs(score - best.score) <= 1e-6 && (landscape ? cols > rows : rows > cols));
      if (better) best = { rows, cols, score };
    }
  }
  return { rows: best.rows, cols: best.cols };
}

/** 対象画像の代表的な縦横比（中央値） */
export function typicalAspect(items: ImageItem[]): number {
  if (items.length === 0) return 16 / 9;
  const list = items.map((it) => {
    const c = baseCrop(it);
    return c.w / c.h;
  });
  list.sort((a, b) => a - b);
  return list[Math.floor(list.length / 2)];
}

/** 並べる対象：選択中の画像（表示中・ロックなし）。選択がなければ全部 */
export function arrangeTargets(doc: DocState, selection: readonly string[]): { items: ImageItem[]; fromSelection: boolean } {
  const all = doc.items.filter((it): it is ImageItem => isImage(it) && it.visible && !it.locked);
  const selected = all.filter((it) => selection.includes(it.id));
  return selected.length > 0 ? { items: selected, fromSelection: true } : { items: all, fromSelection: false };
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function sortForArrange(items: ImageItem[], order: ArrangeOrder): ImageItem[] {
  const list = [...items];
  if (order === 'name') list.sort((a, b) => collator.compare(a.name, b.name));
  // layer：配列順（下のレイヤー＝先に追加した画像から）
  return list;
}

/** 1枚の画像をセルに合わせる（draft を直接変更） */
export function fitItemToCell(it: ImageItem, cell: Rect, mode: FitMode): void {
  const base = baseCrop(it);
  let crop = base;
  let scale: number;
  if (mode === 'fit') {
    scale = Math.min(cell.w / base.w, cell.h / base.h);
  } else {
    // セルと同じ縦横比になるよう、ユーザー指定範囲の中央を切り抜く
    const cellAspect = cell.w / cell.h;
    if (base.w / base.h > cellAspect) {
      const w = base.h * cellAspect;
      crop = { x: base.x + (base.w - w) / 2, y: base.y, w, h: base.h };
    } else {
      const h = base.w / cellAspect;
      crop = { x: base.x, y: base.y + (base.h - h) / 2, w: base.w, h };
    }
    scale = cell.w / crop.w;
  }
  it.crop = crop;
  it.scaleX = scale;
  it.scaleY = scale;
  it.rotation = 0;
  it.cx = cell.x + cell.w / 2;
  it.cy = cell.y + cell.h / 2;
}

/**
 * 並べ替えを draft に適用する。
 * @returns 配置した枚数（セルが足りない分は動かさない）
 */
export function applyArrange(draft: DocState, targetIds: readonly string[], opts: ArrangeOptions): number {
  const targets = targetIds
    .map((id) => draft.items.find((it) => it.id === id))
    .filter((it): it is ImageItem => !!it && isImage(it));
  const sorted = sortForArrange(targets, opts.order);
  const grid = computeGrid(draft.canvas.width, draft.canvas.height, opts.rows, opts.cols, opts.gap, opts.margin);
  if (grid.cellW <= 0 || grid.cellH <= 0) return 0;
  const n = Math.min(sorted.length, grid.cells.length);
  for (let i = 0; i < n; i++) fitItemToCell(sorted[i], grid.cells[i], opts.mode);
  return n;
}

/** 1セルのサイズを「1280 × 720」のように表示用に整形 */
export function formatCellSize(w: number, h: number): string {
  const f = (v: number) => (Number.isInteger(Math.round(v * 10) / 10) ? String(Math.round(v)) : v.toFixed(1));
  return `${f(w)} × ${f(h)}`;
}
