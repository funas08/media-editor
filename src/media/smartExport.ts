// 無劣化コピー（スマートレンダリング）の書き出し（ブラウザに依存しない部分。Node のテストでも動く）。
//
// - コピーの区間：元動画の圧縮データ（パケット）をそのまま映像トラックに入れる
// - 再エンコードの区間：フレームを描いて「区間用のエンコーダー」で圧縮し、できたパケットを入れる。
//   区間ごとにエンコーダーを作り直すので、どの区間もキーフレームから始まる
// - 元動画とエンコーダーでデコードの設定（SPS / PPS）が違うので、すべてのキーフレームに設定を入れる（nal.ts）
// - 音声は「全体をそのままコピー」か「全体をエンコード」のどちらか（AudioFeed）

import {
  AudioSampleSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  NullTarget,
  Output,
  Quality,
  VideoSampleSource,
  type AudioSample,
  type EncodedPacketSink,
  type Target,
  type VideoSample,
} from 'mediabunny';
import { ExportCanceledError } from './exportPipeline';
import { buildDecoderRecord, firstSliceType, isParamSet, isRandomAccess, nalType, normalizePacket, parseDecoderRecord, splitLengthPrefixed, withLengthSize4, type NalCodec } from './nal';
import type { SmartAudioPart, SmartSection } from './smartCopy';

const EPS = 1e-4;

/** 区間ごとに作るエンコーダー（ブラウザの WebCodecs、または ffmpeg） */
export interface SegmentEncoder {
  /** フレームを渡す（サンプルは呼び出し側が close する） */
  add(sample: VideoSample): Promise<void>;
  /** 残りをすべて出力させる */
  finish(): Promise<void>;
  /** 途中でやめる */
  cancel(): Promise<void>;
  /** できたパケット（デコード順、4 バイトの長さ付き）を取り出す */
  take(): EncodedPacket[];
  /** エンコーダーのデコード設定（avcC / hvcC）。分からなければ null */
  description(): Uint8Array | null;
}

export interface SegmentEncoderInfo {
  width: number;
  height: number;
  fps: number;
  /** つなぎ目を元動画と同じプロファイルで作るときのコーデック文字列 */
  codecString: string | null;
}

export type SegmentEncoderFactory = (info: SegmentEncoderInfo) => Promise<SegmentEncoder>;

/** コピー元の動画 */
export interface CopySource {
  video: EncodedPacketSink | null;
  /** 映像のデコード設定（avcC / hvcC） */
  description: Uint8Array | null;
  codecString: string | null;
  /** 映像の終わり（秒） */
  endTime: number;
  audio: EncodedPacketSink | null;
  audioConfig: AudioDecoderConfig | null;
}

/** 音声の作り方 */
export interface AudioFeed {
  /** 出力に音声トラックを加える（output.start の前） */
  attach(output: Output): void;
  /** 時刻 t（秒）まで音声を渡す */
  fillTo(t: number): Promise<void>;
  /** 最後まで渡す */
  finish(): Promise<void>;
  cancel?(): Promise<void>;
}

export interface SmartExportPlan {
  width: number;
  height: number;
  fps: number;
  codec: NalCodec;
  duration: number;
  sections: SmartSection[];
  sources: ReadonlyMap<string, CopySource>;
  /** 出力の映像トラックの色空間（MP4 の colr） */
  colorSpace?: VideoColorSpaceInit;
  /** コピーするときのコーデック文字列（再エンコードのつなぎ目もこのプロファイル） */
  codecString: string | null;
  /** トラックの設定に使う元動画（コピーがなければ null） */
  primaryMediaId: string | null;
}

export interface SmartExportCallbacks {
  /** 書き出す動画の時刻 t のフレーム（duration はそのフレームの長さ） */
  renderFrame(t: number, duration: number): Promise<VideoSample>;
  encoder: SegmentEncoderFactory;
  audio: AudioFeed | null;
  onProgress?(ratio: number): void;
  signal?: AbortSignal;
}

