// タイムラインの編集（トリム・分割・範囲カット・並べ替え・挿入・配置・トラック間の移動・複製・吸着）。
// draft を直接変更する純粋な関数。
// - メイン：items の中の並び順に隙間なく並ぶので、削除や短くすると後ろが自動で詰まる
// - オーバーレイ：clip.start に置く。重なりは許さず、重なるときは別のトラックに置く

import { newClipTiming, newId } from '../core/doc';
import { clipLength, mainLayout, overlaySpans, type ClipSpan, type TimedItem } from '../core/timeline';
import { MAIN_TRACK, type DocState, type Item, type OverlayTrack } from '../core/types';

/** クリップの最短の長さ（秒） */
export const MIN_CLIP = 0.05;

function findTimed(d: DocState, id: string): TimedItem | undefined {
  const it = d.items.find((x) => x.id === id);
  return it?.clip ? (it as TimedItem) : undefined;
}

/** クリップを複製する（新しい ID。配置は呼び出し側で決める） */
export function cloneClip<T extends Item>(it: T): T {
  return { ...structuredClone(it), id: newId(it.type === 'video' ? 'vid' : 'img') };
}

/** クリップを時刻 local（クリップの先頭からの秒）で2つに分ける。後ろ半分を返す（元のクリップは前半になる） */
function splitItem(it: TimedItem, local: number): TimedItem {
  const b = cloneClip(it);
  if (it.type === 'video' && b.type === 'video') {
    const cut = it.inPoint + local * it.speed;
    it.outPoint = cut;
    b.inPoint = cut;
  } else {
    b.clip.duration = it.clip.duration - local;
    it.clip.duration = local;
  }
  b.clip.start = it.clip.start + local;
  return b;
}

/**
 * メインの時刻 t で、その位置のクリップを2つに分ける（S キー）。
 * @returns 後ろ半分の新しいクリップの ID（分けられなかったら null：クリップの端に近すぎる・クリップがない）
 */
export function splitAt(d: DocState, t: number): string | null {
  const span = mainLayout(d).find((s) => t > s.start + MIN_CLIP && t < s.end - MIN_CLIP);
  if (!span) return null;
  const b = splitItem(span.item, t - span.start);
  d.items.splice(d.items.indexOf(span.item) + 1, 0, b);
  return b.id;
}

/**
 * 動画クリップの端をトリムする。edge='start' なら使う範囲の開始、'end' なら終了を sourceTime（元動画の秒）にする。
 * 元動画の範囲（0〜長さ）と最短の長さを守る
 */
export function trimClip(d: DocState, id: string, edge: 'start' | 'end', sourceTime: number): void {
  const v = d.items.find((x) => x.id === id);
  if (v?.type !== 'video') return;
  const minLen = MIN_CLIP * v.speed;
  if (edge === 'start') v.inPoint = Math.min(Math.max(0, sourceTime), v.outPoint - minLen);
  else v.outPoint = Math.max(Math.min(v.srcDuration, sourceTime), v.inPoint + minLen);
}

/**
 * クリップの端を、ドラッグ開始時の状態 orig から dt 秒動かす（動画・画像、メイン・オーバーレイ共通）。
 * - 動画：使う範囲を変える（元動画の範囲を超えない）
 * - 画像：表示時間を変える
 * - オーバーレイの開始側：開始時刻も一緒に動かす（終わりの時刻は変わらない）
 */
export function trimBy(d: DocState, orig: TimedItem, edge: 'start' | 'end', dt: number): void {
  const it = findTimed(d, orig.id);
  if (!it) return;
  const overlay = orig.clip.track !== MAIN_TRACK;
  if (it.type === 'video' && orig.type === 'video') {
    if (edge === 'start') {
      // オーバーレイでは先頭より前（マイナスの時刻）には伸ばせない
      const minDt = overlay ? -orig.clip.start : -Infinity;
      trimClip(d, it.id, 'start', orig.inPoint + Math.max(dt, minDt) * orig.speed);
      if (overlay) it.clip.start = orig.clip.start + (it.inPoint - orig.inPoint) / orig.speed;
    } else {
      trimClip(d, it.id, 'end', orig.outPoint + dt * orig.speed);
    }
    return;
  }
  if (edge === 'start') {
    const minDt = overlay ? -orig.clip.start : -Infinity;
    const k = Math.min(Math.max(dt, minDt), orig.clip.duration - MIN_CLIP);
    it.clip.duration = orig.clip.duration - k;
    if (overlay) it.clip.start = orig.clip.start + k;
  } else {
    it.clip.duration = Math.max(MIN_CLIP, orig.clip.duration + dt);
  }
}

/**
 * メインの範囲 t0〜t1 を切り取って後ろを詰める（I / O で指定した範囲のカット）。オーバーレイは動かさない
 * @returns 切り取った長さ（秒）
 */
