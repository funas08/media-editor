// 動画・音声ファイルの保管庫。ファイルはブラウザの中で参照するだけで、外部には送らない。
// Mediabunny の Input を使って中身（長さ・解像度・音声の有無など）を調べ、デコード用のトラックを持つ。
// 画像の AssetStore と同じく、Undo で戻せるようセッション中は原則として削除しない。

import { ALL_FORMATS, BlobSource, CanvasSink, Input, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';
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

export class MediaStore {
  private entries = new Map<string, MediaEntry>();

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
    }
  }
}
