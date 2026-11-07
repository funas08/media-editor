// タイムラインの時刻計算（UI・ブラウザに依存しない純粋な関数）。
//
// トラック（上ほど手前）：オーバーレイ（複数）/ メイン / 元音声（メインと連動）/ 音楽
// - メイン：clip.track === MAIN_TRACK のアイテムを items の並び順に、先頭から隙間なく並べる
// - オーバーレイ：clip.start から置く（隙間あり）
// - clip を持たないアイテム（画像モードの作品）は時刻に関係なく常に表示する
// クリップの長さ：動画 = (outPoint - inPoint) / speed、画像 = clip.duration

import { MAIN_TRACK, type DocState, type Item, type MusicClip, type VideoItem } from './types';

/** タイムラインに置かれたアイテム */
export type TimedItem = Item & { clip: NonNullable<Item['clip']> };

export interface ClipSpan {
  item: TimedItem;
  track: string;
  /** タイムライン上の開始・終了（秒） */
  start: number;
  end: number;
}

/** 表示中のクリップの時刻情報 */
export interface ClipTime {
  /** クリップの先頭からの経過（秒） */
  local: number;
  /** クリップの長さ（秒） */
  length: number;
  /** 動画なら元動画の時刻、画像なら local と同じ */
  source: number;
}

export function isTimed(it: Item): it is TimedItem {
  return it.clip !== undefined;
}

/** クリップの長さ（秒） */
export function clipLength(it: Item): number {
  if (it.type === 'video') return Math.max(0, (it.outPoint - it.inPoint) / (it.speed || 1));
  return Math.max(0, it.clip?.duration ?? 0);
}

/** 互換用：動画クリップの長さ */
export function clipDuration(v: VideoItem): number {
  return clipLength(v);
}

/** メイントラックの各クリップの位置 */
export function mainLayout(doc: DocState): ClipSpan[] {
  const spans: ClipSpan[] = [];
  let t = 0;
  for (const it of doc.items) {
    if (!isTimed(it) || it.clip.track !== MAIN_TRACK) continue;
    const d = clipLength(it);
    spans.push({ item: it, track: MAIN_TRACK, start: t, end: t + d });
    t += d;
  }
  return spans;
}

/** 互換用（V1 の名前） */
export const videoTrackLayout = mainLayout;