export function cutRange(d: DocState, t0: number, t1: number): number {
  const from = Math.min(t0, t1);
  const to = Math.max(t0, t1);
  if (to - from < 1e-6) return 0;
  let removed = 0;
  for (const s of mainLayout(d)) {
    const a = Math.max(from, s.start);
    const b = Math.min(to, s.end);
    if (b - a <= 1e-9) continue;
    const it = s.item;
    removed += b - a;
    const keepHead = a - s.start > 1e-9;
    const keepTail = s.end - b > 1e-9;
    if (!keepHead && !keepTail) {
      d.items.splice(d.items.indexOf(it), 1);
    } else if (keepHead && keepTail) {
      // 途中を切り取る：後ろ側を作ってから前側を短くする
      const tail = splitItem(it, b - s.start);
      d.items.splice(d.items.indexOf(it) + 1, 0, tail);
      shortenTail(it, b - a);
    } else if (keepHead) {
      shortenTail(it, b - a);
    } else {
      shortenHead(it, b - a);
    }
  }
  return removed;
}

/** 後ろを len 秒短くする */
function shortenTail(it: TimedItem, len: number): void {
  if (it.type === 'video') it.outPoint -= len * it.speed;
  else it.clip.duration -= len;
}

/** 前を len 秒短くする */
function shortenHead(it: TimedItem, len: number): void {
  if (it.type === 'video') it.inPoint += len * it.speed;
  else it.clip.duration -= len;
}

/** メインのクリップの並び（items の中の位置） */
function mainSlots(d: DocState): { slots: number[]; items: TimedItem[] } {
  const slots: number[] = [];
  const items: TimedItem[] = [];
  d.items.forEach((it, i) => {
    if (it.clip?.track === MAIN_TRACK) {
      slots.push(i);
      items.push(it as TimedItem);
    }
  });
  return { slots, items };
}

/**
 * メインのクリップの順番を変える。toIndex はメインの中での新しい位置（0 = 先頭）。
 * 他のアイテムの重なり順は変えない
 */
export function moveClip(d: DocState, id: string, toIndex: number): void {
  const { slots, items } = mainSlots(d);
  const from = items.findIndex((v) => v.id === id);
  if (from < 0) return;
  const [v] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, v);
  slots.forEach((slot, k) => (d.items[slot] = items[k]));
}

/** メインの中で時刻 t に一番近い境目の位置（何番目の前か）と、その時刻 */
export function nearestBoundary(d: DocState, t: number, excludeId?: string): { index: number; time: number } {
  const spans = mainLayout(d).filter((s) => s.item.id !== excludeId);
  let acc = 0;
  let best = { index: 0, time: 0 };
  let bestDist = Math.abs(t);
  spans.forEach((s, i) => {
    acc += s.end - s.start;
    const dist = Math.abs(t - acc);
    if (dist < bestDist) {
      bestDist = dist;
      best = { index: i + 1, time: acc };
    }
  });
  return best;
}

/**
 * メインの時刻 t にクリップを挿入して後ろを詰める。
 * t が境目から snap 秒以内なら境目に、それ以外でクリップの途中ならそこで分割して間に挿入する。
 * items は d.items にまだ入っていないアイテム（clip は上書きする）
 * @returns 挿入した時刻
 */
export function insertIntoMain(d: DocState, items: Item[], t: number, snap: number): number {
  const spans = mainLayout(d);
  const b = nearestBoundary(d, t);
  let index: number;
  let at: number;
  const inside = spans.find((s) => t > s.start && t < s.end);
  if (Math.abs(b.time - t) <= snap || !inside || t - inside.start < MIN_CLIP || inside.end - t < MIN_CLIP) {
    index = b.index;
    at = b.time;
  } else {
    const tail = splitItem(inside.item, t - inside.start);
    d.items.splice(d.items.indexOf(inside.item) + 1, 0, tail);
    index = spans.indexOf(inside) + 1;
    at = t;
  }
  // メインの index 番目の前（なければ最後のメインの後ろ、メインが空なら先頭）に入れる
  const { slots } = mainSlots(d);
  let pos = index < slots.length ? slots[index] : slots.length ? slots[slots.length - 1] + 1 : 0;
  for (const it of items) {
    it.clip = { ...(it.clip ?? newClipTiming(MAIN_TRACK, 0, 0)), track: MAIN_TRACK, start: 0 };
    d.items.splice(pos++, 0, it);
  }
  return at;
}

/** オーバーレイトラックの [start, end) が空いているか */
export function trackFree(d: DocState, trackId: string, start: number, end: number, excludeId?: string): boolean {
  return overlaySpans(d, trackId).every((s) => s.item.id === excludeId || s.end <= start + 1e-9 || s.start >= end - 1e-9);
}

/** 新しいオーバーレイトラックを作る。above を指定するとそのトラックの上（手前）に、なければ一番上に作る */
export function addTrack(d: DocState, above?: string): OverlayTrack {
  const track: OverlayTrack = { id: newId('trk'), visible: true, locked: false };
  const i = above ? d.timeline.overlays.findIndex((t) => t.id === above) : -1;
  if (i >= 0) d.timeline.overlays.splice(i, 0, track);
  else d.timeline.overlays.unshift(track);
  return track;
}

