// トリミング(C)
// 対象は「キャンバス」（既定）と「選択中の画像」。枠の操作・形・比率・プリセット・修飾キーは共通。
//
// - 画像：範囲は元画像のピクセル座標。枠の内側ドラッグで中身をずらす。元画像の外には広げられない
// - キャンバス：範囲はキャンバス座標。枠の内側ドラッグで枠が動く。キャンバスの外まで広げられる（背景色になる）。
//   確定するとキャンバスのサイズが枠の大きさになり、全画像が枠に合わせてずれる。角丸・楕円はキャンバスの形として保存
//
// 共通：8方向ハンドル（Shift：縦横比固定（自由なら 1:1）、Alt：中心固定、Shift+Alt：両方）、三分割線、Enter / Esc で確定

import { DEFAULT_CROP_SHAPE } from '../core/doc';
import type { CropShape, CropShapeKind, ImageItem, Point, Rect } from '../core/types';
import {
  applyCanvasCrop,
  clampRect,
  clampRectTo,
  docToSource,
  fitAspectTo,
  fullRect,
  isFullRect,
  maxCenteredRect,
  resizeCropRect,
  sourceToDoc,
  withCrop,
  type CropBounds,
} from '../features/crop';
import { ACCENT, drawHandle, drawLabel, drawLine, drawSourceGhost, strokePolygon, strokeShape } from '../render/overlay';
import { addShapePath } from '../render/shapes';
import { button, group, h, hint, numberInput, row, segmented, selectInput, slider, text } from '../ui/controls';
import { icons } from '../ui/icons';
import { HANDLE_DIRS, hitHandle, resizeCursor, selectAt, singleEditable } from './common';
import { registerTool } from './registry';
import type { ToolHost } from './Tool';

type Target = 'canvas' | 'image';
type RatioId = 'free' | 'orig' | '1:1' | '4:3' | '3:2' | '16:9' | '9:16' | 'custom';

interface ImageSession {
  kind: 'image';
  id: string;
  /** 開始時のアイテムの状態（外から変更されたかの判定用） */
  baseJson: string;
  /** 元画像とキャンバスの対応の基準（中身をずらすと位置だけ変わる） */
  orig: ImageItem;
  /** 切り抜き範囲（元画像の座標） */
  rect: Rect;
  shape: CropShape;
}

interface CanvasSession {
  kind: 'canvas';
  /** 開始時のキャンバスの状態（外から変更されたかの判定用） */
  baseJson: string;
  /** 枠（キャンバス座標。キャンバスの外にはみ出してもよい） */
  rect: Rect;
  shape: CropShape;
}

type Session = ImageSession | CanvasSession;

type Drag =
  | { kind: 'handle'; hx: number; hy: number; r0: Rect }
  | { kind: 'moveContent'; start: Point; r0: Rect; orig0: ImageItem }
  | { kind: 'moveFrame'; start: Point; r0: Rect };

let session: Session | null = null;
let drag: Drag | null = null;
let unsubscribe: (() => void) | null = null;
/** 自分で確定した変更を、外からの変更（Undo など）と区別するためのフラグ */
let confirming = false;
/** 設定（比率はツールを切り替えても保持。対象はツールを開くたびに決まる） */
const st = { target: 'canvas' as Target, ratio: 'free' as RatioId, customW: 1, customH: 1 };

const RATIOS: Record<Exclude<RatioId, 'free' | 'orig' | 'custom'>, number> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

// ===== 対象ごとの違いをまとめた小さな関数 =====

/** 枠の座標 → キャンバス座標 */
function toDoc(s: Session, u: number, v: number): Point {
  return s.kind === 'image' ? sourceToDoc(s.orig, u, v) : { x: u, y: v };
}

/** キャンバス座標 → 枠の座標 */
function fromDoc(s: Session, p: Point): Point {
  return s.kind === 'image' ? docToSource(s.orig, p) : p;
}

/** 範囲の制限（画像は元画像の中だけ、キャンバスは制限なし） */
function boundsOf(s: Session): CropBounds {
  return s.kind === 'image' ? { W: s.orig.srcWidth, H: s.orig.srcHeight } : null;
}

/** 枠の 1px がキャンバス上で何 px か */
function scaleOf(s: Session): { x: number; y: number } {
  return s.kind === 'image' ? { x: s.orig.scaleX, y: s.orig.scaleY } : { x: 1, y: 1 };
}