/** オーバーレイのクリップの位置（trackId を指定するとそのトラックだけ） */
export function overlaySpans(doc: DocState, trackId?: string): ClipSpan[] {
  const out: ClipSpan[] = [];
  for (const it of doc.items) {
    if (!isTimed(it) || it.clip.track === MAIN_TRACK) continue;
    if (trackId !== undefined && it.clip.track !== trackId) continue;
    const start = Math.max(0, it.clip.start);
    out.push({ item: it, track: it.clip.track, start, end: start + clipLength(it) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** すべてのクリップの位置（メイン＋オーバーレイ） */
export function allSpans(doc: DocState): ClipSpan[] {
  return [...mainLayout(doc), ...overlaySpans(doc)];
}

export function musicEnd(m: MusicClip): number {
  return m.start + Math.max(0, m.outPoint - m.inPoint);
}

/** 作品全体の長さ（秒） */
export function totalDuration(doc: DocState): number {
  let end = 0;
  for (const s of allSpans(doc)) end = Math.max(end, s.end);
  for (const m of doc.timeline.music) end = Math.max(end, musicEnd(m));
  return end;
}

/** メインの長さ（秒） */
export function mainDuration(doc: DocState): number {
  const spans = mainLayout(doc);
  return spans.length ? spans[spans.length - 1].end : 0;
}

/** タイムライン上の時刻 t → クリップの元動画での時刻（画像はクリップ内の経過時間） */
export function sourceTimeAt(span: ClipSpan, t: number): number {
  const it = span.item;
  if (it.type !== 'video') return Math.max(0, t - span.start);
  return Math.min(it.outPoint, Math.max(it.inPoint, it.inPoint + (t - span.start) * (it.speed || 1)));
}

/**
 * メインで時刻 t に表示するクリップ。境目ちょうどは次のクリップ。最後のクリップの終わりは最後のフレームを表示する
 */
export function activeClipAt(doc: DocState, t: number): { span: ClipSpan; sourceTime: number } | null {
  const spans = mainLayout(doc);
  if (spans.length === 0) return null;
  const last = spans[spans.length - 1];
  const span = spans.find((s) => t >= s.start && t < s.end) ?? (t >= last.end && t <= last.end + 1e-6 ? last : null);
  if (!span) return null;
  return { span, sourceTime: sourceTimeAt(span, t) };
}

/** オーバーレイトラックが表示中か */
function trackVisible(doc: DocState, trackId: string): boolean {
  if (trackId === MAIN_TRACK) return true;
  return doc.timeline.overlays.find((t) => t.id === trackId)?.visible ?? true;
}

/** アイテムのトラックがロックされているか */
export function isTrackLocked(doc: DocState, it: Item): boolean {
  const id = it.clip?.track;
  if (!id || id === MAIN_TRACK) return false;
  return doc.timeline.overlays.find((t) => t.id === id)?.locked ?? false;
}

/** 時刻 t に表示するクリップ（ID → 時刻情報） */
export function clipTimesAt(doc: DocState, t: number): Map<string, ClipTime> {
  const m = new Map<string, ClipTime>();
  const put = (span: ClipSpan) => m.set(span.item.id, { local: t - span.start, length: span.end - span.start, source: sourceTimeAt(span, t) });
  const a = activeClipAt(doc, t);
  if (a) put(a.span);
  for (const s of overlaySpans(doc)) {
    if (t >= s.start && t < s.end && trackVisible(doc, s.track)) put(s);
  }
  return m;
}

/** 互換用（V1 の名前） */
export const videoTimesAt = clipTimesAt;

/** アイテムを時刻 t に描くか（clip がないアイテムは常に描く） */
export function isItemShownAt(it: Item, times: Map<string, ClipTime>): boolean {
  return !isTimed(it) || times.has(it.id);
}

/** フェード・不透明度を反映した、時刻での不透明度 */
export function clipAlpha(it: Item, ct: ClipTime | undefined): number {
  const c = it.clip;
  if (!c || !ct) return 1;
  let a = c.opacity;
  if (c.fadeIn > 0) a *= Math.min(1, Math.max(0, ct.local / c.fadeIn));
  if (c.fadeOut > 0) a *= Math.min(1, Math.max(0, (ct.length - ct.local) / c.fadeOut));
  return a;
}

/**
 * 描く順番（奥 → 手前）。メイン → オーバーレイ（下のトラックから上へ）→ clip のないアイテム。
 * clip を持つアイテムがなければ items の順のまま（画像モード）
 */
export function renderOrder(doc: DocState): Item[] {
  if (!doc.items.some(isTimed)) return doc.items;
  const main = doc.items.filter((it) => it.clip?.track === MAIN_TRACK);
  const overlays: Item[] = [];
  const tracks = doc.timeline.overlays;
  for (let i = tracks.length - 1; i >= 0; i--) {
    for (const it of doc.items) if (it.clip?.track === tracks[i].id) overlays.push(it);
  }
  // トラックの一覧にないトラックのクリップ（念のため）
  const known = new Set([MAIN_TRACK, ...tracks.map((t) => t.id)]);
  const orphans = doc.items.filter((it) => it.clip && !known.has(it.clip.track));
  const untimed = doc.items.filter((it) => !it.clip);
  return [...main, ...orphans, ...overlays, ...untimed];
}

/** 音声の区間。再生とミックスで共通に使う */
export interface AudioSegment {
  mediaId: string;
  /** タイムライン上の開始・終了（秒） */
  start: number;
  end: number;
  /** 元のファイルでの開始時刻（秒） */
  sourceStart: number;
  speed: number;
  volume: number;
}

/** 音声の区間の一覧：メインの動画の音声、ミュートしていないオーバーレイの動画の音声、音楽 */
export function audioSegments(doc: DocState): AudioSegment[] {
  const segs: AudioSegment[] = [];
  for (const s of allSpans(doc)) {
    const v = s.item;
    if (v.type !== 'video' || v.muted || v.volume <= 0 || s.end <= s.start) continue;
    if (!trackVisible(doc, s.track)) continue;
    segs.push({ mediaId: v.mediaId, start: s.start, end: s.end, sourceStart: v.inPoint, speed: v.speed || 1, volume: v.volume });
  }
  for (const m of doc.timeline.music) {
    if (m.volume <= 0 || m.outPoint <= m.inPoint) continue;
    segs.push({ mediaId: m.mediaId, start: m.start, end: musicEnd(m), sourceStart: m.inPoint, speed: 1, volume: m.volume });
  }
  return segs;
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