/** 実際に処理する単位：コピー、または 1 つのエンコーダーで作る再エンコード */
type Job = { kind: 'copy'; section: Extract<SmartSection, { kind: 'copy' }> } | { kind: 'render'; times: number[]; end: number };

/** 書き出しの内訳（完了時の表示・テスト用） */
export interface SmartExportStats {
  copiedSeconds: number;
  encodedSeconds: number;
  copiedPackets: number;
  encodedPackets: number;
  /** 書き出し前の確認で、コピーをやめた区間（キーフレームが IDR でないなど） */
  demotedSections: number;
}

/** 元動画のフレームの時刻（presentation）のうち [from, to) のもの */
async function sourceFrameTimes(sink: EncodedPacketSink, from: number, to: number): Promise<number[]> {
  const opts = { metadataOnly: true };
  const start = (await sink.getKeyPacket(from + EPS, opts)) ?? (await sink.getFirstPacket(opts));
  if (!start) return [];
  const out: number[] = [];
  let stopAt: number | null = null;
  for await (const p of sink.packets(start, undefined, opts)) {
    if (stopAt !== null) {
      // 次のキーフレームより前に表示されるフレーム（オープン GOP の先行フレーム）までは見る
      if (p.type === 'key' || p.timestamp >= stopAt) break;
    } else if (p.type === 'key' && p.timestamp >= to - EPS) {
      stopAt = p.timestamp;
      continue;
    }
    if (p.timestamp >= from - EPS && p.timestamp < to - EPS) out.push(p.timestamp);
  }
  return out.sort((a, b) => a - b);
}

/** 区間のフレームの時刻（書き出す動画の秒） */
async function renderTimes(plan: SmartExportPlan, s: Extract<SmartSection, { kind: 'render' }>): Promise<number[]> {
  let times: number[] = [];
  if (s.frames === 'grid') {
    for (let k = 0; ; k++) {
      const t = s.start + k / plan.fps;
      if (t >= s.end - EPS) break;
      times.push(t);
    }
  } else {
    const f = s.frames;
    const sink = plan.sources.get(f.mediaId)?.video;
    if (sink) times = (await sourceFrameTimes(sink, f.srcFrom, f.srcTo)).map((t) => t + f.offset).filter((t) => t >= s.start - EPS && t < s.end - EPS);
  }
  // 区間の先頭には必ずフレームを置く（その時刻に表示されているフレーム）
  if (times.length === 0 || times[0] > s.start + EPS) times.unshift(s.start);
  else times[0] = s.start;
  return times;
}

/**
 * 区間の一覧を処理単位にする。コピーの区間は、キーフレームが本当にデコードを始められるフレーム（IDR / IRAP）かを確かめ、
 * そうでなければ再エンコードに回す。隣り合う再エンコードは 1 つのエンコーダーにまとめる
 */
async function buildJobs(plan: SmartExportPlan): Promise<{ jobs: Job[]; demoted: number }> {
  const jobs: Job[] = [];
  let demoted = 0;
  const pushRender = (times: number[], end: number) => {
    const last = jobs[jobs.length - 1];
    if (last?.kind === 'render') {
      last.times.push(...times.filter((t) => t > (last.times[last.times.length - 1] ?? -Infinity) + EPS));
      last.end = end;
    } else {
      jobs.push({ kind: 'render', times, end });
    }
  };
  for (const s of plan.sections) {
    if (s.kind === 'render') {
      pushRender(await renderTimes(plan, s), s.end);
      continue;
    }
    if (await copyStartOk(plan, s)) {
      jobs.push({ kind: 'copy', section: s });
    } else {
      demoted++;
      pushRender(await renderTimes(plan, { kind: 'render', start: s.start, end: s.end, frames: { mediaId: s.mediaId, offset: s.offset, srcFrom: s.srcFrom, srcTo: s.srcTo } }), s.end);
    }
  }
  return { jobs, demoted };
}

