// 動画書き出しのブラウザ側の処理：原寸の OffscreenCanvas にフレームを描き、Web Audio で音声をミックスする。
// 書き出し先は File System Access API で選んだファイルに少しずつ書き込む（選べない場合はダウンロード）。

import { AudioSample, BufferTarget, CanvasSink, Quality, StreamTarget, VideoSample, canEncodeAudio, canEncodeVideo, type Target } from 'mediabunny';
import type { AssetStore } from '../core/AssetStore';
import { audioSegments, clipTimesAt, totalDuration } from '../core/timeline';
import type { DocState, VideoItem } from '../core/types';
import type { FrameImage, VideoFrameProvider } from '../render/itemRenderers';
import { drawScene } from '../render/scene';
import { scheduleSegments } from './audioSchedule';
import { runExport, type ExportPlan } from './exportPipeline';
import type { MediaInfo, MediaStore } from './MediaStore';
import { SequentialFrames } from './SequentialFrames';
import {
  AUDIO_BITRATE,
  DEFAULT_COLOR_SPACE,
  exportKeyFrameInterval as keyFrameFromSource,
  mainVideoMediaIds,
  outputColorSpace,
  pickHighestSource,
  resolveBitrate,
  rgbaToI420,
  standardBitrate,
  type BitrateChoice,
  type EncoderPref,
  type OutputCodec,
  type OutputColorSpace,
  type QualityMode,
  type SourceRate,
} from './encodeSettings';

export type HwAccel = 'no-preference' | 'prefer-hardware' | 'prefer-software';

/** 画質に関わる設定（ダイアログで選ぶもの） */
export interface QualityPrefs {
  /** キャンバスに対する倍率（1 / 1.5 / 2） */
  scale: number;
  fps: 30 | 60;
  /** 画質の選び方 */
  mode: QualityMode;
  /** mode が 'custom' のときのビットレート（Mbps） */
  customMbps: number;
  /** 映像のコーデック */
  codec: OutputCodec;
  /** エンコーダーの選び方 */
  encoder: EncoderPref;
}

export interface VideoExportOptions extends QualityPrefs {
  includeAudio: boolean;
  /** 書き出す範囲（秒）。null ならタイムライン全体 */
  range: { from: number; to: number } | null;
  /** checkVideoSupport で決めた、ハードウェア・ソフトウェアの指定 */
  hardwareAcceleration: HwAccel;
  /** 品質固定を使う（「最高画質」で、checkVideoSupport で使えると分かったとき） */
  useQuantizer: boolean;
}