/** 表示上の縦横比を、枠の座標での縦横比に直す（縦横の拡大率が違う画像のため） */
function toFrameAspect(displayAspect: number, s: Session): number {
  const k = scaleOf(s);
  return (displayAspect * k.y) / k.x;
}

/** 設定中の比率（枠の座標での 幅/高さ）。自由なら null */
function aspectValue(s: Session, host: ToolHost): number | null {
  switch (st.ratio) {
    case 'free':
      return null;
    case 'orig':
      return s.kind === 'image' ? s.orig.srcWidth / s.orig.srcHeight : host.editor.doc.canvas.width / host.editor.doc.canvas.height;
    case 'custom':
      return st.customW > 0 && st.customH > 0 ? toFrameAspect(st.customW / st.customH, s) : null;
    default:
      return toFrameAspect(RATIOS[st.ratio], s);
  }
}

function applyRatio(host: ToolHost): void {
  if (!session) return;
  const a = aspectValue(session, host);
  if (a) session.rect = fitAspectTo(session.rect, a, boundsOf(session));
}

// ===== 開始・確定・取り消し =====

function start(host: ToolHost): void {
  const { editor } = host;
  if (st.target === 'canvas') {
    const c = editor.doc.canvas;
    session = { kind: 'canvas', baseJson: JSON.stringify(c), rect: { x: 0, y: 0, w: c.width, h: c.height }, shape: { ...c.shape } };
  } else {
    const it = singleEditable(host);
    session =
      it && it.type === 'image'
        ? { kind: 'image', id: it.id, baseJson: JSON.stringify(it), orig: structuredClone(it), rect: { ...it.crop }, shape: { ...it.cropShape } }
        : null;
  }
  applyRatio(host);
  host.requestRender();
}

/** 外から変更されていたら作り直す（Undo など） */
function isStale(host: ToolHost, s: Session): boolean {
  if (s.kind === 'canvas') return JSON.stringify(host.editor.doc.canvas) !== s.baseJson;
  const cur = host.editor.doc.items.find((x) => x.id === s.id);
  return !cur || JSON.stringify(cur) !== s.baseJson;
}

/** 確定して履歴に残す（1回分） */
function confirm(host: ToolHost): void {
  const s = session;
  if (!s) return;
  session = null;
  drag = null;
  confirming = true;
  if (s.kind === 'image') {
    const result = withCrop(s.orig, s.rect);
    const full = isFullRect(s.orig, s.rect);
    host.editor.update('トリミング', (d) => {
      const it = d.items.find((x) => x.id === s.id);
      if (!it || it.type !== 'image') return;
      it.crop = { ...s.rect };
      it.userCrop = full ? null : { ...s.rect };
      it.cropShape = { ...s.shape };
      it.cx = result.cx;
      it.cy = result.cy;
    });
  } else {
    host.editor.update('キャンバスのトリミング', (d) => applyCanvasCrop(d, s.rect, s.shape));
  }
  confirming = false;
}

function cancel(host: ToolHost): void {
  session = null;
  drag = null;
  host.requestRender();
}

/** 対象を切り替える（今の枠は確定してから） */
function setTarget(host: ToolHost, t: Target): void {
  if (st.target === t && session) return;
  confirm(host);
  st.target = t;
  start(host);
  host.refreshUI();
}

// ===== 画面座標での枠 =====

function frameScreen(host: ToolHost, s: Session): Point[] {
  const r = s.rect;
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ].map(([u, v]) => host.view.docToScreen(toDoc(s, u, v)));
}

function handlesScreen(host: ToolHost, s: Session): Point[] {
  const r = s.rect;
  return HANDLE_DIRS.map((d) => host.view.docToScreen(toDoc(s, r.x + ((d.hx + 1) / 2) * r.w, r.y + ((d.hy + 1) / 2) * r.h)));
}

function insideRect(s: Session, p: Point): boolean {
  const q = fromDoc(s, p);
  const r = s.rect;
  return q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;
}

