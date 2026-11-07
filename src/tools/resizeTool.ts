// サイズ変更(R)：8方向のハンドル（角は縦横比固定、Shift で解除）、数値入力、等倍、キャンバスに収める／埋める

import { DEG, itemSize, toLocal } from '../core/geometry';
import type { Item, Point } from '../core/types';
import { editableSelection } from '../features/commands';
import { fitToCanvas } from '../features/transform';
import { drawHandle, drawLabel } from '../render/overlay';
import { button, checkbox, group, h, hint, numberInput, row, segmented, text } from '../ui/controls';
import { icons } from '../ui/icons';
import { HANDLE_DIRS, handleScreenPoints, hitHandle, resizeCursor, selectAt, singleEditable } from './common';
import { registerTool } from './registry';
import type { ToolHost } from './Tool';

interface ResizeDrag {
  orig: Item;
  hx: number;
  hy: number;
  w0: number;
  h0: number;
  last: Point;
}

let drag: ResizeDrag | null = null;
const st = { unit: 'px' as 'px' | '%', lockAspect: true };

/** ドラッグ位置から新しい中心と拡大率を計算 */
function computeResize(d: ResizeDrag, p: Point, free: boolean): { cx: number; cy: number; w: number; h: number } {
  const { orig: it, hx, hy, w0, h0 } = d;
  const l = toLocal(it, p);
  let left = -w0 / 2;
  let right = w0 / 2;
  let top = -h0 / 2;
  let bottom = h0 / 2;
  if (hx === 1) right = Math.max(l.x, left + 1);
  if (hx === -1) left = Math.min(l.x, right - 1);
  if (hy === 1) bottom = Math.max(l.y, top + 1);
  if (hy === -1) top = Math.min(l.y, bottom - 1);
  let w = right - left;
  let h = bottom - top;
  // 角のハンドルは縦横比を固定（Shift で解除）
  if (hx !== 0 && hy !== 0 && !free) {
    const s = Math.max(w / w0, h / h0);
    w = w0 * s;
    h = h0 * s;
    if (hx === 1) right = left + w;
    else left = right - w;
    if (hy === 1) bottom = top + h;
    else top = bottom - h;
  }
  const lx = (left + right) / 2;
  const ly = (top + bottom) / 2;
  const c = Math.cos(it.rotation * DEG);
  const s = Math.sin(it.rotation * DEG);
  return { cx: it.cx + lx * c - ly * s, cy: it.cy + lx * s + ly * c, w, h };
}

/** 数値入力で選択中の画像のサイズを変える（中心は固定） */
function setSize(host: ToolHost, dim: 'w' | 'h', value: number): void {
  const items = editableSelection(host.editor);
  if (items.length === 0) return;
  const ids = items.map((it) => it.id);
  host.editor.update('サイズ変更', (d) => {
    for (const it of d.items) {
      if (!ids.includes(it.id)) continue;
      const newScale = st.unit === '%' ? value / 100 : value / (dim === 'w' ? it.crop.w : it.crop.h);
      if (newScale <= 0) continue;
      if (dim === 'w') {
        const ratio = newScale / it.scaleX;
        it.scaleX = newScale;
        if (st.lockAspect) it.scaleY *= ratio;
      } else {
        const ratio = newScale / it.scaleY;
        it.scaleY = newScale;
        if (st.lockAspect) it.scaleX *= ratio;
      }
    }
  });
}