/** 書き出しで実際に使ったエンコーダーの設定（完了時の表示用） */
export interface EncoderUsed {
  codec: string;
  bitrate: number;
  /** 品質固定で書き出したときの値 */
  quantizer: number | null;
  hardwareAcceleration: string;
  colorSpace: OutputColorSpace;
  keyFrameInterval: number;
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** メインの動画クリップの元動画のビットレートとコーデック */
function mainSources(doc: DocState, media: MediaStore): { rate: SourceRate; info: MediaInfo }[] {
  const out: { rate: SourceRate; info: MediaInfo }[] = [];
  for (const id of mainVideoMediaIds(doc)) {
    const info = media.get(id)?.info;
    if (info?.videoBitrate) out.push({ rate: { bitrate: info.videoBitrate, codec: info.codecString ?? info.videoCodec }, info });
  }
  return out;
}

/** 「元の動画に合わせる」の基準にする元動画（書き出しで最も高いビットレートが必要になるもの） */
export function exportSource(doc: DocState, media: MediaStore, codec: OutputCodec): { rate: SourceRate; info: MediaInfo } | null {
  const list = mainSources(doc, media);
  const best = pickHighestSource(list.map((x) => x.rate), codec);
  return list.find((x) => x.rate === best) ?? null;
}

/** 選んだ画質での映像ビットレート（と品質固定の値） */
export function exportBitrate(doc: DocState, media: MediaStore, o: Pick<QualityPrefs, 'scale' | 'fps' | 'mode' | 'customMbps' | 'codec'>): BitrateChoice {
  const { width, height } = videoExportSize(doc, o.scale);
  return resolveBitrate(o.mode, { width, height, fps: o.fps }, exportSource(doc, media, o.codec)?.rate ?? null, o.customMbps, o.codec);
}

/** キーフレームの間隔：メインの最初の動画に合わせる（1〜5 秒） */
export function exportKeyFrameInterval(doc: DocState, media: MediaStore): number {
  for (const id of mainVideoMediaIds(doc)) {
    const k = media.get(id)?.info.keyFrameInterval;
    if (k) return keyFrameFromSource(k);
  }
  return keyFrameFromSource(null);
}

/** 書き出す動画の色空間：メインの最初の動画（なければ最初の動画）の色空間を引き継ぐ */
export function exportColorSpace(doc: DocState, media: MediaStore): OutputColorSpace {
  const ids = mainVideoMediaIds(doc);
  if (ids.length === 0) for (const it of doc.items) if (it.type === 'video') ids.push(it.mediaId);
  for (const id of ids) {
    const info = media.get(id)?.info;
    if (info) return outputColorSpace(info.colorSpace);
  }
  return { ...DEFAULT_COLOR_SPACE };
}

export interface SupportResult {
  /** 映像を書き出せるか */
  video: boolean;
  /** 音声（AAC）を書き出せるか */
  audio: boolean;
  /** 使うハードウェア・ソフトウェアの指定 */
  hardwareAcceleration: HwAccel;
  /** 品質固定を使えるか（「最高画質」以外では null） */
  quantizer: boolean | null;
  /** コーデックごとに、この環境で書き出せるか */
  codecs: Record<OutputCodec, boolean>;
}

/**
 * この環境で書き出せるか。エンコーダーが「自動」ならハードウェア → 指定なしの順に確かめる。
 * 「最高画質」では、品質固定を使える指定を優先する（どれも使えなければビットレート指定で書き出す）
 */
export async function checkVideoSupport(doc: DocState, media: MediaStore, o: QualityPrefs): Promise<SupportResult> {
  const { width, height } = videoExportSize(doc, o.scale);
  const choice = exportBitrate(doc, media, o);
  const accels: HwAccel[] = o.encoder === 'auto' ? ['prefer-hardware', 'no-preference'] : o.encoder === 'hardware' ? ['prefer-hardware'] : ['prefer-software'];
  const can = (codec: OutputCodec, quality: Quality, hw: HwAccel) =>
    canEncodeVideo(codec, { width, height, quality, frameRate: o.fps, latencyMode: 'quality', hardwareAcceleration: hw }).catch(() => false);
  const codecList: OutputCodec[] = ['avc', 'hevc', 'av1'];
  const [audio, ...codecOk] = await Promise.all([
    canEncodeAudio('aac', { numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE, quality: new Quality({ bitrate: AUDIO_BITRATE }) }).catch(() => false),
    ...codecList.map((c) => can(c, new Quality({ bitrate: standardBitrate(width, height, o.fps, c) }), 'no-preference')),
  ]);
  const codecs = Object.fromEntries(codecList.map((c, i) => [c, codecOk[i]])) as Record<OutputCodec, boolean>;
  if (choice.quantizer !== null) {
    for (const hw of accels) {
      if (await can(o.codec, new Quality({ quantizer: choice.quantizer }), hw)) return { video: true, audio, hardwareAcceleration: hw, quantizer: true, codecs };
    }
  }
  const byBitrate = new Quality({ bitrate: choice.bitrate, bitrateMode: 'variable' });
  for (const hw of accels) {
    if (await can(o.codec, byBitrate, hw)) return { video: true, audio, hardwareAcceleration: hw, quantizer: choice.quantizer === null ? null : false, codecs };
  }
  return { video: false, audio, hardwareAcceleration: accels[0], quantizer: choice.quantizer === null ? null : false, codecs };
}

/** 書き出しサイズ（H.264 は幅・高さが偶数である必要があるので切り下げる） */
export function videoExportSize(doc: DocState, scale: number): { width: number; height: number; adjusted: boolean } {
  const w = Math.round(doc.canvas.width * scale);
  const h = Math.round(doc.canvas.height * scale);
  const width = Math.max(2, w - (w % 2));
  const height = Math.max(2, h - (h % 2));
  return { width, height, adjusted: width !== w || height !== h };
}

/** 書き出し先を選ぶ。キャンセルなら null。選べないブラウザではメモリに書いて最後にダウンロード */
export async function chooseVideoTarget(suggestedName: string): Promise<{ target: Target; finish: () => Promise<void>; abort: () => Promise<void> } | null> {
  type Picker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
  const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({ suggestedName, types: [{ description: 'MP4 動画', accept: { 'video/mp4': ['.mp4'] } }] });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    }
    const writable = await handle.createWritable();
    return {
      target: new StreamTarget(writable, { chunked: true, chunkSize: 16 * 1024 * 1024 }),
      // 完了時は Mediabunny がファイルを閉じる
      finish: async () => {},
      // 途中でやめたときは書きかけのファイルを破棄する
      abort: async () => {
        await writable.abort().catch(() => undefined);
      },
    };
  }
  const target = new BufferTarget();
  return {
    target,
    finish: async () => {
      if (!target.buffer) return;
      const url = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    abort: async () => {},
  };
}

/** 書き出し用の原寸フレーム（動画ごとに時刻順にデコードする） */
class ExportFrames implements VideoFrameProvider {
  private media: MediaStore;
  private seqs = new Map<string, SequentialFrames>();
  private ready = new Map<string, FrameImage>();

  constructor(media: MediaStore) {
    this.media = media;
  }