/** 空のオーバーレイトラックを削除する（クリップがあれば削除しない） */
export function removeTrackIfEmpty(d: DocState, trackId: string): boolean {
  if (d.items.some((it) => it.clip?.track === trackId)) return false;
  const i = d.timeline.overlays.findIndex((t) => t.id === trackId);
  if (i < 0) return false;
  d.timeline.overlays.splice(i, 1);
  return true;
}

/**
 * オーバーレイに置く。trackId のトラックの start からが空いていればそこへ。
 * 空いていなければ空いているオーバーレイトラック（近い順）、なければ新しいトラックを trackId の上に作って置く。
 * trackId が null なら新しいトラックを一番上に作る
 * @returns 置いたトラックの ID
 */
export function placeOnOverlay(d: DocState, it: Item, trackId: string | null, start: number): string {
  const s = Math.max(0, start);
  const len = it.clip ? clipLength({ ...it, clip: { ...it.clip } } as Item) : 0;
  const end = s + Math.max(len, MIN_CLIP);
  let target: string | null = null;
  const tracks = d.timeline.overlays;
  if (trackId !== null) {
    const order = [...tracks].sort((a, b) => Math.abs(indexOfTrack(d, a.id) - indexOfTrack(d, trackId)) - Math.abs(indexOfTrack(d, b.id) - indexOfTrack(d, trackId)));
    target = order.find((t) => !t.locked && trackFree(d, t.id, s, end, it.id))?.id ?? null;
  }
  if (!target) target = addTrack(d, trackId ?? undefined).id;
  it.clip = { ...(it.clip ?? newClipTiming(target, s, len)), track: target, start: s };
  if (!d.items.includes(it)) d.items.push(it);
  return target;
}

function indexOfTrack(d: DocState, id: string): number {
  return d.timeline.overlays.findIndex((t) => t.id === id);
}

/**
 * 既存のクリップを動かす（トラック間の移動を含む）。
 * - to.kind='main'：メインの時刻 t に（メイン内の移動なら境目への並べ替え、オーバーレイからなら挿入（途中なら分割））
 * - to.kind='overlay'：トラックの start に（重なれば別のトラック）
 * - to.kind='newTrack'：新しいトラックを above の上（なければ一番上）に作って start に
 */
export type ClipTarget = { kind: 'main'; t: number } | { kind: 'overlay'; trackId: string; start: number } | { kind: 'newTrack'; start: number; above?: string };

export function moveClipTo(d: DocState, id: string, to: ClipTarget, snap: number): void {
  const it = findTimed(d, id);
  if (!it) return;
  const fromTrack = it.clip.track;
  if (to.kind === 'main') {
    if (fromTrack === MAIN_TRACK) {
      moveClip(d, id, nearestBoundary(d, to.t, id).index);
    } else {
      d.items.splice(d.items.indexOf(it), 1);
      insertIntoMain(d, [it], to.t, snap);
    }
  } else {
    if (fromTrack === MAIN_TRACK) {
      // メインから出すと後ろが詰まる。オーバーレイへは items の最後に移す
      d.items.splice(d.items.indexOf(it), 1);
      d.items.push(it);
    }
    if (to.kind === 'overlay') placeOnOverlay(d, it, to.trackId, to.start);
    else {
      const t = addTrack(d, to.above);
      it.clip = { ...it.clip, track: t.id, start: Math.max(0, to.start) };
    }
  }
}

/** 吸着の候補：先頭・再生位置・クリップの境目（exclude のクリップは除く） */
export function snapCandidates(d: DocState, playhead: number, excludeId?: string): number[] {
  const c = new Set<number>([0, playhead]);
  const spans: ClipSpan[] = [...mainLayout(d), ...overlaySpans(d)];
  for (const s of spans) {
    if (s.item.id === excludeId) continue;
    c.add(s.start);
    c.add(s.end);
  }
  return [...c];
}

/**
 * 時刻 t（と、長さ len のクリップの終わり t+len）を候補に吸着させる。threshold 秒以内なら吸着
 * @returns 吸着後の開始時刻と、吸着した候補（なければ null）
 */
export function snapTime(t: number, len: number, candidates: number[], threshold: number): { t: number; snapped: number | null } {
  let best: { t: number; snapped: number | null; dist: number } = { t, snapped: null, dist: threshold };
  for (const c of candidates) {
    const d1 = Math.abs(c - t);
    if (d1 <= best.dist) best = { t: c, snapped: c, dist: d1 };
    const d2 = Math.abs(c - (t + len));
    if (len > 0 && d2 < best.dist) best = { t: c - len, snapped: c, dist: d2 };
  }
  return { t: Math.max(0, best.t), snapped: best.snapped };
}
