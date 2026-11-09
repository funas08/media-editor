// 無劣化コピー（スマートレンダリング）の計画（ブラウザに依存しない純粋な計算）。
//
// メインの動画クリップのうち、編集していない（変形・切り抜き・色調補正・不透明度・フェード・速度変更なし、
// キャンバスと同じサイズで等倍・中央）区間は、元の圧縮データをそのままコピーする。
// コピーできるのは「キーフレームから次のキーフレームまで（GOP）」がまるごとクリップの範囲に入っていて、
// オーバーレイが重なっていない部分。それ以外（カット位置から次のキーフレームまでなど）は再エンコードする。
// 出力のコーデック・解像度・フレームレート・プロファイルが元動画と同じ場合に限る。
//
// 音声は、全体をそのままコピーできる場合だけコピーする（一部だけコピーすると、つなぎ目で AAC のエンコーダーの
// 遅延によるずれ・ノイズが出るため）。

import { DEFAULT_ADJUST } from '../core/doc';
import { allSpans, isTimed, mainLayout, type ClipSpan } from '../core/timeline';
import { MAIN_TRACK, type DocState, type VideoItem } from '../core/types';
import { codecFamily } from './encodeSettings';

/** 元動画の映像について、判定に使う情報 */
export interface SourceVideoMeta {
  /** コーデック文字列（例：avc1.640028） */
  codecString: string | null;
  /** 表示上の幅・高さ */
  width: number;
  height: number;
  fps: number;
  /** 回転情報（度） */
  rotation: number;
  /** HDR（PQ / HLG / BT.2020）か */
  hdr: boolean;
  /** キーフレームの時刻（秒、昇順） */
  keyTimes: number[];
  /** 映像の終わり（最後のフレームの終わり、秒） */
  endTime: number;
  /** 音声（AAC などの設定）。音声がなければ null */
  audio: { codec: string | null; sampleRate: number; channels: number } | null;
}

export interface SmartOutput {
  width: number;
  height: number;
  fps: number;
  /** 出力の映像コーデック（avc / hevc / av1） */
  codec: string;
  /** キャンバスに対する倍率 */
  scale: number;
  /** 書き出す範囲（タイムラインの秒） */
  from: number;
  to: number;
  includeAudio: boolean;
  /** 音声の出力（サンプルレート・チャンネル数） */
  audioSampleRate: number;
  audioChannels: number;
  /** このコーデック文字列（プロファイル・レベル）で、つなぎ目を再エンコードできるか */
  canEncodeProfile: (codecString: string) => boolean;
}

/** 書き出しの区間（時刻は書き出す動画の秒、0 始まり） */
export type SmartSection =
  | {
      kind: 'copy';
      itemId: string;
      mediaId: string;
      /** 元動画の範囲（キーフレームの時刻から次のキーフレームの時刻まで） */
      srcFrom: number;
      srcTo: number;
      /** 書き出す動画の時刻 = 元動画の時刻 + offset */
      offset: number;
      start: number;
      end: number;
    }
  | {
      kind: 'render';
      start: number;
      end: number;
      /**
       * フレームを置く時刻。'grid' なら出力のフレームレートの間隔。
       * 元動画に合わせるとき（コピーできる形式のクリップ）は、その元動画のフレームの時刻（= 元の時刻 + offset）
       */
      frames: 'grid' | { mediaId: string; offset: number; srcFrom: number; srcTo: number };
    };

export interface SmartAudioPart {
  mediaId: string;
  srcFrom: number;
  srcTo: number;
  /** 書き出す動画の時刻 = 元の時刻 + offset */
  offset: number;
}

export interface SmartPlan {
  sections: SmartSection[];
  /** 無劣化コピーできる長さ（秒） */
  copySeconds: number;
  /** 全体の長さ（秒） */
  totalSeconds: number;
  /** コピーできない区間がある理由（重複なし） */
  reasons: string[];
  /** 再エンコードのつなぎ目に使うコーデック文字列（コピーがなければ null） */
  codecString: string | null;
  /** コピーする元動画（最初のもの）。映像トラックの設定に使う */
  primaryMediaId: string | null;
  audio: { copy: true; parts: SmartAudioPart[] } | { copy: false; reason: string | null };
}

const EPS = 1e-4;

