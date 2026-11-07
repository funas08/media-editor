// 回転・反転(T)：回転ハンドル（Shift で 15° 刻み）、角度入力、90° 回転、左右・上下反転

import { DEG, itemBounds, itemSize, unionRects } from '../core/geometry';
import type { Item, Point } from '../core/types';
import { editableSelection } from '../features/commands';
import { flipEach, normalizeAngle, rotateEach, rotatePoint } from '../features/transform';
import { ACCENT, drawHandle, drawLabel, drawLine } from '../render/overlay';
import { button, group, h, hint, numberInput, row, text } from '../ui/controls';
import { icons } from '../ui/icons';
import { localToDoc, selectAt } from './common';
import { registerTool } from './registry';
import type { ToolHost } from './Tool';

/** 回転ハンドルを上辺からどれだけ離すか（画面 px） */
const HANDLE_OFFSET = 32;

interface RotateDrag {
  center: Point;
  startAngle: number;
  /** 1枚のときの元の角度（Shift の 15° 刻みの基準） */
  baseRotation: number;
  orig: Map<string, { cx: number; cy: number; rotation: number }>;
  last: Point;
  delta: number;
}

let drag: RotateDrag | null = null;

/** 回転の中心と、ハンドルの位置（画面座標） */
function handleInfo(host: ToolHost, items: Item[]): { center: Point; handle: Point; anchor: Point } | null {
  const { view } = host;
  if (items.length === 0) return null;
  if (items.length === 1) {
    const it = items[0];
    const { h } = itemSize(it);
    const topMid = view.docToScreen(localToDoc(it, { x: 0, y: -h / 2 }));
    const up = { x: Math.sin(it.rotation * DEG), y: -Math.cos(it.rotation * DEG) };
    return {
      center: { x: it.cx, y: it.cy },
      anchor: topMid,
      handle: { x: topMid.x + up.x * HANDLE_OFFSET, y: topMid.y + up.y * HANDLE_OFFSET },
    };
  }
  // 複数のときは全体の外接矩形の中心で回す
  const b = unionRects(items.map(itemBounds))!;
  const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const topMid = view.docToScreen({ x: center.x, y: b.y });
  return { center, anchor: topMid, handle: { x: topMid.x, y: topMid.y - HANDLE_OFFSET } };
}

function angleOf(p: Point, c: Point): number {
  return Math.atan2(p.y - c.y, p.x - c.x) / DEG;
}

