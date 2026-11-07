// 切り抜きの形のパス（表示・書き出し・オーバーレイ・サムネイルで共通）

import type { CropShape } from '../core/types';

type PathTarget = CanvasPath;

/**
 * 中心 (cx, cy)、幅 w・高さ h の範囲に、形のパスを追加する。
 * rx / ry は角丸の半径（x・y で別の値にできる。元画像の座標で描くとき、拡大率が縦横で違う場合に使う）
 */
export function addShapePath(ctx: PathTarget, shape: CropShape, cx: number, cy: number, w: number, h: number, rx?: number, ry?: number): void {
  const x = cx - w / 2;
  const y = cy - h / 2;
  switch (shape.kind) {
    case 'rect':
      ctx.rect(x, y, w, h);
      break;
    case 'ellipse':
      ctx.ellipse(cx, cy, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
      break;
    case 'roundRect': {
      const r = shapeRadius(shape, w, h);
      ctx.roundRect(x, y, w, h, { x: Math.min(rx ?? r, Math.abs(w) / 2), y: Math.min(ry ?? r, Math.abs(h) / 2) });
      break;
    }
  }
}

/** 表示上の大きさ w × h のときの角丸の半径（px） */
export function shapeRadius(shape: CropShape, w: number, h: number): number {
  return Math.max(0, Math.min(0.5, shape.radius)) * Math.min(Math.abs(w), Math.abs(h));
}
