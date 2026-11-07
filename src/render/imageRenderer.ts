// 画像アイテムの描画（Canvas 2D）

import { DEFAULT_ADJUST } from '../core/doc';
import { DEG, itemSize } from '../core/geometry';
import { clipAlpha } from '../core/timeline';
import type { Adjust, MediaItem } from '../core/types';
import { registerItemRenderer, type Ctx2D, type DrawEnv } from './itemRenderers';
import { addShapePath } from './shapes';

/** 色調補正パラメータを Canvas の filter 文字列に変換 */
export function adjustToFilter(a: Adjust, pixelScale: number): string {
  const d = DEFAULT_ADJUST;
  const parts: string[] = [];
  if (a.brightness !== d.brightness) parts.push(`brightness(${a.brightness}%)`);
  if (a.contrast !== d.contrast) parts.push(`contrast(${a.contrast}%)`);
  if (a.saturate !== d.saturate) parts.push(`saturate(${a.saturate}%)`);
  if (a.hue !== d.hue) parts.push(`hue-rotate(${a.hue}deg)`);
  if (a.grayscale !== d.grayscale) parts.push(`grayscale(${a.grayscale}%)`);
  // filter の blur は描画先のピクセル単位なので、表示倍率で換算する
  if (a.blur > 0) parts.push(`blur(${a.blur * pixelScale}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * 画像・動画に共通の描画：位置・回転・反転・色調補正・切り抜きの形を適用して source を描く。
 * source は元の大きさ（srcWidth × srcHeight）と違ってもよい（縮小した動画フレームなど）
 */
export function drawMediaItem(ctx: Ctx2D, it: MediaItem, env: DrawEnv, source: CanvasImageSource | null, sourceW: number, sourceH: number): void {
  const { w, h } = itemSize(it);
  if (w <= 0 || h <= 0 || it.crop.w <= 0 || it.crop.h <= 0) return;
  // 不透明度・フェード（動画モードのクリップ）
  const alpha = clipAlpha(it, env.clipTimes?.get(it.id));
  if (alpha <= 0) return;
  ctx.save();
  if (alpha < 1) ctx.globalAlpha *= alpha;
  ctx.translate(it.cx, it.cy);
  if (it.rotation) ctx.rotate(it.rotation * DEG);
  if (it.flipX || it.flipY) ctx.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1);
  const filter = adjustToFilter(it.adjust, env.pixelScale);
  if (filter !== 'none') ctx.filter = filter;
  const onScreenScale = env.pixelScale * Math.min(it.scaleX, it.scaleY);
  ctx.imageSmoothingEnabled = !(env.pixelated && onScreenScale >= 2);
  ctx.imageSmoothingQuality = 'high';
  // 切り抜きの形でクリップ（四角形ならクリップ不要）
  if (it.cropShape.kind !== 'rect') {
    ctx.beginPath();
    addShapePath(ctx, it.cropShape, 0, 0, w, h);
    ctx.clip();
  }
  if (source) {
    const kx = sourceW / it.srcWidth;
    const ky = sourceH / it.srcHeight;
    const c = it.crop;
    ctx.drawImage(source, c.x * kx, c.y * ky, c.w * kx, c.h * ky, -w / 2, -h / 2, w, h);
  } else {
    // 動画のフレームがまだ用意できていないときは黒で埋める
    ctx.fillStyle = '#000';
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

registerItemRenderer('image', {
  draw(ctx, it, env) {
    const asset = env.assets.get(it.assetId);
    if (!asset) return;
    drawMediaItem(ctx, it, env, asset.bitmap, asset.width, asset.height);
  },
});

registerItemRenderer('video', {
  draw(ctx, it, env) {
    const ct = env.clipTimes?.get(it.id);
    if (ct === undefined) return;
    const f = env.frames?.frameFor(it, ct.source) ?? null;
    drawMediaItem(ctx, it, env, f?.image ?? null, f?.width ?? it.srcWidth, f?.height ?? it.srcHeight);
  },
});