registerTool({
  id: 'rotate',
  name: '回転・反転',
  icon: icons.rotate,
  shortcut: 'T',
  order: 40,
  cursor: 'default',

  onPointerDown(e, host) {
    const items = editableSelection(host.editor);
    const info = handleInfo(host, items);
    if (info && Math.hypot(e.screen.x - info.handle.x, e.screen.y - info.handle.y) <= 10) {
      drag = {
        center: info.center,
        startAngle: angleOf(e.doc, info.center),
        baseRotation: items.length === 1 ? items[0].rotation : 0,
        orig: new Map(items.map((it) => [it.id, { cx: it.cx, cy: it.cy, rotation: it.rotation }])),
        last: e.doc,
        delta: 0,
      };
      host.editor.begin('回転');
      return;
    }
    selectAt(e, host);
  },

  onPointerMove(e, host) {
    if (!drag) {
      const info = handleInfo(host, editableSelection(host.editor));
      const over = info && Math.hypot(e.screen.x - info.handle.x, e.screen.y - info.handle.y) <= 10;
      host.setCursor(over ? 'grab' : null);
      return;
    }
    host.setCursor('grabbing');
    let delta = angleOf(e.doc, drag.center) - drag.startAngle;
    // Shift で 15° 刻み（1枚なら絶対角度、複数なら回転量を刻む）
    if (e.shift) delta = Math.round((drag.baseRotation + delta) / 15) * 15 - drag.baseRotation;
    drag.delta = normalizeAngle(delta);
    drag.last = e.doc;
    const d0 = drag;
    host.editor.preview((d) => {
      for (const it of d.items) {
        const o = d0.orig.get(it.id);
        if (!o) continue;
        const p = rotatePoint({ x: o.cx, y: o.cy }, d0.center, delta);
        it.cx = p.x;
        it.cy = p.y;
        it.rotation = normalizeAngle(o.rotation + delta);
      }
    });
  },

  onPointerUp(_e, host) {
    if (drag) host.editor.commit();
    drag = null;
    host.setCursor(null);
  },

  deactivate(host) {
    if (drag) host.editor.commit();
    drag = null;
    host.setCursor(null);
  },

  drawOverlay(ctx, host) {
    const items = editableSelection(host.editor);
    const info = handleInfo(host, items);
    if (!info) return;
    drawLine(ctx, info.anchor, info.handle, ACCENT, 1.5);
    drawHandle(ctx, info.handle, 12, true);
    if (drag) {
      const s = host.view.docToScreen(drag.last);
      const text = items.length === 1 ? `${items[0].rotation.toFixed(1)}°` : `${drag.delta >= 0 ? '+' : ''}${drag.delta.toFixed(1)}°`;
      drawLabel(ctx, text, s.x + 14, s.y + 14);
    }
  },

  createSettings(host) {
    const { editor } = host;
    const ids = () => editableSelection(editor).map((it) => it.id);
    const info = text('', 'value strong');
    const angleIn = numberInput({
      value: 0,
      min: -360,
      max: 360,
      digits: 1,
      unit: '°',
      onChange: (v) =>
        editor.update('角度', (d) => {
          for (const it of d.items) if (ids().includes(it.id)) it.rotation = normalizeAngle(v);
        }),
    });
    const btns = [
      button('左に90°', () => editor.update('左に90°回転', (d) => rotateEach(d, ids(), -90)), { icon: icons.rotateLeft }),
      button('右に90°', () => editor.update('右に90°回転', (d) => rotateEach(d, ids(), 90)), { icon: icons.rotateRight }),
      button('左右反転', () => editor.update('左右反転', (d) => flipEach(d, ids(), 'x')), { icon: icons.flipH }),
      button('上下反転', () => editor.update('上下反転', (d) => flipEach(d, ids(), 'y')), { icon: icons.flipV }),
    ];
    const resetBtn = button('角度を 0° に戻す', () =>
      editor.update('角度リセット', (d) => {
        for (const it of d.items) if (ids().includes(it.id)) it.rotation = 0;
      }),
    );
    const flipState = text('', 'hint');

    const el = h(
      'div',
      {},
      group('対象', info.el),
      group('角度', row('角度', angleIn.el), resetBtn),
      group('90° 回転', h('div', { class: 'btn-row' }, btns[0], btns[1])),
      group('反転', h('div', { class: 'btn-row' }, btns[2], btns[3]), flipState.el),
      hint('キャンバス上では、画像の上にある丸いハンドルをドラッグして回転します（Shift で 15° 刻み）。'),
      hint('複数選択時：ハンドルでは全体をまとめて回転、ボタンと角度入力は1枚ずつ（それぞれの中心で）適用します。'),
    );

    const update = () => {
      const items = editableSelection(editor);
      const first = items[0];
      info.set(items.length === 0 ? '画像を選択してください' : items.length === 1 ? first.name : `${items.length}枚（数値は1枚目）`);
      for (const b of [...btns, resetBtn]) b.disabled = !first;
      angleIn.input.disabled = !first;
      if (!first) {
        angleIn.input.value = '';
        flipState.set('');
        return;
      }
      angleIn.set(first.rotation);
      const f = [first.flipX ? '左右' : '', first.flipY ? '上下' : ''].filter(Boolean).join('・');
      flipState.set(f ? `現在：${f}反転あり` : '現在：反転なし');
    };
    update();
    return { el, update };
  },
});
