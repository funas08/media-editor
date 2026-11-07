// 再生：Web Audio の時計を基準に再生位置を進め、元の音声を鳴らす。
// 映像はこの時刻に合わせて描く（PreviewFrames がその時刻のフレームを用意する）。

import { audioSegments } from '../core/timeline';
import type { DocState } from '../core/types';
import type { MediaStore } from './MediaStore';
import { scheduleSegments } from './audioSchedule';

/** 何秒先まで音声を並べておくか */
const LOOKAHEAD = 1.5;

export class Player {
  private media: MediaStore;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private playing = false;
  private pausedAt = 0;
  private startCtx = 0;
  private startT = 0;
  private session = 0;
  private nodes = new Set<AudioBufferSourceNode>();

  constructor(media: MediaStore) {
    this.media = media;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 今の再生位置（秒） */
  get time(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    return this.startT + Math.max(0, this.ctx.currentTime - this.startCtx);
  }

  /** from から再生する */
  async play(doc: DocState, from: number): Promise<void> {
    this.stopAudio();
    const ctx = this.ensureContext();
    await ctx.resume();
    const sid = ++this.session;
    this.startCtx = ctx.currentTime + 0.06;
    this.startT = from;
    this.pausedAt = from;
    this.playing = true;
    try {
      await scheduleSegments(ctx, this.media, audioSegments(doc), {
        from,
        to: Infinity,
        toCtxTime: (t) => this.startCtx + (t - this.startT),
        destination: this.master!,
        isCanceled: () => sid !== this.session,
        onNode: (n) => {
          this.nodes.add(n);
          n.onended = () => this.nodes.delete(n);
        },
        afterSchedule: async (when) => {
          // 先読みしすぎないよう、再生位置が近づくまで待つ
          while (sid === this.session && when - ctx.currentTime > LOOKAHEAD) await sleep(150);
        },
      });
    } catch (e) {
      console.error('音声の再生に失敗しました', e);
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.time;
    this.playing = false;
    this.session++;
    this.stopAudio();
  }

  /** 再生位置を変える。再生中ならその位置から再生し直す */
  seek(doc: DocState, t: number): void {
    if (this.playing) void this.play(doc, Math.max(0, t));
    else this.pausedAt = Math.max(0, t);
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private stopAudio(): void {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        // まだ開始していないノードなど
      }
      n.disconnect();
    }
    this.nodes.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
