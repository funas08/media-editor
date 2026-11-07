// アイテムの種類ごとの描画処理を登録する仕組み。
// テキストや図形を追加するときは、新しい型を core/types.ts に足して registerItemRenderer で登録する。

import type { AssetStore } from '../core/AssetStore';
import type { Item, ItemType, VideoItem } from '../core/types';

/** Canvas 2D の描画先（表示用・書き出し用の両方） */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 動画のフレーム（表示用は縮小されていることがある） */
export interface FrameImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** 動画クリップの、指定時刻のフレームを渡す役（表示用・書き出し用で実装が違う） */
export interface VideoFrameProvider {
  frameFor(item: VideoItem, sourceTime: number): FrameImage | null;
}

export interface DrawEnv {
  assets: AssetStore;
  /** キャンバス座標 1px が描画先で何ピクセルになるか（ぼかし量の換算に使う） */
  pixelScale: number;
  /** true なら拡大表示時にピクセルをくっきり表示する（画面表示用） */
  pixelated?: boolean;
  /** 描く時刻（秒）。動画モードの再生位置 */
  time?: number;
  /** 時刻 time に表示する動画クリップ ID → 元動画での時刻（drawScene が計算する） */
  videoTimes?: Map<string, number>;
  /** 動画のフレーム */
  frames?: VideoFrameProvider;
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
