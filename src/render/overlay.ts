// オーバーレイ（選択枠・ハンドル・ガイド・ラベル）の描画ヘルパー。画面座標（CSS px）で描く。

import { itemCorners } from '../core/geometry';
import type { ImageItem, Item, Point, Rect } from '../core/types';
import type { View } from './view';

export const ACCENT = '#4c8dff';

export function strokePolygon(ctx: CanvasRenderingContext2D, pts: Point[], color = ACCENT, width = 1.5, dash: number[] = []): void {
  ctx.save();
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.setLineDash(dash);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

/** アイテムの外形（回転込み）を描く */
export function strokeItem(ctx: CanvasRenderingContext2D, view: View, it: Item, color = ACCENT, width = 1.5, dash: number[] = []): void {
  strokePolygon(ctx, itemCorners(it).map((p) => view.docToScreen(p)), color, width, dash);
}

/** キャンバス座標の矩形を描く */
export function strokeDocRect(ctx: CanvasRenderingContext2D, view: View, r: Rect, color = ACCENT, width = 1, dash: number[] = []): void {
  const a = view.docToScreen({ x: r.x, y: r.y });
  const b = view.docToScreen({ x: r.x + r.w, y: r.y + r.h });
  strokePolygon(ctx, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], color, width, dash);
}

export function fillDocRect(ctx: CanvasRenderingContext2D, view: View, r: Rect, color: string): void {
  const a = view.docToScreen({ x: r.x, y: r.y });
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(a.x, a.y, r.w * view.zoom, r.h * view.zoom);
  ctx.restore();
}

export function drawHandle(ctx: CanvasRenderingContext2D, p: Point, size = 9, round = false): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (round) ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
  else ctx.rect(p.x - size / 2, p.y - size / 2, size, size);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** 吹き出し風のラベル（サイズや角度の表示用） */
export function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg = 'rgba(20,22,26,0.88)'): void {
  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 12;
  const h = 20;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, y + h / 2 + 0.5);
  ctx.restore();
}

export function drawLine(ctx: CanvasRenderingContext2D, a: Point, b: Point, color: string, width = 1, dash: number[] = []): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

/**
 * トリミング中に、切り抜かれる部分の元画像を薄く描く（exclude は元画像座標の範囲で、そこは描かない）。
 * it は元画像とキャンバスの対応を決めるアイテム（crop・拡大率・回転・反転）
 */
export function drawSourceGhost(
  ctx: CanvasRenderingContext2D,
  view: View,
  it: ImageItem,
  image: CanvasImageSource,
  exclude: Rect,
  alpha = 0.35,
): void {
  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(it.cx, it.cy);
  ctx.rotate((it.rotation * Math.PI) / 180);
  ctx.scale(it.flipX ? -it.scaleX : it.scaleX, it.flipY ? -it.scaleY : it.scaleY);
  ctx.translate(-(it.crop.x + it.crop.w / 2), -(it.crop.y + it.crop.h / 2));
  ctx.beginPath();
  ctx.rect(0, 0, it.srcWidth, it.srcHeight);
  ctx.rect(exclude.x, exclude.y, exclude.w, exclude.h);
  ctx.clip('evenodd');
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}
