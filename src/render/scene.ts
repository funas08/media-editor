// ドキュメント全体の描画（表示・書き出しで共通）

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

export function drawItems(ctx: Ctx2D, items: readonly Item[], env: DrawEnv): void {
  for (const it of items) {
    if (!it.visible) continue;
    getItemRenderer(it.type)?.draw(ctx, it, env);
  }
}

/** キャンバス座標系で背景とアイテムを描く（キャンバスが角丸・楕円なら形の外側は描かない＝透明） */
export function drawScene(ctx: Ctx2D, doc: DocState, env: DrawEnv): void {
  const { width: W, height: H, shape } = doc.canvas;
  const shaped = shape.kind !== 'rect';
  if (shaped) {
    ctx.save();
    ctx.beginPath();
    addShapePath(ctx, shape, W / 2, H / 2, W, H);
    ctx.clip();
  }
  drawBackground(ctx, doc);
  drawItems(ctx, doc.items, env);
  if (shaped) ctx.restore();
}
