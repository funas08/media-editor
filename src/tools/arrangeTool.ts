// 並べる(G)：複数の画像をグリッド状に並べて1枚にする（このアプリの主目的）

import { cloneDoc } from '../core/doc';
import type { DocState } from '../core/types';
import {
  applyArrange,
  arrangeTargets,
  computeGrid,
  formatCellSize,
  sortForArrange,
  suggestGrid,
  typicalAspect,
  type ArrangeOptions,
  type ArrangeOrder,
  type FitMode,
} from '../features/arrange';
import { button, checkbox, group, h, hint, numberInput, row, segmented, selectInput, text } from '../ui/controls';
import { icons } from '../ui/icons';
import { drawLabel, strokeDocRect } from '../render/overlay';
import { registerTool } from './registry';
import type { ToolHost } from './Tool';

/** 設定（ツールを切り替えても保持） */
const st = {
  auto: true,
  rows: 2,
  cols: 2,
  gap: 0,
  margin: 0,
  mode: 'fit' as FitMode,
  order: 'layer' as ArrangeOrder,
};

/** 現在のドキュメント・選択・設定から配置計画を作る */
function plan(doc: DocState, selection: readonly string[]) {
  const { items, fromSelection } = arrangeTargets(doc, selection);
  let { rows, cols } = st;
  if (st.auto && items.length > 0) {
    ({ rows, cols } = suggestGrid(items.length, doc.canvas.width, doc.canvas.height, typicalAspect(items)));
  }
  const opts: ArrangeOptions = { rows, cols, gap: st.gap, margin: st.margin, mode: st.mode, order: st.order };
  const grid = computeGrid(doc.canvas.width, doc.canvas.height, rows, cols, st.gap, st.margin);
  return { items, fromSelection, opts, grid };
}

// プレビューのキャッシュ（同じ入力なら作り直さない）
let cacheKey = '';
let cacheDoc: DocState | null = null;
let cacheSrc: DocState | null = null;

function preview(doc: DocState, selection: readonly string[]): DocState | null {
  const p = plan(doc, selection);
  if (p.items.length === 0) return null;
  const key = JSON.stringify([selection, p.opts]);
  if (cacheSrc === doc && cacheKey === key) return cacheDoc;
  const out = cloneDoc(doc);
  applyArrange(
    out,
    p.items.map((it) => it.id),
    p.opts,
  );
  cacheSrc = doc;
  cacheKey = key;
  cacheDoc = out;
  return out;
}

function arrange(host: ToolHost): void {
  const { editor } = host;
  const p = plan(editor.doc, editor.selection);
  if (p.items.length === 0) {
    host.toast('並べる画像がありません');
    return;
  }
  if (p.grid.cellW <= 0 || p.grid.cellH <= 0) {
    host.toast('間隔・余白が大きすぎてセルを作れません');
    return;
  }
  let placed = 0;
  editor.update('並べる', (d) => {
    placed = applyArrange(
      d,
      p.items.map((it) => it.id),
      p.opts,
    );
  });
  host.toast(`${placed}枚を ${p.opts.rows}×${p.opts.cols} に配置しました`);
}