registerTool({
  id: 'resize',
  name: 'サイズ変更',
  icon: icons.resize,
  shortcut: 'R',
  order: 30,
  cursor: 'default',

  onPointerDown(e, host) {
    const it = singleEditable(host);
    if (it) {
      const idx = hitHandle(handleScreenPoints(it, host.view), e.screen);
      if (idx >= 0) {
        const { w, h } = itemSize(it);
        drag = { orig: structuredClone(it), hx: HANDLE_DIRS[idx].hx, hy: HANDLE_DIRS[idx].hy, w0: w, h0: h, last: e.doc };
        host.editor.begin('サイズ変更');
        return;
      }
    }
    selectAt(e, host);
  },

  onPointerMove(e, host) {
    const it = singleEditable(host);
    if (!drag) {
      // ハンドルの上ではリサイズ用のカーソル
      if (!it) return host.setCursor(null);
      const idx = hitHandle(handleScreenPoints(it, host.view), e.screen);
      host.setCursor(idx >= 0 ? resizeCursor(HANDLE_DIRS[idx].hx, HANDLE_DIRS[idx].hy, it.rotation) : null);
      return;
    }
    drag.last = e.doc;
    const r = computeResize(drag, e.doc, e.shift);
    const d0 = drag;
    host.editor.preview((d) => {
      const t = d.items.find((x) => x.id === d0.orig.id);
      if (!t) return;
      t.cx = r.cx;
      t.cy = r.cy;
      t.scaleX = r.w / t.crop.w;
      t.scaleY = r.h / t.crop.h;
    });
  },

  onPointerUp(_e, host) {
    if (drag) host.editor.commit();
    drag = null;
  },

  deactivate(host) {
    if (drag) host.editor.commit();
    drag = null;
    host.setCursor(null);
  },

  drawOverlay(ctx, host) {
    const it = singleEditable(host);
    if (!it) return;
    for (const p of handleScreenPoints(it, host.view)) drawHandle(ctx, p);
    if (drag) {
      const { w, h } = itemSize(it);
      const s = host.view.docToScreen(drag.last);
      drawLabel(ctx, `${Math.round(w)} × ${Math.round(h)}`, s.x + 14, s.y + 14);
    }
  },

  createSettings(host) {
    const { editor } = host;
    const info = text('', 'value strong');
    const unitSeg = segmented<'px' | '%'>(
      [
        { value: 'px', label: 'px' },
        { value: '%', label: '%' },
      ],
      st.unit,
      (v) => {
        st.unit = v;
        unitSeg.set(v);
        update();
      },
    );
    const wIn = numberInput({ value: 0, min: 0.01, digits: 1, onChange: (v) => setSize(host, 'w', v) });
    const hIn = numberInput({ value: 0, min: 0.01, digits: 1, onChange: (v) => setSize(host, 'h', v) });
    const lockCb = checkbox('縦横比を固定', st.lockAspect, (v) => {
      st.lockAspect = v;
    });
    const ids = () => editableSelection(editor).map((it) => it.id);
    const actualBtn = button(
      '等倍（100%）',
      () =>
        editor.update('等倍', (d) => {
          for (const it of d.items) {
            if (!ids().includes(it.id)) continue;
            it.scaleX = 1;
            it.scaleY = 1;
          }
        }),
      { title: '元画像のピクセル数どおりの大きさにする' },
    );
    const fitBtn = button('キャンバスに収める', () => editor.update('キャンバスに収める', (d) => fitToCanvas(d, ids(), 'fit')));
    const fillBtn = button('キャンバスを埋める', () => editor.update('キャンバスを埋める', (d) => fitToCanvas(d, ids(), 'fill')));

    const el = h(
      'div',
      {},
      group('対象', info.el),
      group('サイズ', unitSeg.el, row('幅', wIn.el), row('高さ', hIn.el), lockCb.el),
      group('まとめて変更', actualBtn, h('div', { class: 'btn-row' }, fitBtn, fillBtn)),
      hint('キャンバス上ではハンドルをドラッグして変更します。角は縦横比を固定（Shift で解除）、辺は片方向だけ伸縮します。'),
      hint('% は元画像（トリミング後）の大きさに対する割合です。'),
    );

    const update = () => {
      const items = editableSelection(editor);
      const first = items[0];
      info.set(items.length === 0 ? '画像を選択してください' : items.length === 1 ? first.name : `${items.length}枚（数値は1枚目）`);
      for (const b of [actualBtn, fitBtn, fillBtn]) b.disabled = items.length === 0;
      wIn.input.disabled = hIn.input.disabled = !first;
      if (!first) {
        wIn.input.value = hIn.input.value = '';
        return;
      }
      if (st.unit === '%') {
        wIn.set(first.scaleX * 100);
        hIn.set(first.scaleY * 100);
      } else {
        const s = itemSize(first);
        wIn.set(s.w);
        hIn.set(s.h);
      }
      lockCb.set(st.lockAspect);
    };
    update();
    return { el, update };
  },
});
