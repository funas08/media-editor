// 選択・移動(V)
// クリック選択、Shift+クリック、範囲選択、ドラッグで移動（Shift で軸固定）、矢印キー、スナップ、整列・分布

import { itemBounds, normalizeRect, rectsIntersect, unionRects } from '../core/geometry';
import type { Point, Rect } from '../core/types';
import { alignItems, distributeItems, type AlignKind } from '../features/align';
import { deleteSelected, duplicateSelected, editableSelection, topItemAt } from '../features/commands';
import { collectSnapTargets, snapRect, snapSettings, type Guides, type SnapTargets } from '../features/snap';
import { ACCENT, drawLine, fillDocRect, strokeDocRect, strokeItem } from '../render/overlay';
import { button, checkbox, group, h, hint, iconButton, numberInput, row, text } from '../ui/controls';
import { icons } from '../ui/icons';
import { registerTool } from './registry';
import type { ToolHost } from './Tool';

/** ドラッグ開始とみなす移動量（画面 px） */
const DRAG_THRESHOLD = 3;
/** スナップする距離（画面 px） */
const SNAP_DISTANCE = 7;
const GUIDE_COLOR = '#ff3ea5';

type Drag =
  | {
      kind: 'move';
      startDoc: Point;
      startScreen: Point;
      ids: string[];
      orig: Map<string, Point>;
      origBox: Rect;
      targets: SnapTargets;
      started: boolean;
      /** クリックだけで終わったとき、このアイテムだけを選択し直す */
      collapseTo: string | null;
    }
  | { kind: 'marquee'; start: Point; cur: Point; base: string[] };

let drag: Drag | null = null;
let guides: Guides | null = null;
let hoverId: string | null = null;
let nudging = false;

/** 選択範囲（回転込みの外接矩形） */
function selectionBounds(host: ToolHost): Rect | null {
  return unionRects(editableSelection(host.editor).map(itemBounds));
}

function moveSelection(host: ToolHost, label: string, dx: number, dy: number): void {
  const ids = editableSelection(host.editor).map((it) => it.id);
  if (ids.length === 0 || (dx === 0 && dy === 0)) return;
  host.editor.update(label, (d) => {
    for (const it of d.items) {
      if (!ids.includes(it.id)) continue;
      it.cx += dx;
      it.cy += dy;
    }
  });
}

