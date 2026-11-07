// 素材（画像・動画・音楽）からタイムラインのクリップを作る（純粋な関数）

import { DEFAULT_STILL_DURATION, createImageItem, createVideoItem, newClipTiming, newId } from '../core/doc';
import { MAIN_TRACK, type CanvasSettings, type Item, type MusicClip, type Point } from '../core/types';

/** 素材の情報（素材パネルの1件） */
export interface SourceInfo {
  kind: 'image' | 'video' | 'audio';
  /** 画像なら AssetStore の ID、動画・音楽なら MediaStore の ID */
  id: string;
  name: string;
  width: number;
  height: number;
  /** 長さ（秒）。画像は 0 */
  duration: number;
}

/** オーバーレイの動画（ワイプ）の大きさ：キャンバスの幅・高さの何割に収めるか */
const WIPE_RATIO = 0.4;

/** クリップの長さ（秒）：動画は元の長さ、画像は既定の 5 秒 */
export function sourceLength(src: SourceInfo): number {
  return src.kind === 'image' ? DEFAULT_STILL_DURATION : src.duration;
}

/**
 * 画像・動画の素材からクリップ（アイテム）を作る。
 * - メイン：キャンバスに収める（「収める」を既定で適用）、中央に置く
 * - オーバーレイ：画像は原寸（キャンバスより大きければ収める）、動画はワイプ（キャンバスの 4 割に収める）。音声はミュート。
 *   center を渡すとその位置（キャンバスへのドロップ）、なければ中央
 */
export function makeClipItem(src: SourceInfo, canvas: Pick<CanvasSettings, 'width' | 'height'>, placement: 'main' | 'overlay', center?: Point): Item {
  const { width: W, height: H } = canvas;
  const c = center ?? { x: W / 2, y: H / 2 };
  const fit = Math.min(W / src.width, H / src.height);
  const scale = placement === 'main' ? fit : src.kind === 'video' ? fit * WIPE_RATIO : Math.min(1, fit);
  const track = placement === 'main' ? MAIN_TRACK : '';
  if (src.kind === 'video') {
    const v = createVideoItem({ id: src.id, name: src.name, width: src.width, height: src.height, duration: src.duration }, c.x, c.y, scale);
    v.clip = newClipTiming(track, 0, src.duration);
    if (placement === 'overlay') v.muted = true;
    return v;
  }
  const img = createImageItem({ id: src.id, name: src.name, width: src.width, height: src.height }, c.x, c.y, scale);
  img.clip = newClipTiming(track, 0, DEFAULT_STILL_DURATION);
  return img;
}

/** 音楽の素材から音楽クリップを作る */
export function makeMusicClip(src: SourceInfo, start: number): MusicClip {
  return { id: newId('mus'), mediaId: src.id, name: src.name, start: Math.max(0, start), inPoint: 0, outPoint: src.duration, srcDuration: src.duration, volume: 1 };
}

/** 素材がドキュメントで使われているか（クリップ・画像・音楽） */
export function isSourceUsed(doc: { items: Item[]; timeline: { music: MusicClip[] } }, id: string): boolean {
  return doc.items.some((it) => (it.type === 'image' ? it.assetId : it.mediaId) === id) || doc.timeline.music.some((m) => m.mediaId === id);
}
