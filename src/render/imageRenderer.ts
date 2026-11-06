// 画像アイテムの描画（Canvas 2D）

import { DEFAULT_ADJUST } from '../core/doc';
import { DEG, itemSize } from '../core/geometry';
import type { Adjust } from '../core/types';
import { registerItemRenderer } from './itemRenderers';

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

registerItemRenderer('image', {
  draw(ctx, it, env) {
    const asset = env.assets.get(it.assetId);
    if (!asset) return;
    const { w, h } = itemSize(it);
    if (w <= 0 || h <= 0 || it.crop.w <= 0 || it.crop.h <= 0) return;
    ctx.save();
    ctx.translate(it.cx, it.cy);
    if (it.rotation) ctx.rotate(it.rotation * DEG);
    if (it.flipX || it.flipY) ctx.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1);
    const filter = adjustToFilter(it.adjust, env.pixelScale);
    if (filter !== 'none') ctx.filter = filter;
    const onScreenScale = env.pixelScale * Math.min(it.scaleX, it.scaleY);
    ctx.imageSmoothingEnabled = !(env.pixelated && onScreenScale >= 2);
    ctx.imageSmoothingQuality = 'high';
    const c = it.crop;
    ctx.drawImage(asset.bitmap, c.x, c.y, c.w, c.h, -w / 2, -h / 2, w, h);
    ctx.restore();
  },
});
