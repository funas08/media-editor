// ドキュメント全体の描画（表示・書き出しで共通）

import { clipTimesAt, isItemShownAt, renderOrder } from '../core/timeline';
import type { DocState, Item } from '../core/types';
import { getItemRenderer, type Ctx2D, type DrawEnv } from './itemRenderers';
import { addShapePath } from './shapes';
import './imageRenderer';

export function drawBackground(ctx: Ctx2D, doc: DocState): void {
  if (doc.canvas.transparent) return;
  ctx.save();
  ctx.fillStyle = doc.canvas.background;
  ctx.fillRect(0, 0, doc.canvas.width, doc.canvas.height);
  ctx.restore();
}

/** 描く時刻のクリップを決めた env を作る（time がなければ 0 秒） */
export function withTimes(doc: DocState, env: DrawEnv): DrawEnv {
  return env.clipTimes ? env : { ...env, clipTimes: clipTimesAt(doc, env.time ?? 0) };
}

/** アイテムを描く。env.clipTimes がある場合、その時刻に表示しないクリップは描かない */
export function drawItems(ctx: Ctx2D, items: readonly Item[], env: DrawEnv): void {
  for (const it of items) {
    if (!it.visible) continue;
    if (env.clipTimes && !isItemShownAt(it, env.clipTimes)) continue;
    getItemRenderer(it.type)?.draw(ctx, it, env);
  }
}

/** キャンバス座標系で背景とアイテムを描く（キャンバスが角丸・楕円なら形の外側は描かない＝透明） */
export function drawScene(ctx: Ctx2D, doc: DocState, envIn: DrawEnv): void {
  const env = withTimes(doc, envIn);
  const { width: W, height: H, shape } = doc.canvas;
  const shaped = shape.kind !== 'rect';
  if (shaped) {
    ctx.save();
    ctx.beginPath();
    addShapePath(ctx, shape, W / 2, H / 2, W, H);
    ctx.clip();
  }
  drawBackground(ctx, doc);
  drawItems(ctx, renderOrder(doc), env);
  if (shaped) ctx.restore();
}
