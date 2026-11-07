// トリミング(C)
// 選択中の画像に切り抜き枠を表示。切り抜かれる部分も薄く表示し、切り抜かれる形（四角形・角丸・楕円）をプレビュー。
// 8方向ハンドルで範囲変更（Shift：縦横比固定、Alt：中心固定、Shift+Alt：両方）、枠の内側ドラッグで中身をずらす。
// 三分割線を表示。Enter / Esc で確定。範囲は元画像のピクセル座標で扱う（非破壊）。

import { DEFAULT_CROP_SHAPE } from '../core/doc';
import type { CropShape, CropShapeKind, ImageItem, Point, Rect } from '../core/types';
import { clampRect, docToSource, fitAspect, fullRect, isFullRect, maxCenteredRect, resizeCropRect, sourceToDoc, withCrop } from '../features/crop';
import { ACCENT, drawHandle, drawLabel, drawLine, drawSourceGhost, strokePolygon, strokeShape } from '../render/overlay';
import { button, group, h, hint, numberInput, row, segmented, selectInput, slider, text } from '../ui/controls';
import { icons } from '../ui/icons';
import { HANDLE_DIRS, hitHandle, resizeCursor, selectAt, singleEditable } from './common';
import { registerTool } from './registry';
import type { ToolHost } from './Tool';

type RatioId = 'free' | 'orig' | '1:1' | '4:3' | '3:2' | '16:9' | '9:16' | 'custom';

interface Session {
  id: string;
  /** 開始時のアイテムの状態（外から変更されたかの判定用） */
  baseJson: string;
  /** 元画像とキャンバスの対応の基準（中身をずらすと位置だけ変わる） */
  orig: ImageItem;
  /** 切り抜き範囲（元画像の座標） */
  rect: Rect;
  /** 切り抜きの形 */
  shape: CropShape;
}

type Drag = { kind: 'handle'; hx: number; hy: number; r0: Rect } | { kind: 'move'; start: Point; r0: Rect; orig0: ImageItem };

let session: Session | null = null;
let drag: Drag | null = null;
let unsubscribe: (() => void) | null = null;
/** 自分で確定した変更を、外からの変更（Undo など）と区別するためのフラグ */
let confirming = false;
/** 比率の設定（ツールを切り替えても保持） */
const st = { ratio: 'free' as RatioId, customW: 1, customH: 1 };

const RATIOS: Record<Exclude<RatioId, 'free' | 'orig' | 'custom'>, number> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

/** 表示上の縦横比を、元画像の座標での縦横比に直す（縦横の拡大率が違う画像のため） */
function toSourceAspect(displayAspect: number, it: ImageItem): number {
  return (displayAspect * it.scaleY) / it.scaleX;
}

/** 設定中の比率（元画像の座標での 幅/高さ）。自由なら null */
function aspectValue(s: Session): number | null {
  switch (st.ratio) {
    case 'free':
      return null;
    case 'orig':
      return s.orig.srcWidth / s.orig.srcHeight;
    case 'custom':
      return st.customW > 0 && st.customH > 0 ? toSourceAspect(st.customW / st.customH, s.orig) : null;
    default:
      return toSourceAspect(RATIOS[st.ratio], s.orig);
  }
}

function applyRatio(): void {
  if (!session) return;
  const a = aspectValue(session);
  if (a) session.rect = fitAspect(session.rect, a, session.orig.srcWidth, session.orig.srcHeight);
}

function start(host: ToolHost): void {
  const it = singleEditable(host);
  if (!it || it.type !== 'image') {
    session = null;
    return;
  }
  session = {
    id: it.id,
    baseJson: JSON.stringify(it),
    orig: structuredClone(it),
    rect: { ...it.crop },
    shape: { ...(it.cropShape ?? DEFAULT_CROP_SHAPE) },
  };
  applyRatio();
  host.requestRender();
}

/** 確定して履歴に残す */
function confirm(host: ToolHost): void {
  const s = session;
  if (!s) return;
  session = null;
  drag = null;
  const result = withCrop(s.orig, s.rect);
  const full = isFullRect(s.orig, s.rect);
  confirming = true;
  host.editor.update('トリミング', (d) => {
    const it = d.items.find((x) => x.id === s.id);
    if (!it || it.type !== 'image') return;
    it.crop = { ...s.rect };
    it.userCrop = full ? null : { ...s.rect };
    it.cropShape = { ...s.shape };
    it.cx = result.cx;
    it.cy = result.cy;
  });
  confirming = false;
}

function cancel(host: ToolHost): void {
  session = null;
  drag = null;
  host.requestRender();
}

