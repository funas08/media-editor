// 動画書き出しのブラウザ側の処理：原寸の OffscreenCanvas にフレームを描き、Web Audio で音声をミックスする。
// 書き出し先は File System Access API で選んだファイルに少しずつ書き込む（選べない場合はダウンロード）。

import {
  AudioSample,
  BufferTarget,
  CanvasSink,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  StreamTarget,
  VideoSample,
  canEncodeAudio,
  canEncodeVideo,
  type Quality,
  type Target,
} from 'mediabunny';
import type { AssetStore } from '../core/AssetStore';
import { activeClipAt, audioSegments, totalDuration } from '../core/timeline';
import type { DocState, VideoItem } from '../core/types';
import type { FrameImage, VideoFrameProvider } from '../render/itemRenderers';
import { drawScene } from '../render/scene';
import { scheduleSegments } from './audioSchedule';
import { runExport, type ExportPlan } from './exportPipeline';
import type { MediaStore } from './MediaStore';
import { SequentialFrames } from './SequentialFrames';

export type VideoQuality = 'medium' | 'high' | 'very_high';

export interface VideoExportOptions {
  /** キャンバスに対する倍率（1 / 1.5 / 2） */
  scale: number;
  fps: 30 | 60;
  quality: VideoQuality;
  includeAudio: boolean;
}

export const QUALITY_LABEL: Record<VideoQuality, string> = { medium: '標準', high: '高', very_high: '最高' };
const QUALITY_VALUE: Record<VideoQuality, Quality> = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, very_high: QUALITY_VERY_HIGH };
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** 書き出しサイズ（H.264 は幅・高さが偶数である必要があるので切り下げる） */
export function videoExportSize(doc: DocState, scale: number): { width: number; height: number; adjusted: boolean } {
  const w = Math.round(doc.canvas.width * scale);
  const h = Math.round(doc.canvas.height * scale);
  const width = Math.max(2, w - (w % 2));
  const height = Math.max(2, h - (h % 2));
  return { width, height, adjusted: width !== w || height !== h };
}

/** この環境で書き出せるか（映像：H.264、音声：AAC） */
export async function checkVideoSupport(doc: DocState, o: VideoExportOptions): Promise<{ video: boolean; audio: boolean }> {
  const { width, height } = videoExportSize(doc, o.scale);
  const [video, audio] = await Promise.all([
    canEncodeVideo('avc', { width, height, bitrate: QUALITY_VALUE[o.quality] }).catch(() => false),
    canEncodeAudio('aac', { numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE, bitrate: QUALITY_VALUE[o.quality] }).catch(() => false),
  ]);
  return { video, audio };
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

  /** 時刻 t に表示するクリップのフレームを用意する */
  async prepare(doc: DocState, t: number): Promise<void> {
    this.ready.clear();
    const a = activeClipAt(doc, t);
    if (!a) return;
    const item = a.span.item;
    let seq = this.seqs.get(item.mediaId);
    if (!seq) {
      const entry = this.media.get(item.mediaId);
      if (!entry) return;
      seq = new SequentialFrames(new CanvasSink(entry.video, { poolSize: 4 }));
      this.seqs.set(item.mediaId, seq);
    }
    const f = await seq.frameAt(a.sourceTime);
    if (f) this.ready.set(item.id, { image: f.canvas, width: f.canvas.width, height: f.canvas.height });
  }

  frameFor(item: VideoItem): FrameImage | null {
    return this.ready.get(item.id) ?? null;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.seqs.values()].map((s) => s.dispose()));
  }
}

/** 時刻 t0〜t1 の音声をミックスする（Web Audio のオフライン描画） */
async function renderAudioWindow(doc: DocState, media: MediaStore, t0: number, t1: number): Promise<AudioSample> {
  const frames = Math.max(1, Math.round((t1 - t0) * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(CHANNELS, frames, SAMPLE_RATE);
  await scheduleSegments(ctx, media, audioSegments(doc), { from: t0, to: t1, toCtxTime: (t) => t - t0, destination: ctx.destination });
  const buf = await ctx.startRendering();
  const data = new Float32Array(frames * CHANNELS);
  for (let c = 0; c < CHANNELS; c++) data.set(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).subarray(0, frames), c * frames);
  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE, timestamp: t0 });
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
): Promise<void> {
  const { width, height } = videoExportSize(doc, o.scale);
  const plan: ExportPlan = {
    width,
    height,
    fps: o.fps,
    duration: totalDuration(doc),
    videoCodec: 'avc',
    videoBitrate: QUALITY_VALUE[o.quality],
    audio: o.includeAudio ? { bitrate: QUALITY_VALUE[o.quality], sampleRate: SAMPLE_RATE, channels: CHANNELS } : null,
  };
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('書き出し用の Canvas を作成できませんでした');
  const frames = new ExportFrames(media);
  try {
    await runExport(plan, target, {
      signal,
      onProgress,
      renderFrame: async (t) => {
        await frames.prepare(doc, t);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // 動画は透明を持てないので、キャンバスの外側や透明部分は黒にする
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.setTransform(width / doc.canvas.width, 0, 0, height / doc.canvas.height, 0, 0);
        drawScene(ctx, doc, { assets, pixelScale: width / doc.canvas.width, time: t, frames });
        return new VideoSample(canvas, { timestamp: t, duration: 1 / o.fps });
      },
      renderAudio: plan.audio ? (t0, t1) => renderAudioWindow(doc, media, t0, t1) : undefined,
    });
  } finally {
    await frames.dispose();
  }
}