function near(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

/** 編集の有無（理由の文。なければ null） */
function editReason(doc: DocState, v: VideoItem): string | null {
  const a = v.adjust;
  if ((Object.keys(DEFAULT_ADJUST) as (keyof typeof DEFAULT_ADJUST)[]).some((k) => a[k] !== DEFAULT_ADJUST[k])) return '色調補正している';
  if (v.rotation % 360 !== 0 || v.flipX || v.flipY) return '回転・反転している';
  if (v.crop.x !== 0 || v.crop.y !== 0 || v.crop.w !== v.srcWidth || v.crop.h !== v.srcHeight || v.cropShape.kind !== 'rect') return 'トリミングしている';
  if (!near(v.scaleX, 1) || !near(v.scaleY, 1) || !near(v.cx, doc.canvas.width / 2) || !near(v.cy, doc.canvas.height / 2)) return '位置・大きさを変えている（等倍・中央ではない）';
  if ((v.speed || 1) !== 1) return '再生速度を変えている';
  const c = v.clip;
  if (c && (c.opacity < 1 || c.fadeIn > 0 || c.fadeOut > 0)) return '不透明度・フェードを使っている';
  return null;
}

/** 形式（コーデック・サイズ・フレームレート）がコピーできるか（理由の文。できるなら null） */
function formatReason(doc: DocState, m: SourceVideoMeta | undefined, out: SmartOutput): string | null {
  if (!m) return '元動画の情報を読み取れない';
  const fam = codecFamily(m.codecString);
  if (fam !== 'avc' && fam !== 'hevc') return `元動画のコーデック（${m.codecString ?? '不明'}）は無劣化コピーに未対応（H.264 / H.265 のみ）`;
  if (fam !== out.codec) return '書き出しのコーデックが元動画と違う';
  if (out.scale !== 1) return '倍率が 1x ではない';
  if (m.width !== doc.canvas.width || m.height !== doc.canvas.height || out.width !== m.width || out.height !== m.height) {
    return `元動画（${m.width}×${m.height}）とキャンバス（${doc.canvas.width}×${doc.canvas.height}）の大きさが違う`;
  }
  if (doc.canvas.shape.kind !== 'rect') return 'キャンバスを角丸・楕円にしている';
  if (Math.abs(m.fps - out.fps) / out.fps > 0.01) return `フレームレートが違う（元 ${m.fps.toFixed(2)}fps / 書き出し ${out.fps}fps）`;
  if (m.rotation % 360 !== 0) return '元動画に回転の情報がある（縦向きの撮影など）';
  if (m.hdr) return '元動画が HDR';
  if (!m.codecString || !out.canEncodeProfile(m.codecString)) return `元動画のプロファイル（${m.codecString ?? '不明'}）で、つなぎ目を再エンコードできない`;
  return null;
}

/** 無劣化コピーの計画を立てる */
export function planSmartCopy(doc: DocState, metas: ReadonlyMap<string, SourceVideoMeta>, out: SmartOutput): SmartPlan {
  const { from, to } = out;
  const total = Math.max(0, to - from);
  const reasons = new Set<string>();
  const sections: SmartSection[] = [];
  let codecString: string | null = null;
  let primaryMediaId: string | null = null;

  // 常に表示される画像（タイムラインに置いていないもの）があると、どのフレームにも重なる
  const untimed = doc.items.some((it) => !isTimed(it) && it.visible);
  if (untimed) reasons.add('タイムラインの外の画像（常に表示）が重なっている');
  // オーバーレイが表示される区間（非表示のトラック・アイテムは除く）
  const overlayHoles: [number, number][] = allSpans(doc)
    .filter((s) => s.track !== MAIN_TRACK && s.item.visible && (doc.timeline.overlays.find((t) => t.id === s.track)?.visible ?? true))
    .map((s) => [s.start, s.end]);

  let cursor = from;
  const pushRender = (start: number, end: number, frames: Extract<SmartSection, { kind: 'render' }>['frames']) => {
    if (end - start <= EPS) return;
    sections.push({ kind: 'render', start: start - from, end: end - from, frames });
  };

  for (const span of mainLayout(doc)) {
    const s0 = Math.max(span.start, from);
    const s1 = Math.min(span.end, to);
    if (s1 - s0 <= EPS) continue;
    if (s0 > cursor + EPS) pushRender(cursor, s0, 'grid');
    cursor = Math.max(cursor, s1);
    const it = span.item;
    if (it.type !== 'video') {
      pushRender(s0, s1, 'grid');
      continue;
    }
    planClip(span as ClipSpan & { item: VideoItem }, s0, s1);
  }
  if (to > cursor + EPS) pushRender(cursor, to, 'grid');

  function planClip(span: ClipSpan & { item: VideoItem }, s0: number, s1: number): void {
    const v = span.item;
    const m = metas.get(v.mediaId);
    // 元動画の時刻 = タイムラインの時刻 + toSrc（速度 1 のとき）
    const toSrc = v.inPoint - span.start;
    const fmt = formatReason(doc, m, out);
    if (fmt || !m) {
      reasons.add(fmt ?? '元動画の情報を読み取れない');
      pushRender(s0, s1, 'grid');
      return;
    }
    // 形式は合う：再エンコードする部分も元動画のフレームの時刻に合わせる
    const srcFrames = (a: number, b: number) => ({ mediaId: v.mediaId, offset: -toSrc - from, srcFrom: a + toSrc, srcTo: b + toSrc });
    const edit = editReason(doc, v);
    if (edit) {
      reasons.add(edit);
      pushRender(s0, s1, srcFrames(s0, s1));
      return;
    }
    if (codecString && m.codecString !== codecString) {
      reasons.add('ほかの元動画とプロファイル（コーデック文字列）が違う');
      pushRender(s0, s1, srcFrames(s0, s1));
      return;
    }
    // コピーできる GOP：[k_i, k_{i+1}) がまるごと範囲に入り、オーバーレイと重ならない
    const keys = [...m.keyTimes, m.endTime];
    const src0 = s0 + toSrc;
    const src1 = s1 + toSrc;
    const gops: [number, number][] = [];
    let overlayHit = false;
    for (let i = 0; i + 1 < keys.length; i++) {
      const k0 = keys[i];
      const k1 = keys[i + 1];
      if (k0 < src0 - EPS || k1 > src1 + EPS) continue;
      const t0 = k0 - toSrc;
      const t1 = k1 - toSrc;
      if (untimed) continue;
      if (overlayHoles.some(([h0, h1]) => h0 < t1 - EPS && h1 > t0 + EPS)) {
        reasons.add('オーバーレイが重なっている');
        overlayHit = true;
        continue;
      }
      // 隣の GOP とつなげる
      const last = gops[gops.length - 1];
      if (last && near(last[1], k0, EPS)) last[1] = k1;
      else gops.push([k0, k1]);
    }
    let c = s0;
    for (const [k0, k1] of gops) {
      const t0 = k0 - toSrc;
      const t1 = k1 - toSrc;
      if (t0 > c + EPS) {
        reasons.add('カットの位置がキーフレームではない（その位置から次のキーフレームまで再エンコード）');
        pushRender(c, t0, srcFrames(c, t0));
      }
      sections.push({ kind: 'copy', itemId: v.id, mediaId: v.mediaId, srcFrom: k0, srcTo: k1, offset: -toSrc - from, start: t0 - from, end: t1 - from });
      codecString ??= m.codecString;
      primaryMediaId ??= v.mediaId;
      c = t1;
    }
    if (s1 > c + EPS) {
      if (!overlayHit && !untimed) reasons.add('カットの位置がキーフレームではない（その位置から次のキーフレームまで再エンコード）');
      pushRender(c, s1, srcFrames(c, s1));
    }
  }

  const copySeconds = sections.reduce((s, x) => s + (x.kind === 'copy' ? x.end - x.start : 0), 0);
  return {
    sections,
    copySeconds,
    totalSeconds: total,
    reasons: [...reasons],
    codecString,
    primaryMediaId,
    audio: planAudio(doc, metas, out),
  };
}

/** 音声をまるごとコピーできるか */
function planAudio(doc: DocState, metas: ReadonlyMap<string, SourceVideoMeta>, out: SmartOutput): SmartPlan['audio'] {
  if (!out.includeAudio) return { copy: false, reason: null };
  const no = (reason: string): SmartPlan['audio'] => ({ copy: false, reason });
  if (doc.timeline.music.some((m) => m.volume > 0 && m.outPoint > m.inPoint)) return no('音楽を入れている');
  for (const s of allSpans(doc)) {
    if (s.track === MAIN_TRACK || s.item.type !== 'video' || s.end <= out.from || s.start >= out.to) continue;
    const trackOn = doc.timeline.overlays.find((t) => t.id === s.track)?.visible ?? true;
    if (trackOn && !s.item.muted && s.item.volume > 0) return no('オーバーレイの動画の音声を入れている');
  }
  const parts: SmartAudioPart[] = [];
  let cursor = out.from;
  let first: SourceVideoMeta['audio'] = null;
  for (const span of mainLayout(doc)) {
    const s0 = Math.max(span.start, out.from);
    const s1 = Math.min(span.end, out.to);
    if (s1 - s0 <= EPS) continue;
    if (s0 > cursor + EPS) return no('音声のない区間がある');
    const v = span.item;
    if (v.type !== 'video') return no('画像のクリップ（音声なし）がある');
    const a = metas.get(v.mediaId)?.audio;
    if (!a) return no('音声の入っていない動画がある');
    if (v.muted || v.volume !== 1) return no('元の音声の音量を変えている・ミュートしている');
    if ((v.speed || 1) !== 1) return no('再生速度を変えている');
    if (a.codec !== 'aac') return no(`元の音声が AAC ではない（${a.codec ?? '不明'}）`);
    if (a.sampleRate !== out.audioSampleRate || a.channels !== out.audioChannels) {
      return no(`元の音声の形式（${a.sampleRate}Hz・${a.channels}ch）が書き出しの形式（${out.audioSampleRate}Hz・${out.audioChannels}ch）と違う`);
    }
    if (first && (first.sampleRate !== a.sampleRate || first.channels !== a.channels)) return no('元の動画ごとに音声の形式が違う');
    first ??= a;
    const toSrc = v.inPoint - span.start;
    parts.push({ mediaId: v.mediaId, srcFrom: s0 + toSrc, srcTo: s1 + toSrc, offset: -toSrc - out.from });
    cursor = s1;
  }
  if (out.to > cursor + EPS) return no('音声のない区間がある');
  if (parts.length === 0) return no('音声がない');
  return { copy: true, parts };
}

/** 秒を「12.3 秒」「1 分 5 秒」のように表す */
export function formatSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s - m * 60)} 秒`;
}