/** コピーの区間の先頭が、そこからデコードを始められるキーフレームか */
async function copyStartOk(plan: SmartExportPlan, s: Extract<SmartSection, { kind: 'copy' }>): Promise<boolean> {
  const src = plan.sources.get(s.mediaId);
  if (!src?.video || !src.description) return false;
  const rec = parseDecoderRecord(plan.codec, src.description);
  if (!rec) return false;
  const key = await src.video.getKeyPacket(s.srcFrom + EPS);
  if (!key || Math.abs(key.timestamp - s.srcFrom) > 1e-3) return false;
  const t = firstSliceType(plan.codec, splitLengthPrefixed(key.data, rec.lengthSize));
  return t !== null && isRandomAccess(plan.codec, t);
}

/** 無劣化コピーと再エンコードを組み合わせて書き出す */
export async function runSmartExport(plan: SmartExportPlan, target: Target, cb: SmartExportCallbacks): Promise<SmartExportStats> {
  const { jobs, demoted } = await buildJobs(plan);
  const stats: SmartExportStats = { copiedSeconds: 0, encodedSeconds: 0, copiedPackets: 0, encodedPackets: 0, demotedSections: demoted };
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const video = new EncodedVideoPacketSource(plan.codec);
  output.addVideoTrack(video);
  cb.audio?.attach(output);
  await output.start();

  const primary = plan.primaryMediaId ? plan.sources.get(plan.primaryMediaId) : undefined;
  let trackConfig: VideoDecoderConfig | null = null;
  if (primary?.description && plan.codecString) {
    trackConfig = { codec: plan.codecString, codedWidth: plan.width, codedHeight: plan.height, description: withLengthSize4(plan.codec, primary.description), colorSpace: plan.colorSpace };
  }
  let seq = 0;
  const addVideo = async (p: EncodedPacket, fallbackDesc: Uint8Array | null, fallbackCodec: string) => {
    let meta: EncodedVideoChunkMetadata | undefined;
    if (seq === 0) {
      if (!trackConfig) {
        const desc = fallbackDesc ?? buildDecoderRecord(plan.codec, splitLengthPrefixed(p.data).filter((n) => isParamSet(plan.codec, nalType(plan.codec, n))));
        if (!desc) throw new Error('映像のデコード設定（SPS / PPS）が見つかりませんでした');
        trackConfig = { codec: fallbackCodec, codedWidth: plan.width, codedHeight: plan.height, description: desc, colorSpace: plan.colorSpace };
      }
      meta = { decoderConfig: trackConfig };
    }
    await cb.audio?.fillTo(p.timestamp + 1);
    await video.add(p.clone({ sequenceNumber: seq++ }), meta);
  };
  const aborted = () => {
    if (cb.signal?.aborted) throw new ExportCanceledError();
  };
  const progress = (t: number) => cb.onProgress?.(plan.duration > 0 ? Math.min(1, t / plan.duration) : 1);

  let current: SegmentEncoder | null = null;
  try {
    for (const job of jobs) {
      aborted();
      if (job.kind === 'copy') {
        const s = job.section;
        const src = plan.sources.get(s.mediaId)!;
        const rec = parseDecoderRecord(plan.codec, src.description!)!;
        const sink = src.video!;
        const start = await sink.getKeyPacket(s.srcFrom + EPS);
        const endKey = s.srcTo < src.endTime - EPS ? await sink.getKeyPacket(s.srcTo + EPS) : null;
        let n = 0;
        for await (const p of sink.packets(start!, endKey && endKey.timestamp > start!.timestamp ? endKey : undefined)) {
          // 先頭のキーフレームより前に表示されるフレーム（前の GOP を参照しうる先行フレーム）は捨てる。その時刻は前の区間が描く
          if (p.timestamp < s.srcFrom - EPS || p.timestamp >= s.srcTo - EPS) continue;
          const data = normalizePacket(plan.codec, splitLengthPrefixed(p.data, rec.lengthSize), p.type === 'key', rec.paramSets);
          await addVideo(p.clone({ data, timestamp: p.timestamp + s.offset }), null, plan.codecString ?? '');
          if (++n % 30 === 0) {
            aborted();
            progress(p.timestamp + s.offset);
          }
        }
        stats.copiedPackets += n;
        stats.copiedSeconds += s.end - s.start;
        progress(s.end);
        continue;
      }
      // 再エンコード
      const enc = await cb.encoder({ width: plan.width, height: plan.height, fps: plan.fps, codecString: plan.codecString });
      current = enc;
      const drain = async () => {
        for (const p of enc.take()) {
          const rec = enc.description();
          const sets = rec ? (parseDecoderRecord(plan.codec, rec)?.paramSets ?? []) : [];
          const data = normalizePacket(plan.codec, splitLengthPrefixed(p.data), p.type === 'key', sets);
          await addVideo(p.clone({ data }), rec, plan.codecString ?? defaultCodecString(plan.codec));
          stats.encodedPackets++;
        }
      };
      for (let i = 0; i < job.times.length; i++) {
        aborted();
        const t = job.times[i];
        const dur = (i + 1 < job.times.length ? job.times[i + 1] : job.end) - t;
        await cb.audio?.fillTo(t + 1);
        const frame = await cb.renderFrame(t, dur);
        try {
          await enc.add(frame);
        } finally {
          frame.close();
        }
        await drain();
        progress(t + dur);
      }
      await enc.finish();
      await drain();
      current = null;
      stats.encodedSeconds += job.end - (job.times[0] ?? job.end);
    }
    await cb.audio?.fillTo(plan.duration);
    await cb.audio?.finish();
    aborted();
    await output.finalize();
    progress(plan.duration);
    return stats;
  } catch (e) {
    await current?.cancel().catch(() => undefined);
    await cb.audio?.cancel?.().catch(() => undefined);
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    throw e;
  }
}

