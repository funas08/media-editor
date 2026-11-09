// 動画・音声ファイルの保管庫。ファイルはブラウザの中で参照するだけで、外部には送らない。
// Mediabunny の Input を使って中身（長さ・解像度・音声の有無など）を調べ、デコード用のトラックを持つ。
// 画像の AssetStore と同じく、Undo で戻せるようセッション中は原則として削除しない。

import { ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, Input, MP4, QTFF, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';
import type { SourceColorSpace } from './encodeSettings';
import type { SourceVideoMeta } from './smartCopy';
import type { CopySource } from './smartExport';
import { newId } from '../core/doc';

export interface MediaInfo {
  id: string;
  /** 映像のある動画か、音声だけ（音楽）か */
  kind: 'video' | 'audio';
  name: string;
  /** ファイルの大きさと更新日時（プロジェクトを開くときの照合用） */
  size: number;
  lastModified: number;
  /** 長さ（秒） */
  duration: number;
  /** 表示上の幅・高さ（回転・画素の縦横比を反映） */
  width: number;
  height: number;
  /** フレームレート（おおよそ） */
  fps: number;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  /** 映像のビットレート（bps）。分からなければ null */
  videoBitrate: number | null;
  /** videoBitrate がファイルサイズからの見積もりなら true（MP4 / MOV 以外） */
  bitrateEstimated: boolean;
  /** 映像のコーデック文字列（例：avc1.640033。プロファイルとレベルが分かる） */
  codecString: string | null;
  /** 映像の色空間 */
  colorSpace: SourceColorSpace | null;
  /** キーフレームの間隔（秒、先頭付近から求めた中央値）。分からなければ null */
  keyFrameInterval: number | null;
}

export interface MediaEntry {
  info: MediaInfo;
  file: Blob;
  input: Input;
  /** 映像トラック（音楽なら null） */
  video: InputVideoTrack | null;
  /** デコードできる音声トラック（なければ null） */
  audio: InputAudioTrack | null;
}

/** 読み込めなかった理由（日本語） */
export class MediaLoadError extends Error {}

export function isVideoFile(f: File): boolean {
  return f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name);
}

export function isAudioFile(f: File): boolean {
  return f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i.test(f.name);
}

/**
 * 映像のビットレート。MP4 / MOV はファイルの索引から全体の平均を正確に求める（中身は読まないので速い）。
 * それ以外はファイルサイズと長さから見積もる（音声ぶんとして 192kbps を引く）
 */
async function videoBitrate(input: Input, video: InputVideoTrack, size: number, duration: number, hasAudio: boolean): Promise<{ bitrate: number; estimated: boolean } | null> {
  try {
    const format = await input.getFormat();
    if (format === MP4 || format === QTFF) {
      const s = await video.computePacketStats();
      if (s.averageBitrate > 0) return { bitrate: s.averageBitrate, estimated: false };
    }
  } catch {
    // 見積もりに切り替える
  }
  if (!(duration > 0)) return null;
  const total = (size * 8) / duration - (hasAudio ? 192_000 : 0);
  return total > 0 ? { bitrate: total, estimated: true } : null;
}