function cursorFor(s: Session, hx: number, hy: number): string {
  if (s.kind === 'canvas') return resizeCursor(hx, hy, 0);
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

  activate(host, opts) {
    // ツールを選んだときはキャンバス。選択・移動ツールのダブルクリックから来たときは画像
    st.target = opts?.target === 'image' ? 'image' : 'canvas';
    start(host);
    unsubscribe = host.editor.changed.on((ev) => {
      if (confirming) return;
      if (ev.history && session && isStale(host, session)) {
        session = null;
        start(host);
        return;
      }
      // 画像が対象のときだけ、選択の変化で対象の画像を切り替える
      if (ev.selection && st.target === 'image') {
        if (session?.kind === 'image' && !host.editor.selection.includes(session.id)) confirm(host);
        if (!session) start(host);
      }
      if (!session && st.target === 'canvas') start(host);
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
    if (!s || s.kind !== 'image') return null;
    if (!doc.items.some((it) => it.id === s.id)) {
      session = null;
      return null;
    }
    const preview: ImageItem = { ...withCrop(s.orig, s.rect), cropShape: { ...s.shape } };
    return { ...doc, items: doc.items.map((it) => (it.id === s.id ? preview : it)) };
  },

  getCanvasArea() {
    const s = session;
    return s && s.kind === 'canvas' ? { ...s.rect, shape: s.shape } : null;
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
        drag =
          s.kind === 'image'
            ? { kind: 'moveContent', start: e.doc, r0: { ...s.rect }, orig0: structuredClone(s.orig) }
            : { kind: 'moveFrame', start: e.doc, r0: { ...s.rect } };
        return;
      }
      if (s.kind === 'canvas') return;
      // 画像が対象で枠の外をクリック：確定してから、クリックした画像を選ぶ
      confirm(host);
    }
    if (st.target === 'image') {
      selectAt(e, host);
      if (!session) start(host);
    }
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
    const bounds = boundsOf(s);
    if (drag.kind === 'handle') {
      const q = fromDoc(s, e.doc);
      // Shift：縦横比を固定（自由のときは 1:1）／ Alt：中心を固定
      const aspect = aspectValue(s, host) ?? (e.shift ? toFrameAspect(1, s) : null);
      s.rect = resizeCropRect(drag.r0, drag.hx, drag.hy, q.x, q.y, { aspect, fromCenter: e.alt, unbounded: !bounds }, bounds?.W ?? 0, bounds?.H ?? 0);
    } else if (drag.kind === 'moveFrame') {
      // 枠そのものを動かす（キャンバス）
      s.rect = { ...drag.r0, x: Math.round(drag.r0.x + e.doc.x - drag.start.x), y: Math.round(drag.r0.y + e.doc.y - drag.start.y) };
    } else if (s.kind === 'image') {
      // 中身をずらす（画像）：枠は画面上で止めたまま、画像をポインターに合わせて動かす
      const o0 = drag.orig0;
      const a = docToSource(o0, drag.start);
      const b = docToSource(o0, e.doc);
      const r = clampRect({ ...drag.r0, x: drag.r0.x - (b.x - a.x), y: drag.r0.y - (b.y - a.y) }, o0.srcWidth, o0.srcHeight);
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
    const s = session;
    if (s && insideRect(s, e.doc) && s.kind === 'image') return;
    // キャンバスが対象のときに画像をダブルクリック → その画像のトリミングに切り替え
    if (st.target === 'canvas') {
      const hit = host.editor.doc.items.slice().reverse().find((it) => it.visible && !it.locked && it.type === 'image' && insideItem(it, e.doc));
      if (!hit) return;
      confirm(host);
      host.editor.setSelection([hit.id]);
      setTarget(host, 'image');
      return;
    }
    selectAt(e, host);
  },

  onKeyDown(e, host) {
    if (!session) return false;
    if (e.key === 'Enter' || e.key === 'Escape') {
      const kind = session.kind;
      confirm(host);
      if (kind === 'canvas') start(host);
      host.toast(kind === 'canvas' ? 'キャンバスをトリミングしました' : 'トリミングを確定しました');
      return true;
    }
    // トリミング中の Ctrl+Z は、確定前の変更を取り消す（確定前の変更がなければ通常の元に戻す）
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey && hasPendingChange(host)) {
      cancel(host);
      start(host);
      host.toast('トリミングの変更を取り消しました');
      return true;
    }
    return false;
  },

  drawOverlay(ctx, host) {
    const s = session;
    if (!s) return;
    const { view } = host;
    if (s.kind === 'image') {
      const asset = host.editor.assets.get(s.orig.assetId);
      if (asset) drawSourceGhost(ctx, view, s.orig, asset.bitmap, s.rect, s.shape);
    }
    const k = scaleOf(s);
    const rot = s.kind === 'image' ? s.orig.rotation : 0;
    const c = view.docToScreen(toDoc(s, s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2));
    const w = s.rect.w * k.x * view.zoom;
    const hh = s.rect.h * k.y * view.zoom;
    if (s.kind === 'canvas') {
      // 枠の外側を暗くする
      ctx.save();
      ctx.beginPath();
      ctx.rect(-1e5, -1e5, 2e5, 2e5);
      addShapePath(ctx, s.shape, c.x, c.y, w, hh);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill('evenodd');
      ctx.restore();
    }
    const pts = frameScreen(host, s);
    // 外接する四角形（ハンドルの枠）
    strokePolygon(ctx, pts, '#ffffff', 1.5);
    strokePolygon(ctx, pts, ACCENT, 1, [5, 4]);
    // 切り抜かれる形
    if (s.shape.kind !== 'rect') {
      strokeShape(ctx, s.shape, c, w, hh, rot, '#ffffff', 2);
      strokeShape(ctx, s.shape, c, w, hh, rot, ACCENT, 1);
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

    // 対象
    const targetSeg = segmented<Target>(
      [
        { value: 'canvas', label: 'キャンバス', title: 'キャンバス全体を切り抜く' },
        { value: 'image', label: '選択中の画像', title: '選択中の画像1枚を切り抜く' },
      ],
      st.target,
      (v) => setTarget(host, v),
    );

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

    // 比率（キャンバスのときは表示名を変える）
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
        applyRatio(host);
        refresh();
      },
    );
    const labels: Record<Target, Partial<Record<RatioId, string>>> = {
      image: { orig: '元の比率', '16:9': '16:9', '9:16': '9:16（縦長）' },
      canvas: { orig: '今のキャンバスの比率', '16:9': '16:9（WQHD・4K・FHD）', '9:16': '9:16（各縦向き）' },
    };
    const customW = numberInput({
      value: st.customW,
      min: 0.01,
      digits: 2,
      onChange: (v) => {
        st.customW = v;
        applyRatio(host);
        refresh();
      },
    });
    const customH = numberInput({
      value: st.customH,
      min: 0.01,
      digits: 2,
      onChange: (v) => {
        st.customH = v;
        applyRatio(host);
        refresh();
      },
    });
    const customRow = h('div', { class: 'ratio-row' }, customW.el, h('span', { class: 'unit' }, '：'), customH.el);

    // プリセット：形と比率を設定し、中央に最大サイズで配置（画像なら元画像、キャンバスならキャンバスの中）
    const preset = (kind: CropShapeKind) => {
      const s = session;
      if (!s) return;
      s.shape.kind = kind;
      st.ratio = '1:1';
      const a = toFrameAspect(1, s);
      s.rect =
        s.kind === 'image'
          ? maxCenteredRect(s.orig.srcWidth, s.orig.srcHeight, a)
          : maxCenteredRect(host.editor.doc.canvas.width, host.editor.doc.canvas.height, a);
      refresh();
    };
    const squareBtn = button('正方形', () => preset('rect'), { title: '四角形・1:1 で中央に最大サイズ' });
    const circleBtn = button('正円', () => preset('ellipse'), { title: '楕円・1:1 で中央に最大サイズ' });

    // 範囲の数値入力
    const setRect = (patch: Partial<Rect>, keep: 'w' | 'h' | null) => {
      const s = session;
      if (!s) return;
      const r = { ...s.rect, ...patch };
      const a = aspectValue(s, host);
      if (a && keep === 'w') r.h = r.w / a;
      if (a && keep === 'h') r.w = r.h * a;
      s.rect = clampRectTo(r, boundsOf(s));
      refresh();
    };
    const xIn = numberInput({ value: 0, unit: 'px', onChange: (v) => setRect({ x: v }, null) });
    const yIn = numberInput({ value: 0, unit: 'px', onChange: (v) => setRect({ y: v }, null) });
    const wIn = numberInput({ value: 0, min: 1, unit: 'px', onChange: (v) => setRect({ w: v }, 'w') });
    const hIn = numberInput({ value: 0, min: 1, unit: 'px', onChange: (v) => setRect({ h: v }, 'h') });
    const rangeTitle = text('', 'group-title');

    const okBtn = button(
      '確定',
      () => {
        const kind = session?.kind;
        confirm(host);
        if (kind === 'canvas') start(host);
        refresh();
      },
      { primary: true, title: 'Enter / Esc' },
    );
    okBtn.classList.add('block');
    const resetBtn = button('', () => {
      const s = session;
      if (!s) return;
      if (s.kind === 'image') {
        s.rect = fullRect(s.orig);
        s.shape = { ...DEFAULT_CROP_SHAPE };
        confirm(host);
        host.toast('トリミングを解除しました');
      } else {
        // キャンバス：枠を今のキャンバスに戻す（確定はしない）
        cancel(host);
        start(host);
      }
      refresh();
    });
    const cancelBtn = button(
      'キャンセル',
      () => {
        cancel(host);
        if (st.target === 'canvas') start(host);
        refresh();
      },
      { title: '確定前の変更を取り消す（Ctrl+Z）' },
    );
    const modeHint = text('', 'hint');

    const el = h(
      'div',
      {},
      group('対象', targetSeg.el, info.el),
      group('形', shapeSeg.el, radiusWrap),
      group('比率', ratioSel.el, customRow),
      group('プリセット', h('div', { class: 'btn-row' }, squareBtn, circleBtn)),
      h('div', { class: 'group' }, rangeTitle.el, row('X', xIn.el), row('Y', yIn.el), row('幅', wIn.el), row('高さ', hIn.el)),
      okBtn,
      h('div', { class: 'btn-row' }, resetBtn, cancelBtn),
      modeHint.el,
      hint('Shift＋ハンドル：縦横比を固定（自由のときは 1:1）／ Alt＋ハンドル：中心を固定 ／ Shift＋Alt：両方。Enter / Esc で確定します。'),
    );

    const update = () => {
      const s = session;
      targetSeg.set(st.target);
      if (st.target === 'canvas') {
        const c = host.editor.doc.canvas;
        info.set(`キャンバス ${c.width}×${c.height}`);
      } else {
        const target = s?.kind === 'image' ? host.editor.doc.items.find((x) => x.id === s.id) : null;
        info.set(s?.kind === 'image' && target ? `${target.name}（元 ${s.orig.srcWidth}×${s.orig.srcHeight}）` : '画像を1枚クリックしてください');
      }
      rangeTitle.set(st.target === 'canvas' ? '枠（キャンバスの座標）' : '範囲（元画像のピクセル）');
      resetBtn.textContent = st.target === 'canvas' ? '枠をリセット' : 'トリミング解除';
      modeHint.set(
        st.target === 'canvas'
          ? '枠の内側をドラッグすると枠が動きます。キャンバスの外まで広げた部分は背景色（透明なら透明）になります。確定すると、キャンバスのサイズが枠の大きさになります。'
          : '枠の内側をドラッグすると中の画像がずれます。元画像は残るので、いつでも解除できます。',
      );
      // 比率の表示名を対象に合わせる
      for (const opt of ratioSel.el.options) {
        const label = labels[st.target][opt.value as RatioId];
        if (label) opt.textContent = label;
      }
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

/** 確定前の変更があるか（枠や形を動かしたか） */
function hasPendingChange(host: ToolHost): boolean {
  const s = session;
  if (!s) return false;
  if (s.kind === 'canvas') {
    const c = host.editor.doc.canvas;
    return s.rect.x !== 0 || s.rect.y !== 0 || s.rect.w !== c.width || s.rect.h !== c.height || JSON.stringify(s.shape) !== JSON.stringify(c.shape);
  }
  const cur = host.editor.doc.items.find((x) => x.id === s.id);
  return !cur || cur.type !== 'image' || JSON.stringify([cur.crop, cur.cropShape, cur.cx, cur.cy]) !== JSON.stringify([s.rect, s.shape, s.orig.cx, s.orig.cy]);
}

/** 点がアイテムの上にあるか（ダブルクリック判定用） */
function insideItem(it: ImageItem, p: Point): boolean {
  const q = docToSource(it, p);
  const c = it.crop;
  return q.x >= c.x && q.x <= c.x + c.w && q.y >= c.y && q.y <= c.y + c.h;
}