/** コーデック文字列が分からないときの値（MP4 の箱の名前を決めるのに使われる） */
function defaultCodecString(codec: NalCodec): string {
  return codec === 'avc' ? 'avc1.640033' : 'hvc1.1.6.L153.90';
}

// ---- 区間用のエンコーダー（Mediabunny のエンコーダー = ブラウザの WebCodecs） ----

export interface MediabunnyEncoderOptions {
  codec: NalCodec;
  bitrate: number;
  quantizer?: number | null;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  keyFrameInterval?: number;
  onEncoderConfig?: (config: VideoEncoderConfig) => void;
}

/**
 * Mediabunny の VideoSampleSource をエンコーダーとして使う（中身は捨てる出力につなぎ、できたパケットだけを受け取る）
 */
export function mediabunnyEncoderFactory(o: MediabunnyEncoderOptions): SegmentEncoderFactory {
  return async (info) => {
    const packets: EncodedPacket[] = [];
    let desc: Uint8Array | null = null;
    let lengthSize = 4;
    const output = new Output({ format: new Mp4OutputFormat(), target: new NullTarget() });
    const src = new VideoSampleSource({
      codec: o.codec,
      fullCodecString: info.codecString ?? undefined,
      quality: new Quality(o.quantizer != null ? { quantizer: o.quantizer, bitrate: o.bitrate, bitrateMode: 'variable' } : { bitrate: o.bitrate, bitrateMode: 'variable' }),
      latencyMode: 'quality',
      hardwareAcceleration: o.hardwareAcceleration ?? 'no-preference',
      keyFrameInterval: o.keyFrameInterval ?? 2,
      sizeChangeBehavior: 'deny',
      onEncoderConfig: o.onEncoderConfig,
      onEncodedPacket: (p, meta) => {
        const d = meta?.decoderConfig?.description;
        if (d) {
          const bytes = d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
          desc = withLengthSize4(o.codec, bytes);
          lengthSize = parseDecoderRecord(o.codec, bytes)?.lengthSize ?? 4;
        }
        // 長さの欄を 4 バイトにそろえる
        const data = lengthSize === 4 ? p.data : normalizePacket(o.codec, splitLengthPrefixed(p.data, lengthSize), false, []);
        packets.push(p.clone({ data }));
      },
    });
    output.addVideoTrack(src);
    await output.start();
    return {
      add: (sample) => src.add(sample),
      finish: async () => {
        await output.finalize();
      },
      cancel: async () => {
        if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
      },
      take: () => packets.splice(0),
      description: () => desc,
    };
  };
}

