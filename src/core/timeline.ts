// タイムラインの時刻計算（UI・ブラウザに依存しない純粋な関数）。
// 動画トラック：items の中の動画クリップを、並び順に先頭から隙間なく並べる。
// クリップの長さ = (outPoint - inPoint) / speed

import type { DocState, Item, VideoItem } from './types';

export interface ClipSpan {
  item: VideoItem;
  /** タイムライン上の開始・終了（秒） */
  start: number;
  end: number;
}

/** 動画クリップの長さ（秒） */
export function clipDuration(v: VideoItem): number {
  return Math.max(0, (v.outPoint - v.inPoint) / (v.speed || 1));
}

export function videoClips(doc: DocState): VideoItem[] {
  return doc.items.filter((it): it is VideoItem => it.type === 'video');
}

/** 動画トラックの各クリップの位置 */
export function videoTrackLayout(doc: DocState): ClipSpan[] {
  const spans: ClipSpan[] = [];
  let t = 0;
  for (const item of videoClips(doc)) {
    const d = clipDuration(item);
    spans.push({ item, start: t, end: t + d });
    t += d;
  }
  return spans;
}

/** 作品全体の長さ（秒） */
export function totalDuration(doc: DocState): number {
  const spans = videoTrackLayout(doc);
  return spans.length ? spans[spans.length - 1].end : 0;
}

/** タイムライン上の時刻 t → クリップの元動画での時刻 */
export function sourceTimeAt(span: ClipSpan, t: number): number {
  const v = span.item;
  return Math.min(v.outPoint, Math.max(v.inPoint, v.inPoint + (t - span.start) * (v.speed || 1)));
}

/**
 * 時刻 t に表示する動画クリップと、その元動画での時刻。
 * クリップの終わりちょうど（= 次のクリップの始まり）は次のクリップ。最後のクリップの終わりは最後のフレームを表示する
 */
export function activeClipAt(doc: DocState, t: number): { span: ClipSpan; sourceTime: number } | null {
  const spans = videoTrackLayout(doc);
  if (spans.length === 0) return null;
  const last = spans[spans.length - 1];
  const span = spans.find((s) => t >= s.start && t < s.end) ?? (t >= last.end && t <= last.end + 1e-6 ? last : null);
  if (!span) return null;
  return { span, sourceTime: sourceTimeAt(span, t) };
}

/** 時刻 t に表示する動画アイテムの ID → 元動画での時刻（描画用） */
export function videoTimesAt(doc: DocState, t: number): Map<string, number> {
  const m = new Map<string, number>();
  const a = activeClipAt(doc, t);
  if (a) m.set(a.span.item.id, a.sourceTime);
  return m;
}

/** アイテムを時刻 t に描くか（動画クリップは再生中のものだけ。画像は常に） */
export function isItemShownAt(it: Item, times: Map<string, number>): boolean {
  return it.type !== 'video' || times.has(it.id);
}

/** 音声の区間（元の音声）。再生とミックスで共通に使う */
export interface AudioSegment {
  mediaId: string;
  /** タイムライン上の開始・終了（秒） */
  start: number;
  end: number;
  /** 元動画での開始時刻（秒） */
  sourceStart: number;
  speed: number;
  volume: number;
}

/** 元の音声の区間の一覧（ミュートしたクリップは含めない） */
export function audioSegments(doc: DocState): AudioSegment[] {
  return videoTrackLayout(doc)
    .filter((s) => !s.item.muted && s.item.volume > 0 && s.end > s.start)
    .map((s) => ({ mediaId: s.item.mediaId, start: s.start, end: s.end, sourceStart: s.item.inPoint, speed: s.item.speed || 1, volume: s.item.volume }));
}

/** 時刻を「分:秒.百分の一」で表示 */
export function formatTime(t: number, withFrac = true): string {
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  const ss = withFrac ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${sign}${String(m).padStart(2, '0')}:${ss}`;
}

/** フレーム番号に丸めた時刻 */
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}
