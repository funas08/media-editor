// 画面表示用の動画フレーム。表示用に縮小してデコードし（4K でも軽く）、届いたら再描画を頼む。
// 描画は待たずに「今ある一番新しいフレーム」を使い、その間に次のフレームを取りにいく。

import { CanvasSink, type WrappedCanvas } from 'mediabunny';
import type { VideoItem } from '../core/types';
import type { FrameImage, VideoFrameProvider } from '../render/itemRenderers';
import type { MediaStore } from './MediaStore';
import { SequentialFrames } from './SequentialFrames';

/** プレビューでデコードする最大の辺の長さ（px） */
const PREVIEW_MAX_SIDE = 1280;

interface State {
  seq: SequentialFrames;
  last: WrappedCanvas | null;
  /** 次に取りにいく時刻（null なら依頼なし） */
  wanted: number | null;
  busy: boolean;
}

export class PreviewFrames implements VideoFrameProvider {
  private media: MediaStore;
  private onUpdate: () => void;
  private states = new Map<string, State>();

  constructor(media: MediaStore, onUpdate: () => void) {
    this.media = media;
    this.onUpdate = onUpdate;
  }

  frameFor(item: VideoItem, sourceTime: number): FrameImage | null {
    const st = this.state(item.mediaId);
    if (!st) return null;
    st.wanted = sourceTime;
    if (!st.busy) void this.pump(st);
    const c = st.last?.canvas;
    return c ? { image: c, width: c.width, height: c.height } : null;
  }

  /** 使わなくなった動画のデコーダーを止める */
  retainOnly(ids: ReadonlySet<string>): void {
    for (const [id, st] of this.states) {
      if (ids.has(id)) continue;
      void st.seq.dispose();
      this.states.delete(id);
    }
  }

  private state(mediaId: string): State | null {
    const existing = this.states.get(mediaId);
    if (existing) return existing;
    const entry = this.media.get(mediaId);
    if (!entry) return null;
    const { width, height } = entry.info;
    const k = Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height));
    const sink = new CanvasSink(entry.video, {
      width: Math.max(2, Math.round(width * k)),
      height: Math.max(2, Math.round(height * k)),
      fit: 'fill',
      poolSize: 4,
    });
    const st: State = { seq: new SequentialFrames(sink), last: null, wanted: null, busy: false };
    this.states.set(mediaId, st);
    return st;
  }

  private async pump(st: State): Promise<void> {
    st.busy = true;
    try {
      while (st.wanted !== null) {
        const t = st.wanted;
        st.wanted = null;
        const f = await st.seq.frameAt(t);
        if (f && f !== st.last) {
          st.last = f;
          this.onUpdate();
        }
      }
    } catch (e) {
      console.error('フレームのデコードに失敗しました', e);
    } finally {
      st.busy = false;
    }
  }
}