// ---- 音声 ----

/** 元の AAC をそのままコピーする */
export function copyAudioFeed(parts: SmartAudioPart[], sources: ReadonlyMap<string, CopySource>): AudioFeed {
  const first = sources.get(parts[0]?.mediaId ?? '');
  const config = first?.audioConfig;
  if (!config) throw new Error('コピーする音声の設定が見つかりません');
  const src = new EncodedAudioPacketSource('aac');
  let started = false;
  let prevEnd = 0;
  let done = 0;
  let partIndex = 0;
  let iter: AsyncGenerator<EncodedPacket, void, unknown> | null = null;
  /** 次に渡すパケット（書き出しの時刻に直したもの） */
  let pending: EncodedPacket | null = null;

  const next = async (): Promise<EncodedPacket | null> => {
    for (;;) {
      const part = parts[partIndex];
      if (!part) return null;
      const sink = sources.get(part.mediaId)?.audio;
      if (!sink) throw new Error('コピーする音声が見つかりません');
      if (!iter) {
        const start = (await sink.getPacket(part.srcFrom)) ?? (await sink.getFirstPacket());
        if (!start) {
          partIndex++;
          continue;
        }
        iter = sink.packets(start);
      }
      const r = await iter.next();
      if (r.done || r.value.timestamp >= part.srcTo - EPS) {
        await iter.return();
        iter = null;
        partIndex++;
        continue;
      }
      const p = r.value;
      let ts = p.timestamp + part.offset;
      // 前のパケットと半分以上重なるものは捨て、少しだけ重なるものは後ろにずらす（つなぎ目のずれは半フレーム以内）
      if (ts < prevEnd - p.duration / 2) continue;
      ts = Math.max(ts, prevEnd);
      prevEnd = ts + p.duration;
      return p.clone({ timestamp: ts });
    }
  };

  const fillTo = async (t: number) => {
    while (done < t) {
      pending ??= await next();
      if (!pending) {
        done = Infinity;
        return;
      }
      await src.add(pending, started ? undefined : { decoderConfig: config });
      started = true;
      done = pending.timestamp + pending.duration;
      pending = null;
    }
  };

  return {
    attach: (output) => output.addAudioTrack(src),
    fillTo,
    finish: () => fillTo(Infinity),
    cancel: async () => {
      await iter?.return();
    },
  };
}

/** 音声を作ってエンコードする（Web Audio のミックス → AAC） */
export function encodeAudioFeed(o: { bitrate: number; duration: number; render: (t0: number, t1: number) => Promise<AudioSample> }): AudioFeed {
  const src = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: o.bitrate }) });
  let done = 0;
  const fill = async (t: number) => {
    while (done < Math.min(t, o.duration) - 1e-9) {
      const t1 = Math.min(o.duration, done + 1);
      const s = await o.render(done, t1);
      try {
        await src.add(s);
      } finally {
        s.close();
      }
      done = t1;
    }
  };
  return {
    attach: (output) => output.addAudioTrack(src),
    fillTo: fill,
    finish: () => fill(o.duration),
  };
}