/** キーフレームの間隔（秒）。先頭から最大 8 個のキーフレームの間隔の中央値（中身は読まない） */
async function keyFrameInterval(video: InputVideoTrack): Promise<number | null> {
  const sink = new EncodedPacketSink(video);
  const opts = { metadataOnly: true };
  let p = await sink.getFirstPacket(opts);
  if (p && p.type !== 'key') p = await sink.getNextKeyPacket(p, opts);
  const gaps: number[] = [];
  for (let i = 0; p && i < 8; i++) {
    const next = await sink.getNextKeyPacket(p, opts);
    if (!next) break;
    gaps.push(next.timestamp - p.timestamp);
    p = next;
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** 全部のキーフレームの時刻（中身は読まない。MP4 は索引から読むので速い） */
async function allKeyTimes(video: InputVideoTrack): Promise<number[]> {
  const sink = new EncodedPacketSink(video);
  const opts = { metadataOnly: true };
  const out: number[] = [];
  let p = await sink.getFirstKeyPacket(opts);
  while (p) {
    out.push(p.timestamp);
    p = await sink.getNextKeyPacket(p, opts);
  }
  return out.sort((a, b) => a - b);
}

export class MediaStore {
  private entries = new Map<string, MediaEntry>();
  /** 無劣化コピーの判定に使う情報（調べるのに少し時間がかかるので、最初に必要になったときに作って覚えておく） */
  private smartMetas = new Map<string, Promise<SourceVideoMeta | null>>();

  /** ファイルを調べて登録する。読めない場合は MediaLoadError */
  async add(file: File, id: string = newId('media')): Promise<MediaEntry> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    try {
      if (!(await input.canRead())) throw new MediaLoadError('対応していない形式です');
      const video = await input.getPrimaryVideoTrack();
      if (video && !(await video.canDecode())) {
        throw new MediaLoadError(`このブラウザでは映像（${video.codec ?? '不明な形式'}）をデコードできません`);
      }
      const audioTrack = await input.getPrimaryAudioTrack();
      const audio = audioTrack && (await audioTrack.canDecode()) ? audioTrack : null;
      if (!video && !audio) {
        throw new MediaLoadError(audioTrack ? `このブラウザでは音声（${audioTrack.codec ?? '不明な形式'}）をデコードできません` : '映像も音声も入っていません');
      }
      const duration = await input.computeDuration();
      if (!(duration > 0)) throw new MediaLoadError('長さを読み取れませんでした');
      const stats = video ? await video.computePacketStats(120) : null;
      const vb = video ? await videoBitrate(input, video, file.size, duration, audio !== null) : null;
      const info: MediaInfo = {
        id,
        kind: video ? 'video' : 'audio',
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        duration,
        width: video ? await video.getDisplayWidth() : 0,
        height: video ? await video.getDisplayHeight() : 0,
        fps: stats && stats.averagePacketRate > 0 ? stats.averagePacketRate : 30,
        hasAudio: audio !== null,
        videoCodec: video?.codec ?? null,
        audioCodec: audio?.codec ?? null,
        videoBitrate: vb?.bitrate ?? null,
        bitrateEstimated: vb?.estimated ?? false,
        codecString: video ? await video.getCodecParameterString().catch(() => null) : null,
        colorSpace: video ? await video.getColorSpace().catch(() => null) : null,
        keyFrameInterval: video ? await keyFrameInterval(video).catch(() => null) : null,
      };
      const entry: MediaEntry = { info, file, input, video, audio };
      this.entries.set(id, entry);
      return entry;
    } catch (e) {
      input.dispose();
      if (e instanceof MediaLoadError) throw e;
      throw new MediaLoadError('読み込めませんでした（壊れているか、対応していない形式です）');
    }
  }

  /** 素材パネル用の小さなサムネイル（data URL）。音楽は null */
  async thumbnail(id: string, maxSide = 96): Promise<string | null> {
    const e = this.entries.get(id);
    if (!e?.video) return null;
    const k = maxSide / Math.max(e.info.width, e.info.height);
    const sink = new CanvasSink(e.video, { width: Math.max(2, Math.round(e.info.width * k)), height: Math.max(2, Math.round(e.info.height * k)), fit: 'fill' });
    const f = await sink.getCanvas(Math.min(0.5, e.info.duration / 2));
    if (!f) return null;
    const c = document.createElement('canvas');
    c.width = f.canvas.width;
    c.height = f.canvas.height;
    c.getContext('2d')!.drawImage(f.canvas, 0, 0);
    return c.toDataURL('image/jpeg', 0.8);
  }

  /** 無劣化コピーの判定に使う情報（キーフレームの一覧など）。映像がなければ null */
  smartMeta(id: string): Promise<SourceVideoMeta | null> {
    let p = this.smartMetas.get(id);
    if (!p) {
      p = this.loadSmartMeta(id).catch((e) => {
        console.warn('無劣化コピーの情報を読み取れませんでした', e);
        return null;
      });
      this.smartMetas.set(id, p);
    }
    return p;
  }

  private async loadSmartMeta(id: string): Promise<SourceVideoMeta | null> {
    const e = this.entries.get(id);
    if (!e?.video) return null;
    const v = e.video;
    const cs = e.info.colorSpace;
    const hdr = (await v.hasHighDynamicRange().catch(() => false)) || cs?.primaries === 'bt2020' || cs?.transfer === 'pq' || cs?.transfer === 'hlg';
    const audioConfig = e.audio ? await e.audio.getDecoderConfig().catch(() => null) : null;
    return {
      codecString: e.info.codecString,
      width: e.info.width,
      height: e.info.height,
      fps: e.info.fps,
      rotation: await v.getRotation().catch(() => 0),
      hdr,
      keyTimes: await allKeyTimes(v),
      endTime: await v.computeDuration(),
      audio: e.audio ? { codec: e.audio.codec ?? null, sampleRate: audioConfig?.sampleRate ?? e.audio.sampleRate, channels: audioConfig?.numberOfChannels ?? e.audio.numberOfChannels } : null,
    };
  }

  /** 無劣化コピーで元のパケットを読むための部品 */
  async copySource(id: string): Promise<CopySource | null> {
    const e = this.entries.get(id);
    if (!e?.video) return null;
    const dc = await e.video.getDecoderConfig();
    const d = dc?.description;
    const description = !d ? null : d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
    return {
      video: new EncodedPacketSink(e.video),
      description,
      codecString: dc?.codec ?? e.info.codecString,
      endTime: await e.video.computeDuration(),
      audio: e.audio ? new EncodedPacketSink(e.audio) : null,
      audioConfig: e.audio ? await e.audio.getDecoderConfig() : null,
    };
  }

  get(id: string): MediaEntry | undefined {
    return this.entries.get(id);
  }

  all(): MediaEntry[] {
    return [...this.entries.values()];
  }

  /** 指定した ID 以外を解放する（新しいドキュメントにしたとき） */
  retainOnly(ids: ReadonlySet<string>): void {
    for (const [id, e] of this.entries) {
      if (ids.has(id)) continue;
      e.input.dispose();
      this.entries.delete(id);
      this.smartMetas.delete(id);
    }
  }
}