/** 枠の四隅（画面座標） */
function frameScreen(host: ToolHost, s: Session): Point[] {
  const r = s.rect;
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ].map(([u, v]) => host.view.docToScreen(sourceToDoc(s.orig, u, v)));
}

function handlesScreen(host: ToolHost, s: Session): Point[] {
  const r = s.rect;
  return HANDLE_DIRS.map((d) => host.view.docToScreen(sourceToDoc(s.orig, r.x + ((d.hx + 1) / 2) * r.w, r.y + ((d.hy + 1) / 2) * r.h)));
}

function insideRect(s: Session, p: Point): boolean {
  const q = docToSource(s.orig, p);
  const r = s.rect;
  return q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;
}

/** ハンドルのカーソル（元画像の向きを画面の向きに直して判定） */
function cursorFor(s: Session, hx: number, hy: number): string {
  const o = s.orig;
  return resizeCursor(o.flipX ? -hx : hx, o.flipY ? -hy : hy, o.rotation);
}

registerTool({
  id: 'crop',
  name: 'トリミング',
  icon: icons.crop,
  shortcut: 'C',
  order: 20,
  cursor: 'default',

  activate(host) {
    start(host);
    // 選択が変わったら対象を切り替え、Undo などで対象の画像が外から変わったら作り直す
    unsubscribe = host.editor.changed.on((ev) => {
      if (confirming) return;
      if (ev.history && session) {
        const s = session;
        const cur = host.editor.doc.items.find((x) => x.id === s.id);
        if (!cur || JSON.stringify(cur) !== s.baseJson) {
          session = null;
          start(host);
          return;
        }
      }
      if (ev.selection) {
        if (session && !host.editor.selection.includes(session.id)) confirm(host);
        if (!session) start(host);
      }
    });
  },

  deactivate(host) {
    unsubscribe?.();
    unsubscribe = null;
    confirm(host);
    host.setCursor(null);
  },

  getPreview(doc) {
    const s = session;
    if (!s) return null;
    if (!doc.items.some((it) => it.id === s.id)) {
      session = null;
      return null;
    }
    const preview: ImageItem = { ...withCrop(s.orig, s.rect), cropShape: { ...s.shape } };
    return { ...doc, items: doc.items.map((it) => (it.id === s.id ? preview : it)) };
  },

  onPointerDown(e, host) {
    const s = session;
    if (s) {
      const idx = hitHandle(handlesScreen(host, s), e.screen);
      if (idx >= 0) {
        drag = { kind: 'handle', hx: HANDLE_DIRS[idx].hx, hy: HANDLE_DIRS[idx].hy, r0: { ...s.rect } };
        return;
      }
      if (insideRect(s, e.doc)) {
        drag = { kind: 'move', start: e.doc, r0: { ...s.rect }, orig0: structuredClone(s.orig) };
        return;
      }
      // 枠の外をクリック：確定してから、クリックした画像を選ぶ（選択の変化で新しい枠が始まる）
      confirm(host);
    }
    selectAt(e, host);
    if (!session) start(host);
  },

  onPointerMove(e, host) {
    const s = session;
    if (!s) return;
    if (!drag) {
      const idx = hitHandle(handlesScreen(host, s), e.screen);
      if (idx >= 0) host.setCursor(cursorFor(s, HANDLE_DIRS[idx].hx, HANDLE_DIRS[idx].hy));
      else host.setCursor(insideRect(s, e.doc) ? 'move' : null);
      return;
    }
    const W = s.orig.srcWidth;
    const H = s.orig.srcHeight;
    if (drag.kind === 'handle') {
      const q = docToSource(s.orig, e.doc);
      // Shift：縦横比を固定（自由のときは 1:1）／ Alt：中心を固定
      const aspect = aspectValue(s) ?? (e.shift ? toSourceAspect(1, s.orig) : null);
      s.rect = resizeCropRect(drag.r0, drag.hx, drag.hy, q.x, q.y, { aspect, fromCenter: e.alt }, W, H);
    } else {
      // 中身をずらす：枠は画面上で止めたまま、画像をポインターに合わせて動かす
      const o0 = drag.orig0;
      const a = docToSource(o0, drag.start);
      const b = docToSource(o0, e.doc);
      const r = clampRect({ ...drag.r0, x: drag.r0.x - (b.x - a.x), y: drag.r0.y - (b.y - a.y) }, W, H);
      const du = { x: drag.r0.x - r.x, y: drag.r0.y - r.y };
      const p0 = sourceToDoc(o0, 0, 0);
      const p1 = sourceToDoc(o0, du.x, du.y);
      s.rect = r;
      s.orig = { ...o0, cx: o0.cx + (p1.x - p0.x), cy: o0.cy + (p1.y - p0.y) };
    }
    host.requestRender();
    host.refreshUI();
  },

  onPointerUp() {
    drag = null;
  },

  onDoubleClick(e, host) {
    // 枠の外の画像をダブルクリックしたら、その画像のトリミングを始める
    if (session && insideRect(session, e.doc)) return;
    selectAt(e, host);
  },

  onKeyDown(e, host) {
    if (!session) return false;
    if (e.key === 'Enter' || e.key === 'Escape') {
      confirm(host);
      host.toast('トリミングを確定しました');
      return true;
    }
    // トリミング中の Ctrl+Z は、確定前の変更を取り消す
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
      cancel(host);
      host.toast('トリミングを取り消しました');
      return true;
    }
    return false;
  },

  drawOverlay(ctx, host) {
    const s = session;
    if (!s) return;
    const asset = host.editor.assets.get(s.orig.assetId);
    if (asset) drawSourceGhost(ctx, host.view, s.orig, asset.bitmap, s.rect, s.shape);
    const pts = frameScreen(host, s);
    // 外接する四角形（ハンドルの枠）
    strokePolygon(ctx, pts, '#ffffff', 1.5);
    strokePolygon(ctx, pts, ACCENT, 1, [5, 4]);
    // 切り抜かれる形
    if (s.shape.kind !== 'rect') {
      const c = host.view.docToScreen(sourceToDoc(s.orig, s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2));
      const z = host.view.zoom;
      const w = s.rect.w * s.orig.scaleX * z;
      const hh = s.rect.h * s.orig.scaleY * z;
      strokeShape(ctx, s.shape, c, w, hh, s.orig.rotation, '#ffffff', 2);
      strokeShape(ctx, s.shape, c, w, hh, s.orig.rotation, ACCENT, 1);
    }
    // 三分割線
    const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    for (const t of [1 / 3, 2 / 3]) {
      drawLine(ctx, lerp(pts[0], pts[1], t), lerp(pts[3], pts[2], t), 'rgba(255,255,255,0.55)', 1);
      drawLine(ctx, lerp(pts[0], pts[3], t), lerp(pts[1], pts[2], t), 'rgba(255,255,255,0.55)', 1);
    }
    for (const p of handlesScreen(host, s)) drawHandle(ctx, p);
    const br = pts.reduce((a, b) => (a.x + a.y > b.x + b.y ? a : b));
    drawLabel(ctx, `${Math.round(s.rect.w)} × ${Math.round(s.rect.h)}`, br.x + 8, br.y + 8);
  },

  createSettings(host) {
    const info = text('', 'value strong');

    // 形
    const shapeSeg = segmented<CropShapeKind>(
      [
        { value: 'rect', label: '四角形' },
        { value: 'roundRect', label: '角丸' },
        { value: 'ellipse', label: '楕円' },
      ],
      'rect',
      (v) => {
        if (!session) return;
        session.shape.kind = v;
        refresh();
      },
    );
    const radius = slider({
      label: '角の半径',
      min: 0,
      max: 50,
      value: DEFAULT_CROP_SHAPE.radius * 100,
      defaultValue: DEFAULT_CROP_SHAPE.radius * 100,
      unit: '%',
      onInput: (v) => {
        if (!session) return;
        session.shape.radius = v / 100;
        host.requestRender();
      },
      onChange: () => {},
    });
    const radiusWrap = h('div', {}, radius.el);

    // 比率
    const ratioSel = selectInput<RatioId>(
      [
        { value: 'free', label: '自由' },
        { value: 'orig', label: '元の比率' },
        { value: '1:1', label: '1:1（正方形）' },
        { value: '4:3', label: '4:3' },
        { value: '3:2', label: '3:2' },
        { value: '16:9', label: '16:9' },
        { value: '9:16', label: '9:16（縦長）' },
        { value: 'custom', label: '数値で指定' },
      ],
      st.ratio,
      (v) => {
        st.ratio = v;
        applyRatio();
        refresh();
      },
    );
    const customW = numberInput({
      value: st.customW,
      min: 0.01,
      digits: 2,
      onChange: (v) => {
        st.customW = v;
        applyRatio();
        refresh();
      },
    });
    const customH = numberInput({
      value: st.customH,
      min: 0.01,
      digits: 2,
      onChange: (v) => {
        st.customH = v;
        applyRatio();
        refresh();
      },
    });
    const customRow = h('div', { class: 'ratio-row' }, customW.el, h('span', { class: 'unit' }, '：'), customH.el);

    // プリセット：形と比率を設定し、画像の中央に最大サイズで配置
    const preset = (kind: CropShapeKind) => {
      const s = session;
      if (!s) return;
      s.shape.kind = kind;
      st.ratio = '1:1';
      s.rect = maxCenteredRect(s.orig.srcWidth, s.orig.srcHeight, toSourceAspect(1, s.orig));
      refresh();
    };
    const squareBtn = button('正方形', () => preset('rect'), { title: '四角形・1:1 で画像の中央に最大サイズ' });
    const circleBtn = button('正円', () => preset('ellipse'), { title: '楕円・1:1 で画像の中央に最大サイズ' });

    // 範囲の数値入力
    const setRect = (patch: Partial<Rect>, keep: 'w' | 'h' | null) => {
      const s = session;
      if (!s) return;
      const r = { ...s.rect, ...patch };
      const a = aspectValue(s);
      if (a && keep === 'w') r.h = r.w / a;
      if (a && keep === 'h') r.w = r.h * a;
      s.rect = clampRect(r, s.orig.srcWidth, s.orig.srcHeight);
      refresh();
    };
    const xIn = numberInput({ value: 0, min: 0, unit: 'px', onChange: (v) => setRect({ x: v }, null) });
    const yIn = numberInput({ value: 0, min: 0, unit: 'px', onChange: (v) => setRect({ y: v }, null) });
    const wIn = numberInput({ value: 0, min: 1, unit: 'px', onChange: (v) => setRect({ w: v }, 'w') });
    const hIn = numberInput({ value: 0, min: 1, unit: 'px', onChange: (v) => setRect({ h: v }, 'h') });

    const okBtn = button('確定', () => confirm(host), { primary: true, title: 'Enter / Esc' });
    okBtn.classList.add('block');
    const resetBtn = button('トリミング解除', () => {
      if (!session) return;
      session.rect = fullRect(session.orig);
      session.shape = { ...DEFAULT_CROP_SHAPE };
      confirm(host);
      host.toast('トリミングを解除しました');
    });
    const cancelBtn = button('キャンセル', () => cancel(host), { title: '確定前の変更を取り消す（Ctrl+Z）' });

    const el = h(
      'div',
      {},
      group('対象', info.el),
      group('形', shapeSeg.el, radiusWrap),
      group('比率', ratioSel.el, customRow),
      group('プリセット', h('div', { class: 'btn-row' }, squareBtn, circleBtn)),
      group('範囲（元画像のピクセル）', row('X', xIn.el), row('Y', yIn.el), row('幅', wIn.el), row('高さ', hIn.el)),
      okBtn,
      h('div', { class: 'btn-row' }, resetBtn, cancelBtn),
      hint('ハンドルで範囲を変更、枠の内側をドラッグすると中身をずらせます。Enter / Esc で確定します。'),
      hint('Shift＋ハンドル：縦横比を固定（自由のときは 1:1）／ Alt＋ハンドル：中心を固定 ／ Shift＋Alt：両方'),
      hint('選択・移動ツールで画像をダブルクリックしても開始できます。元画像は残るので、いつでも解除できます。'),
    );

    const update = () => {
      const s = session;
      const target = s ? host.editor.doc.items.find((x) => x.id === s.id) : null;
      info.set(s && target ? `${target.name}（元 ${s.orig.srcWidth}×${s.orig.srcHeight}）` : '画像を1枚クリックしてください');
      const inputs = [xIn, yIn, wIn, hIn];
      for (const inp of inputs) inp.input.disabled = !s;
      for (const b of [okBtn, resetBtn, cancelBtn, squareBtn, circleBtn]) b.disabled = !s;
      radius.setDisabled(!s);
      shapeSeg.set(s ? s.shape.kind : 'rect');
      radiusWrap.hidden = !s || s.shape.kind !== 'roundRect';
      if (s) radius.set(Math.round(s.shape.radius * 100));
      ratioSel.set(st.ratio);
      customRow.hidden = st.ratio !== 'custom';
      customW.set(st.customW);
      customH.set(st.customH);
      if (!s) {
        for (const inp of inputs) inp.input.value = '';
        return;
      }
      xIn.set(s.rect.x);
      yIn.set(s.rect.y);
      wIn.set(s.rect.w);
      hIn.set(s.rect.h);
    };
    const refresh = () => {
      host.requestRender();
      update();
    };
    update();
    return { el, update };
  },
});