registerTool({
  id: 'arrange',
  name: '並べる',
  icon: icons.grid,
  shortcut: 'G',
  order: 60,
  cursor: 'default',

  getPreview(doc, host) {
    return preview(doc, host.editor.selection);
  },

  drawOverlay(ctx, host) {
    const { editor, view } = host;
    const doc = editor.doc;
    const p = plan(doc, editor.selection);
    if (p.items.length === 0 || p.grid.cellW <= 0 || p.grid.cellH <= 0) return;
    // セルの枠と並び順の番号
    const sorted = sortForArrange(p.items, st.order);
    p.grid.cells.forEach((cell, i) => {
      strokeDocRect(ctx, view, cell, 'rgba(76,141,255,0.9)', 1, [6, 4]);
      const s = view.docToScreen({ x: cell.x, y: cell.y });
      const name = sorted[i]?.name;
      drawLabel(ctx, name ? `${i + 1}. ${truncate(name, 28)}` : `${i + 1}.（空き）`, s.x + 6, s.y + 6, 'rgba(76,141,255,0.85)');
    });
    // 確定前であることの表示
    const pv = preview(doc, editor.selection);
    const pending = pv !== null && JSON.stringify(pv.items) !== JSON.stringify(doc.items);
    const o = view.docToScreen({ x: 0, y: 0 });
    drawLabel(
      ctx,
      pending ? 'プレビュー：「配置」ボタン（または Enter）で確定' : '配置済み',
      o.x,
      Math.max(4, o.y - 26),
      pending ? 'rgba(229,140,30,0.95)' : 'rgba(40,160,90,0.95)',
    );
  },

  onKeyDown(e, host) {
    if (e.key === 'Enter') {
      arrange(host);
      return true;
    }
    return false;
  },

  createSettings(host) {
    const { editor } = host;
    const refresh = () => {
      host.requestRender();
      host.refreshUI();
    };

    const target = text('', 'value strong');
    // 自動提案をやめるときは、いま表示している行・列を引き継ぐ
    const freeze = () => {
      const p = plan(editor.doc, editor.selection);
      st.rows = p.opts.rows;
      st.cols = p.opts.cols;
      st.auto = false;
    };
    const rowsIn = numberInput({
      value: st.rows,
      min: 1,
      max: 20,
      onChange: (v) => {
        freeze();
        st.rows = v;
        refresh();
      },
    });
    const colsIn = numberInput({
      value: st.cols,
      min: 1,
      max: 20,
      onChange: (v) => {
        freeze();
        st.cols = v;
        refresh();
      },
    });
    const autoCb = checkbox('枚数とキャンバスの縦横比から自動で決める', st.auto, (v) => {
      if (v) st.auto = true;
      else freeze();
      refresh();
    });
    const gapIn = numberInput({
      value: st.gap,
      min: 0,
      max: 4000,
      unit: 'px',
      onChange: (v) => {
        st.gap = v;
        refresh();
      },
    });
    const marginIn = numberInput({
      value: st.margin,
      min: 0,
      max: 4000,
      unit: 'px',
      onChange: (v) => {
        st.margin = v;
        refresh();
      },
    });
    const modeSeg = segmented<FitMode>(
      [
        { value: 'fit', label: '収める', title: '画像全体をセルに収める（余白ができることがある）' },
        { value: 'fill', label: '埋める', title: 'セルを埋める（はみ出した部分は中央を基準に切り抜く）' },
      ],
      st.mode,
      (v) => {
        st.mode = v;
        modeSeg.set(v);
        refresh();
      },
    );
    const modeHint = text('', 'hint');
    const orderSel = selectInput<ArrangeOrder>(
      [
        { value: 'layer', label: 'レイヤー順（下のレイヤー＝追加順から）' },
        { value: 'name', label: 'ファイル名順' },
      ],
      st.order,
      (v) => {
        st.order = v;
        refresh();
      },
    );
    const cellSize = text('', 'cell-size');
    const cellNote = text('', 'hint');
    const warn = text('', 'warn');
    const applyBtn = button('配置', () => arrange(host), { primary: true, icon: icons.grid, title: 'Enter' });
    applyBtn.classList.add('block');

    const el = h(
      'div',
      {},
      group('対象', target.el),
      group('グリッド', row('行', rowsIn.el), row('列', colsIn.el), autoCb.el),
      group('間隔・余白', row('間隔', gapIn.el), row('余白', marginIn.el)),
      group('配置方法', modeSeg.el, modeHint.el),
      group('並び順', orderSel.el),
      group('1セルのサイズ', cellSize.el, cellNote.el, warn.el),
      applyBtn,
      hint('配置すると回転は 0° に戻ります。キャンバス上の番号が並ぶ順番です。'),
    );

    const update = () => {
      const doc = editor.doc;
      const p = plan(doc, editor.selection);
      const n = p.items.length;
      target.set(n === 0 ? '画像がありません' : p.fromSelection ? `選択中の画像（${n}枚）` : `すべての画像（${n}枚）`);
      rowsIn.set(p.opts.rows);
      colsIn.set(p.opts.cols);
      autoCb.set(st.auto);
      modeSeg.set(st.mode);
      orderSel.set(st.order);
      modeHint.set(st.mode === 'fit' ? '画像全体をセルに収めます（縦横比が違うと余白ができます）' : 'セルを埋め、はみ出した部分は中央を基準に切り抜きます');
      const { cellW, cellH } = p.grid;
      if (cellW <= 0 || cellH <= 0) {
        cellSize.set('—');
        cellNote.set('');
        warn.set('間隔・余白が大きすぎます');
        applyBtn.disabled = true;
        return;
      }
      cellSize.set(`${formatCellSize(cellW, cellH)} px`);
      cellNote.set(
        `キャンバス ${doc.canvas.width}×${doc.canvas.height} を ${p.opts.rows}行×${p.opts.cols}列` +
          (Number.isInteger(cellW) && Number.isInteger(cellH) ? '' : '（端数あり）'),
      );
      const cells = p.opts.rows * p.opts.cols;
      warn.set(n > cells ? `セルが足りません：${n - cells}枚は配置されません` : '');
      applyBtn.disabled = n === 0;
    };
    update();
    return { el, update };
  },
});

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