registerTool({
  id: 'select',
  name: '選択・移動',
  icon: icons.select,
  shortcut: 'V',
  order: 10,
  cursor: 'default',

  onPointerDown(e, host) {
    const { editor } = host;
    const hit = topItemAt(editor.doc.items, e.doc, false, (it) => host.isShown(it));
    if (!hit) {
      // 何もない所から範囲選択
      const base = e.shift ? [...editor.selection] : [];
      if (!e.shift) editor.setSelection([]);
      drag = { kind: 'marquee', start: e.doc, cur: e.doc, base };
      return;
    }
    const wasSelected = editor.isSelected(hit.id);
    if (e.shift) {
      if (wasSelected) {
        editor.setSelection(editor.selection.filter((id) => id !== hit.id));
        return;
      }
      editor.setSelection([...editor.selection, hit.id]);
    } else if (!wasSelected) {
      editor.setSelection([hit.id]);
    }
    const items = editableSelection(editor);
    drag = {
      kind: 'move',
      startDoc: e.doc,
      startScreen: e.screen,
      ids: items.map((it) => it.id),
      orig: new Map(items.map((it) => [it.id, { x: it.cx, y: it.cy }])),
      origBox: unionRects(items.map(itemBounds)) ?? { x: 0, y: 0, w: 0, h: 0 },
      targets: collectSnapTargets(
        editor.doc,
        items.map((it) => it.id),
      ),
      started: false,
      collapseTo: wasSelected && !e.shift && editor.selection.length > 1 ? hit.id : null,
    };
  },

  onPointerMove(e, host) {
    const { editor, view } = host;
    if (!drag) {
      const id = topItemAt(editor.doc.items, e.doc, false, (it) => host.isShown(it))?.id ?? null;
      if (id !== hoverId) {
        hoverId = id;
        host.requestRender();
      }
      return;
    }
    if (drag.kind === 'marquee') {
      drag.cur = e.doc;
      const r = normalizeRect(drag.start, drag.cur);
      const hits = editor.doc.items.filter((it) => it.visible && !it.locked && host.isShown(it) && rectsIntersect(itemBounds(it), r)).map((it) => it.id);
      editor.setSelection([...drag.base, ...hits]);
      return;
    }
    if (!drag.started) {
      if (Math.hypot(e.screen.x - drag.startScreen.x, e.screen.y - drag.startScreen.y) < DRAG_THRESHOLD) return;
      if (drag.ids.length === 0) return;
      drag.started = true;
      drag.collapseTo = null;
      editor.begin('移動');
    }
    let dx = e.doc.x - drag.startDoc.x;
    let dy = e.doc.y - drag.startDoc.y;
    // Shift で水平・垂直に固定
    let axis: 'both' | 'x' | 'y' = 'both';
    if (e.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) {
        dy = 0;
        axis = 'x';
      } else {
        dx = 0;
        axis = 'y';
      }
    }
    guides = null;
    // スナップ（Alt で一時無効）
    if (snapSettings.enabled && !e.alt) {
      const b = drag.origBox;
      const s = snapRect({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, drag.targets, SNAP_DISTANCE / view.zoom, axis);
      dx += s.dx;
      dy += s.dy;
      if (s.guides.xs.length || s.guides.ys.length) guides = s.guides;
    }
    const d0 = drag;
    editor.preview((d) => {
      for (const it of d.items) {
        const o = d0.orig.get(it.id);
        if (!o) continue;
        it.cx = o.x + dx;
        it.cy = o.y + dy;
      }
    });
  },

  onPointerUp(_e, host) {
    if (drag?.kind === 'move') {
      if (drag.started) host.editor.commit();
      else if (drag.collapseTo) host.editor.setSelection([drag.collapseTo]);
    }
    drag = null;
    guides = null;
    host.requestRender();
  },

  // 画像のダブルクリックでトリミングを開始
  onDoubleClick(e, host) {
    const hit = topItemAt(host.editor.doc.items, e.doc, false, (it) => host.isShown(it));
    if (!hit || hit.type !== 'image') return;
    host.editor.setSelection([hit.id]);
    host.setTool('crop', { target: 'image' });
  },

  deactivate(host) {
    if (drag?.kind === 'move' && drag.started) host.editor.commit();
    drag = null;
    guides = null;
    hoverId = null;
  },

  onKeyDown(e, host) {
    const { editor } = host;
    const step = e.shiftKey ? 10 : 1;
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const dir = dirs[e.key];
    if (!dir || e.ctrlKey || e.metaKey || e.altKey) return false;
    const ids = editableSelection(editor).map((it) => it.id);
    // 何も選択していないときは処理しない（動画モードでは1コマ移動に使う）
    if (ids.length === 0) return false;
    // 押し続けている間は1回分の履歴にまとめる（キーを離したら確定）
    if (!nudging) {
      editor.begin('移動（矢印キー）');
      nudging = true;
    }
    editor.preview((d) => {
      for (const it of d.items) {
        if (!ids.includes(it.id)) continue;
        it.cx += dir[0];
        it.cy += dir[1];
      }
    });
    return true;
  },

  onKeyUp(e, host) {
    if (nudging && e.key.startsWith('Arrow')) {
      nudging = false;
      host.editor.commit();
    }
  },

  drawOverlay(ctx, host) {
    const { editor, view } = host;
    // ホバー中の画像
    if (hoverId && !drag && !editor.isSelected(hoverId)) {
      const it = editor.doc.items.find((x) => x.id === hoverId);
      if (it) strokeItem(ctx, view, it, 'rgba(76,141,255,0.6)', 1);
    }
    // 複数選択のときは全体の枠
    if (editor.selection.length > 1) {
      const b = selectionBounds(host);
      if (b) strokeDocRect(ctx, view, b, ACCENT, 1, [4, 3]);
    }
    if (drag?.kind === 'marquee') {
      const r = normalizeRect(drag.start, drag.cur);
      fillDocRect(ctx, view, r, 'rgba(76,141,255,0.12)');
      strokeDocRect(ctx, view, r, ACCENT, 1);
    }
    if (guides) {
      const H = ctx.canvas.height;
      const W = ctx.canvas.width;
      for (const x of guides.xs) {
        const sx = view.docToScreen({ x, y: 0 }).x;
        drawLine(ctx, { x: sx, y: 0 }, { x: sx, y: H }, GUIDE_COLOR, 1);
      }
      for (const y of guides.ys) {
        const sy = view.docToScreen({ x: 0, y }).y;
        drawLine(ctx, { x: 0, y: sy }, { x: W, y: sy }, GUIDE_COLOR, 1);
      }
    }
  },

  createSettings(host) {
    const { editor } = host;
    const info = text('', 'value strong');
    const xIn = numberInput({
      value: 0,
      unit: 'px',
      digits: 1,
      onChange: (v) => {
        const b = selectionBounds(host);
        if (b) moveSelection(host, '位置', v - b.x, 0);
      },
    });
    const yIn = numberInput({
      value: 0,
      unit: 'px',
      digits: 1,
      onChange: (v) => {
        const b = selectionBounds(host);
        if (b) moveSelection(host, '位置', 0, v - b.y);
      },
    });
    const sizeText = text('', 'hint');

    const align = (kind: AlignKind) => {
      editor.update('整列', (d) => alignItems(d, editor.selection, kind));
    };
    const distribute = (axis: 'h' | 'v') => {
      if (editableSelection(editor).length < 3) {
        host.toast('等間隔に分布するには 3枚以上を選択してください');
        return;
      }
      editor.update('等間隔に分布', (d) => distributeItems(d, editor.selection, axis));
    };
    const alignRow = h(
      'div',
      { class: 'icon-grid' },
      iconButton(icons.alignLeft, '左揃え', () => align('left')),
      iconButton(icons.alignCenterH, '左右中央揃え', () => align('hcenter')),
      iconButton(icons.alignRight, '右揃え', () => align('right')),
      iconButton(icons.alignTop, '上揃え', () => align('top')),
      iconButton(icons.alignMiddle, '上下中央揃え', () => align('vcenter')),
      iconButton(icons.alignBottom, '下揃え', () => align('bottom')),
    );
    const alignHint = text('', 'hint');
    const snapCb = checkbox('スナップする', snapSettings.enabled, (v) => {
      snapSettings.enabled = v;
    });

    const el = h(
      'div',
      {},
      group('選択', info.el),
      group('位置（左上）', row('X', xIn.el), row('Y', yIn.el), sizeText.el),
      group('整列', alignRow, alignHint.el),
      group(
        '分布',
        h(
          'div',
          { class: 'btn-row' },
          button('横に等間隔', () => distribute('h'), { icon: icons.distH }),
          button('縦に等間隔', () => distribute('v'), { icon: icons.distV }),
        ),
      ),
      group('スナップ', snapCb.el, hint('キャンバスや他の画像の端・中央に吸着します。Alt を押している間は一時的に無効です。')),
      h(
        'div',
        { class: 'btn-row' },
        button('複製', () => duplicateSelected(editor), { icon: icons.copy, title: 'Ctrl+D' }),
        button('削除', () => deleteSelected(editor), { icon: icons.trash, danger: true, title: 'Delete' }),
      ),
      hint('ドラッグで移動（Shift で水平・垂直に固定）、何もない所からドラッグで範囲選択。矢印キーで 1px、Shift+矢印で 10px 移動します。'),
    );

    const update = () => {
      const n = editor.selection.length;
      info.set(n === 0 ? '選択なし' : `${n}枚を選択中（全${editor.doc.items.length}枚）`);
      const b = selectionBounds(host);
      xIn.input.disabled = yIn.input.disabled = !b;
      xIn.set(b ? b.x : 0);
      yIn.set(b ? b.y : 0);
      if (!b) xIn.input.value = yIn.input.value = '';
      sizeText.set(b ? `範囲：${Math.round(b.w)} × ${Math.round(b.h)} px` : '');
      alignHint.set(n <= 1 ? '1枚のときはキャンバスを基準に揃えます' : '複数のときは選択範囲を基準に揃えます');
      snapCb.set(snapSettings.enabled);
    };
    update();
    return { el, update };
  },
});
