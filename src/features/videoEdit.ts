// 動画の編集（トリム・分割・範囲カット・並べ替え）。draft を直接変更する純粋な関数。
// 動画トラックは items の中の動画クリップの並び順に隙間なく並ぶので、削除や短くすると後ろが自動で詰まる。

import { newId } from '../core/doc';
import { videoTrackLayout } from '../core/timeline';
import type { DocState, VideoItem } from '../core/types';

/** クリップの最短の長さ（秒） */
export const MIN_CLIP = 0.05;

function findVideo(d: DocState, id: string): VideoItem | undefined {
  const it = d.items.find((x) => x.id === id);
  return it?.type === 'video' ? it : undefined;
}

/**
 * 時刻 t で、その位置のクリップを2つに分ける（S キー）。
 * @returns 後ろ半分の新しいクリップの ID（分けられなかったら null：クリップの端に近すぎる・クリップがない）
 */
export function splitAt(d: DocState, t: number): string | null {
  const span = videoTrackLayout(d).find((s) => t > s.start + MIN_CLIP && t < s.end - MIN_CLIP);
  if (!span) return null;
  const a = span.item;
  const cut = a.inPoint + (t - span.start) * a.speed;
  const b: VideoItem = { ...structuredClone(a), id: newId('vid'), inPoint: cut };
  a.outPoint = cut;
  d.items.splice(d.items.indexOf(a) + 1, 0, b);
  return b.id;
}

/**
 * クリップの端をトリムする。edge='start' なら使う範囲の開始、'end' なら終了を sourceTime（元動画の秒）にする。
 * 元動画の範囲（0〜長さ）と最短の長さを守る
 */
export function trimClip(d: DocState, id: string, edge: 'start' | 'end', sourceTime: number): void {
  const v = findVideo(d, id);
  if (!v) return;
  const minLen = MIN_CLIP * v.speed;
  if (edge === 'start') v.inPoint = Math.min(Math.max(0, sourceTime), v.outPoint - minLen);
  else v.outPoint = Math.max(Math.min(v.srcDuration, sourceTime), v.inPoint + minLen);
}

/**
 * タイムラインの範囲 t0〜t1 を切り取って後ろを詰める（I / O で指定した範囲のカット）。
 * 範囲にかかるクリップは短くし、範囲の内側に収まるクリップは削除、範囲が1つのクリップの途中なら2つに分ける
 * @returns 切り取った長さ（秒）
 */
export function cutRange(d: DocState, t0: number, t1: number): number {
  const from = Math.min(t0, t1);
  const to = Math.max(t0, t1);
  if (to - from < 1e-6) return 0;
  let removed = 0;
  for (const s of videoTrackLayout(d)) {
    const a = Math.max(from, s.start);
    const b = Math.min(to, s.end);
    if (b - a <= 1e-9) continue;
    const v = s.item;
    removed += b - a;
    const srcA = v.inPoint + (a - s.start) * v.speed;
    const srcB = v.inPoint + (b - s.start) * v.speed;
    const keepHead = a - s.start > 1e-9;
    const keepTail = s.end - b > 1e-9;
    if (!keepHead && !keepTail) {
      d.items.splice(d.items.indexOf(v), 1);
    } else if (keepHead && keepTail) {
      // 途中を切り取る：前半と後半に分ける
      const tail: VideoItem = { ...structuredClone(v), id: newId('vid'), inPoint: srcB };
      v.outPoint = srcA;
      d.items.splice(d.items.indexOf(v) + 1, 0, tail);
    } else if (keepHead) {
      v.outPoint = srcA;
    } else {
      v.inPoint = srcB;
    }
  }
  return removed;
}

/**
 * 動画クリップの順番を変える。toIndex は動画トラックの中での新しい位置（0 = 先頭）。
 * 画像など動画以外のアイテムの重なり順は変えない（動画クリップどうしの並びだけを入れ替える）
 */
export function moveClip(d: DocState, id: string, toIndex: number): void {
  const slots: number[] = [];
  const videos: VideoItem[] = [];
  d.items.forEach((it, i) => {
    if (it.type === 'video') {
      slots.push(i);
      videos.push(it);
    }
  });
  const from = videos.findIndex((v) => v.id === id);
  if (from < 0) return;
  const [v] = videos.splice(from, 1);
  videos.splice(Math.max(0, Math.min(videos.length, toIndex)), 0, v);
  slots.forEach((slot, k) => (d.items[slot] = videos[k]));
}
