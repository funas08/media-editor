// 動画のフレームを時刻順に取り出す小さな部品。
// 再生中は前のフレームの続きからデコードし（速い）、大きく飛んだときや戻ったときだけデコードし直す。
// フレームは CanvasSink が使い回すキャンバスに描かれるので、VideoFrame は Mediabunny の中ですぐ close される。

import type { CanvasSink, WrappedCanvas } from 'mediabunny';

/** これ以上先へ飛んだら、続きから読むよりデコードし直す（秒） */
const RESTART_GAP = 2;
const EPS = 1e-4;

export class SequentialFrames {
  private sink: CanvasSink;
  private gen: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  /** 直近に表示したフレーム（timestamp <= 要求した時刻） */
  private cur: WrappedCanvas | null = null;
  /** 先読みしたフレーム（まだ表示時刻になっていない） */
  private next: WrappedCanvas | null = null;
  private ended = false;
  /** 同時に呼ばれても順番に処理する */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(sink: CanvasSink) {
    this.sink = sink;
  }

  /** 時刻 t（元動画の秒）に表示するフレーム */
  frameAt(t: number): Promise<WrappedCanvas | null> {
    const run = this.queue.then(() => this.advance(t));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 使い終わったら呼ぶ（デコードを止める） */
  async dispose(): Promise<void> {
    await this.queue;
    await this.gen?.return();
    this.gen = null;
  }

  private async advance(t: number): Promise<WrappedCanvas | null> {
    const cur = this.cur;
    const needRestart = !this.gen || (cur !== null && (t < cur.timestamp - EPS || t > cur.timestamp + RESTART_GAP)) || (cur === null && this.ended);
    if (needRestart) await this.restart(t);
    const gen = this.gen;
    if (!gen) return null;
    for (;;) {
      if (!this.next) {
        const r = await gen.next();
        if (r.done) {
          this.ended = true;
          break;
        }
        this.next = r.value;
      }
      if (this.next.timestamp <= t + EPS) {
        this.cur = this.next;
        this.next = null;
      } else {
        break;
      }
    }
    return this.cur ?? this.next;
  }

  private async restart(t: number): Promise<void> {
    await this.gen?.return();
    this.gen = this.sink.canvases(Math.max(0, t));
    this.cur = null;
    this.next = null;
    this.ended = false;
  }
}
