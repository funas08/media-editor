// 動画書き出しの流れ（ブラウザに依存しない部分）。
// フレームと音声は呼び出し側が作って渡す（ブラウザでは Canvas と Web Audio、テストでは仮のデータ）。
// Mediabunny の Output に映像・音声を交互に少しずつ渡し、MP4 にまとめる。

import { AudioSampleSource, Mp4OutputFormat, Output, VideoSampleSource, type AudioSample, type Quality, type Target, type VideoCodec, type VideoSample } from 'mediabunny';

export interface ExportPlan {
  width: number;
  height: number;
  fps: number;
  /** 長さ（秒） */
  duration: number;
  videoCodec: VideoCodec;
  videoBitrate: number | Quality;
  /** 音声なしで書き出すときは null */
  audio: { bitrate: number | Quality; sampleRate: number; channels: number } | null;
}

export interface ExportCallbacks {
  /** 時刻 t のフレームを作る（返したサンプルは書き出し側で close する） */
  renderFrame(t: number, index: number): Promise<VideoSample>;
  /** 時刻 t0〜t1 の音声を作る（返したサンプルは書き出し側で close する） */
  renderAudio?(t0: number, t1: number): Promise<AudioSample>;
  /** 進み具合（0〜1） */
  onProgress?(ratio: number): void;
  signal?: AbortSignal;
}

/** 音声を何秒ずつ作るか */
const AUDIO_WINDOW = 1;

export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.round(duration * fps));
}

/** 書き出し中にキャンセルされたとき */
export class ExportCanceledError extends Error {
  constructor() {
    super('書き出しをキャンセルしました');
  }
}

/** 書き出しを実行する。target には BufferTarget（テスト）や StreamTarget（ファイル）を渡す */
export async function runExport(plan: ExportPlan, target: Target, cb: ExportCallbacks): Promise<void> {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const video = new VideoSampleSource({ codec: plan.videoCodec, bitrate: plan.videoBitrate, keyFrameInterval: 2, sizeChangeBehavior: 'deny' });
  output.addVideoTrack(video, { frameRate: plan.fps });
  const audio = plan.audio && cb.renderAudio ? new AudioSampleSource({ codec: 'aac', bitrate: plan.audio.bitrate }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();

  const total = frameCount(plan.duration, plan.fps);
  const duration = total / plan.fps;
  let audioDone = 0;
  /** 音声を t まで作る（映像と音声を交互に渡して、Mediabunny の中に溜まりすぎないようにする） */
  const fillAudio = async (t: number) => {
    if (!audio || !cb.renderAudio) return;
    while (audioDone < Math.min(t, duration) - 1e-9) {
      const t1 = Math.min(duration, audioDone + AUDIO_WINDOW);
      const s = await cb.renderAudio(audioDone, t1);
      try {
        await audio.add(s);
      } finally {
        s.close();
      }
      audioDone = t1;
    }
  };

  try {
    for (let i = 0; i < total; i++) {
      if (cb.signal?.aborted) throw new ExportCanceledError();
      const t = i / plan.fps;
      await fillAudio(t + AUDIO_WINDOW);
      const frame = await cb.renderFrame(t, i);
      try {
        await video.add(frame);
      } finally {
        frame.close();
      }
      cb.onProgress?.((i + 1) / total);
    }
    await fillAudio(duration);
    if (cb.signal?.aborted) throw new ExportCanceledError();
    await output.finalize();
  } catch (e) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    throw e;
  }
}
