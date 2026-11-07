// 音声区間を Web Audio のノードに並べる処理（再生と書き出しで共通）。
// 区間ごとに元動画の音声をデコードし、タイムライン上の位置に合わせて AudioBufferSourceNode を置く。

import { AudioBufferSink } from 'mediabunny';
import type { AudioSegment } from '../core/timeline';
import type { MediaStore } from './MediaStore';

export interface ScheduleOptions {
  /** タイムラインの時刻 from からを並べる（それより前は切り捨て） */
  from: number;
  /** ここまで（秒） */
  to: number;
  /** タイムラインの時刻 → オーディオコンテキストの時刻 */
  toCtxTime: (t: number) => number;
  /** 出力先 */
  destination: AudioNode;
  /** 途中でやめるとき true を返す */
  isCanceled?: () => boolean;
  /** ノードを1つ置くたびに呼ぶ（再生では、先読みしすぎないよう待つのに使う） */
  afterSchedule?: (ctxWhen: number) => Promise<void>;
  /** 置いたノード（停止用） */
  onNode?: (node: AudioBufferSourceNode) => void;
}

/** 音声区間を並べる。全部並べ終わる（またはキャンセルされる）と戻る */
export async function scheduleSegments(ctx: BaseAudioContext, media: MediaStore, segments: AudioSegment[], o: ScheduleOptions): Promise<void> {
  for (const seg of segments) {
    if (o.isCanceled?.()) return;
    if (seg.end <= o.from || seg.start >= o.to) continue;
    const entry = media.get(seg.mediaId);
    if (!entry?.audio) continue;
    const segFrom = Math.max(o.from, seg.start);
    const segTo = Math.min(o.to, seg.end);
    const srcFrom = seg.sourceStart + (segFrom - seg.start) * seg.speed;
    const srcTo = seg.sourceStart + (segTo - seg.start) * seg.speed;
    const lower = o.toCtxTime(segFrom);
    const upper = o.toCtxTime(segTo);
    const gain = ctx.createGain();
    gain.gain.value = seg.volume;
    gain.connect(o.destination);
    const sink = new AudioBufferSink(entry.audio);
    for await (const b of sink.buffers(srcFrom, srcTo)) {
      if (o.isCanceled?.()) return;
      // バッファの先頭がタイムライン上でいつになるか
      const tl = seg.start + (b.timestamp - seg.sourceStart) / seg.speed;
      let when = o.toCtxTime(tl);
      let offset = 0;
      if (when < lower) {
        offset = (lower - when) * seg.speed;
        when = lower;
      }
      if (offset >= b.duration || when >= upper) continue;
      const node = ctx.createBufferSource();
      node.buffer = b.buffer;
      node.playbackRate.value = seg.speed;
      node.connect(gain);
      node.start(when, offset);
      node.stop(upper);
      o.onNode?.(node);
      await o.afterSchedule?.(when);
    }
  }
}
