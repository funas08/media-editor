// 動画・音声ファイルの保管庫。ファイルはブラウザの中で参照するだけで、外部には送らない。
// Mediabunny の Input を使って中身（長さ・解像度・音声の有無など）を調べ、デコード用のトラックを持つ。
// 画像の AssetStore と同じく、Undo で戻せるようセッション中は原則として削除しない。

import { ALL_FORMATS, BlobSource, Input, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';
import { newId } from '../core/doc';

export interface MediaInfo {
  id: string;
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
  video: InputVideoTrack;
  /** デコードできる音声トラック（なければ null） */
  audio: InputAudioTrack | null;
}

/** 読み込めなかった理由（日本語） */
export class MediaLoadError extends Error {}

export function isVideoFile(f: File): boolean {
  return f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name);
}

export class MediaStore {
  private entries = new Map<string, MediaEntry>();

  /** ファイルを調べて登録する。読めない場合は MediaLoadError */
  async add(file: File, id: string = newId('media')): Promise<MediaEntry> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    try {
      if (!(await input.canRead())) throw new MediaLoadError('対応していない形式です');
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new MediaLoadError('映像が入っていません');
      if (!(await video.canDecode())) {
        throw new MediaLoadError(`このブラウザでは映像（${video.codec ?? '不明な形式'}）をデコードできません`);
      }
      const audioTrack = await input.getPrimaryAudioTrack();
      const audio = audioTrack && (await audioTrack.canDecode()) ? audioTrack : null;
      const duration = await input.computeDuration();
      if (!(duration > 0)) throw new MediaLoadError('長さを読み取れませんでした');
      const stats = await video.computePacketStats(120);
      const info: MediaInfo = {
        id,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        duration,
        width: await video.getDisplayWidth(),
        height: await video.getDisplayHeight(),
        fps: stats.averagePacketRate > 0 ? stats.averagePacketRate : 30,
        hasAudio: audio !== null,
        videoCodec: video.codec,
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