  /** 時刻 t に表示するすべての動画クリップ（メイン・オーバーレイ）のフレームを用意する（デコーダーはクリップごと） */
  async prepare(doc: DocState, t: number): Promise<void> {
    this.ready.clear();
    for (const [id, ct] of clipTimesAt(doc, t)) {
      const item = doc.items.find((x) => x.id === id);
      if (item?.type !== 'video' || !item.visible) continue;
      let seq = this.seqs.get(item.id);
      if (!seq) {
        const entry = this.media.get(item.mediaId);
        if (!entry?.video) continue;
        seq = new SequentialFrames(new CanvasSink(entry.video, { poolSize: 4 }));
        this.seqs.set(item.id, seq);
      }
      const f = await seq.frameAt(ct.source);
      if (f) this.ready.set(item.id, { image: f.canvas, width: f.canvas.width, height: f.canvas.height });
    }
  }

  frameFor(item: VideoItem): FrameImage | null {
    return this.ready.get(item.id) ?? null;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.seqs.values()].map((s) => s.dispose()));
  }
}

/** 時刻 t0〜t1 の音声をミックスする（Web Audio のオフライン描画） */
async function renderAudioWindow(doc: DocState, media: MediaStore, t0: number, t1: number, timestamp: number): Promise<AudioSample> {
  const frames = Math.max(1, Math.round((t1 - t0) * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(CHANNELS, frames, SAMPLE_RATE);
  await scheduleSegments(ctx, media, audioSegments(doc), { from: t0, to: t1, toCtxTime: (t) => t - t0, destination: ctx.destination });
  const buf = await ctx.startRendering();
  const data = new Float32Array(frames * CHANNELS);
  for (let c = 0; c < CHANNELS; c++) data.set(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).subarray(0, frames), c * frames);
  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE, timestamp });
}

/** 動画を書き出す */
export async function exportVideo(
  doc: DocState,
  assets: AssetStore,
  media: MediaStore,
  o: VideoExportOptions,
  target: Target,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
): Promise<EncoderUsed> {
  const { width, height } = videoExportSize(doc, o.scale);
  const choice = exportBitrate(doc, media, o);
  const colorSpace = exportColorSpace(doc, media);
  const keyFrameInterval = exportKeyFrameInterval(doc, media);
  const quantizer = o.useQuantizer ? choice.quantizer : null;
  const used: EncoderUsed = { codec: o.codec, bitrate: choice.bitrate, quantizer, hardwareAcceleration: o.hardwareAcceleration, colorSpace, keyFrameInterval };
  // 範囲（I〜O）を書き出すときは、その開始を 0 秒として書き出す
  const from = o.range ? o.range.from : 0;
  const to = o.range ? o.range.to : totalDuration(doc);
  const plan: ExportPlan = {
    width,
    height,
    fps: o.fps,
    duration: Math.max(0, to - from),
    videoCodec: o.codec,
    videoBitrate: choice.bitrate,
    videoQuantizer: quantizer,
    keyFrameInterval,
    hardwareAcceleration: o.hardwareAcceleration,
    audio: o.includeAudio ? { bitrate: AUDIO_BITRATE, sampleRate: SAMPLE_RATE, channels: CHANNELS } : null,
    colorSpace,
    // 候補ごとに呼ばれ、最後に呼ばれたものが実際に使われる設定（品質固定が使えずビットレート指定になった場合など）
    onEncoderConfig: (c) => {
      used.codec = c.codec;
      used.quantizer = c.bitrateMode === 'quantizer' ? quantizer : null;
      console.info('動画のエンコーダー設定', c);
    },
  };
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('書き出し用の Canvas を作成できませんでした');
  // I420 の作業用（フレームごとに使い回す。VideoSample が中身を複製する）
  let yuv: Uint8Array | undefined;
  const frames = new ExportFrames(media);
  try {
    await runExport(plan, target, {
      signal,
      onProgress,
      renderFrame: async (t0) => {
        const t = from + t0;
        await frames.prepare(doc, t);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // 動画は透明を持てないので、キャンバスの外側や透明部分は黒にする
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.setTransform(width / doc.canvas.width, 0, 0, height / doc.canvas.height, 0, 0);
        drawScene(ctx, doc, { assets, pixelScale: width / doc.canvas.width, time: t, frames });
        // 色空間を明示した YUV（I420）にしてエンコーダーへ渡す。Canvas のまま渡すと sRGB の RGB として扱われ、
        // ブラウザ内の変換（行列・レンジ）次第で色が変わることがあるため
        const rgba = ctx.getImageData(0, 0, width, height).data;
        yuv = rgbaToI420(rgba, width, height, colorSpace, yuv);
        return new VideoSample(yuv, { format: 'I420', codedWidth: width, codedHeight: height, timestamp: t0, duration: 1 / o.fps, colorSpace });
      },
      renderAudio: plan.audio ? (a, b) => renderAudioWindow(doc, media, from + a, from + b, a) : undefined,
    });
  } finally {
    await frames.dispose();
  }
  return used;
}
