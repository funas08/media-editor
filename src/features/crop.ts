// トリミングの計算（UIに依存しない）。
// 範囲は「元画像のピクセル座標」で扱う。範囲を変えても画像そのものはキャンバス上で動かない
// （元画像のどの点がキャンバスのどこに来るか、という対応を保ったまま crop と中心を変える）。

import { clamp, DEG, toLocal } from '../core/geometry';
import type { ImageItem, Point, Rect } from '../core/types';

/** 元画像の座標 (u, v) → キャンバス座標 */
export function sourceToDoc(it: ImageItem, u: number, v: number): Point {
  const lx = (u - (it.crop.x + it.crop.w / 2)) * it.scaleX * (it.flipX ? -1 : 1);
  const ly = (v - (it.crop.y + it.crop.h / 2)) * it.scaleY * (it.flipY ? -1 : 1);
  const c = Math.cos(it.rotation * DEG);
  const s = Math.sin(it.rotation * DEG);
  return { x: it.cx + lx * c - ly * s, y: it.cy + lx * s + ly * c };
}

/** キャンバス座標 → 元画像の座標 */
export function docToSource(it: ImageItem, p: Point): Point {
  const l = toLocal(it, p);
  return {
    x: it.crop.x + it.crop.w / 2 + l.x / (it.scaleX * (it.flipX ? -1 : 1)),
    y: it.crop.y + it.crop.h / 2 + l.y / (it.scaleY * (it.flipY ? -1 : 1)),
  };
}

/** 元画像の位置関係を保ったまま、トリミング範囲だけを rect に変えたアイテム */
export function withCrop(orig: ImageItem, rect: Rect): ImageItem {
  const c = sourceToDoc(orig, rect.x + rect.w / 2, rect.y + rect.h / 2);
  return { ...orig, crop: { ...rect }, cx: c.x, cy: c.y };
}

export function fullRect(it: ImageItem): Rect {
  return { x: 0, y: 0, w: it.srcWidth, h: it.srcHeight };
}

export function isFullRect(it: ImageItem, r: Rect): boolean {
  const e = 0.01;
  return Math.abs(r.x) < e && Math.abs(r.y) < e && Math.abs(r.w - it.srcWidth) < e && Math.abs(r.h - it.srcHeight) < e;
}

/** 画像の範囲内に収める（はみ出す分は縮める） */
export function clampRect(r: Rect, W: number, H: number): Rect {
  const w = clamp(r.w, 1, W);
  const h = clamp(r.h, 1, H);
  return { x: clamp(r.x, 0, W - w), y: clamp(r.y, 0, H - h), w, h };
}

/** 中心を保ったまま、指定の縦横比で今の範囲に収まる最大の範囲にする */
export function fitAspect(r: Rect, aspect: number, W: number, H: number): Rect {
  let w = r.w;
  let h = r.h;
  if (w / h > aspect) w = h * aspect;
  else h = w / aspect;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, W, H);
}

export interface ResizeOptions {
  /** 縦横比（元画像の座標での 幅/高さ）。null なら自由 */
  aspect: number | null;
  /** true なら中心を固定して拡大縮小（Alt） */
  fromCenter: boolean;
}

/**
 * ハンドル (hx, hy) を元画像の座標 (u, v) までドラッグしたときの新しい範囲。
 * - aspect を指定すると縦横比を保つ（辺のハンドルでは、もう一方の向きは中央を基準に両側へ広がる）
 * - fromCenter なら中心を固定して両側へ広がる
 * どの場合も元画像の範囲（0〜W, 0〜H）からはみ出さない
 */
export function resizeCropRect(r0: Rect, hx: number, hy: number, u: number, v: number, opts: ResizeOptions, W: number, H: number): Rect {
  const { aspect, fromCenter } = opts;
  const cx0 = r0.x + r0.w / 2;
  const cy0 = r0.y + r0.h / 2;

  if (fromCenter) {
    let w = hx !== 0 ? Math.max(1, 2 * Math.abs(u - cx0)) : r0.w;
    let h = hy !== 0 ? Math.max(1, 2 * Math.abs(v - cy0)) : r0.h;
    if (aspect) [w, h] = applyAspect(w, h, hx, hy, aspect);
    const maxW = 2 * Math.min(cx0, W - cx0);
    const maxH = 2 * Math.min(cy0, H - cy0);
    if (aspect) {
      const k = Math.min(1, maxW / w, maxH / h);
      w *= k;
      h *= k;
    } else {
      w = Math.min(w, maxW);
      h = Math.min(h, maxH);
    }
    return { x: cx0 - w / 2, y: cy0 - h / 2, w, h };
  }

  let l = r0.x;
  let t = r0.y;
  let r = r0.x + r0.w;
  let b = r0.y + r0.h;
  if (hx === 1) r = clamp(u, l + 1, W);
  if (hx === -1) l = clamp(u, 0, r - 1);
  if (hy === 1) b = clamp(v, t + 1, H);
  if (hy === -1) t = clamp(v, 0, b - 1);
  if (!aspect) return { x: l, y: t, w: r - l, h: b - t };

  let [w, h] = applyAspect(r - l, b - t, hx, hy, aspect);
  // 基準（動かない側）と、そこから広げられる最大サイズ
  const maxW = hx === 1 ? W - r0.x : hx === -1 ? r0.x + r0.w : 2 * Math.min(cx0, W - cx0);
  const maxH = hy === 1 ? H - r0.y : hy === -1 ? r0.y + r0.h : 2 * Math.min(cy0, H - cy0);
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k;
  h *= k;
  const x = hx === 1 ? r0.x : hx === -1 ? r0.x + r0.w - w : cx0 - w / 2;
  const y = hy === 1 ? r0.y : hy === -1 ? r0.y + r0.h - h : cy0 - h / 2;
  return { x, y, w, h };
}

/** 縦横比をそろえる。角は大きい方に合わせ、辺はドラッグしている向きを優先 */
function applyAspect(w: number, h: number, hx: number, hy: number, aspect: number): [number, number] {
  if (hx !== 0 && hy !== 0) return w / h > aspect ? [w, w / aspect] : [h * aspect, h];
  if (hx !== 0) return [w, w / aspect];
  return [h * aspect, h];
}

/** 元画像（W × H）の中央に、指定の縦横比で入る最大の範囲（プリセット「正方形」「正円」用） */
export function maxCenteredRect(W: number, H: number, aspect: number): Rect {
  let w = W;
  let h = W / aspect;
  if (h > H) {
    h = H;
    w = H * aspect;
  }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
