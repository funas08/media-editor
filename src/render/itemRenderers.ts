// アイテムの種類ごとの描画処理を登録する仕組み。
// テキストや図形を追加するときは、新しい型を core/types.ts に足して registerItemRenderer で登録する。

import type { AssetStore } from '../core/AssetStore';
import type { Item, ItemType } from '../core/types';

/** Canvas 2D の描画先（表示用・書き出し用の両方） */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawEnv {
  assets: AssetStore;
  /** キャンバス座標 1px が描画先で何ピクセルになるか（ぼかし量の換算に使う） */
  pixelScale: number;
  /** true なら拡大表示時にピクセルをくっきり表示する（画面表示用） */
  pixelated?: boolean;
}

export interface ItemRenderer<T extends Item> {
  draw(ctx: Ctx2D, item: T, env: DrawEnv): void;
}

type AnyRenderer = ItemRenderer<Item>;
const renderers = new Map<string, AnyRenderer>();

export function registerItemRenderer<K extends ItemType>(type: K, r: ItemRenderer<Extract<Item, { type: K }>>): void {
  renderers.set(type, r as unknown as AnyRenderer);
}

export function getItemRenderer(type: string): AnyRenderer | undefined {
  return renderers.get(type);
}
