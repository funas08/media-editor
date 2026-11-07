// 動画書き出しの流れ（ブラウザに依存しない部分）。
// フレームと音声は呼び出し側が作って渡す（ブラウザでは Canvas と Web Audio、テストでは仮のデータ）。
// Mediabunny の Output に映像・音声を交互に少しずつ渡し、MP4 にまとめる。

import { AudioSampleSource, Mp4OutputFormat, Output, Quality, VideoSampleSource, type AudioSample, type Target, type VideoCodec, type VideoSample } from 'mediabunny';

export interface ExportPlan {
  width: number;
  height: number;
  fps: number;
  /** 長さ（秒） */
  duration: number;
  videoCodec: VideoCodec;
  /** 映像のビットレート（bps、可変ビットレートの目標値） */
  videoBitrate: number;
  /** ハードウェアエンコーダーを優先するか（使えない環境では 'no-preference' を渡す） */
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /** キーフレームの間隔（秒） */
  keyFrameInterval?: number;
  /** 音声なしで書き出すときは null */
  audio: { bitrate: number; sampleRate: number; channels: number } | null;
  /**
   * 書き出す動画の色空間。MP4 の色情報（colr）は、エンコーダーが返す情報から書かれるため、
   * エンコーダーが返さなかったとき（または一部が欠けているとき）にこの値で補う
   */
  colorSpace?: VideoColorSpaceInit;
  /** エンコーダーの設定が決まったときに呼ばれる（確認・表示用） */
  onEncoderConfig?: (config: VideoEncoderConfig) => void;
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
  // 画質優先：ビットレートを明示した可変ビットレート（指定しないと Mediabunny は量子化値固定になり、ファイルサイズを決められない）、
  // latencyMode は 'quality'（フレームを落とさず、画質を優先）
  const video = new VideoSampleSource({
    codec: plan.videoCodec,
    quality: new Quality({ bitrate: plan.videoBitrate, bitrateMode: 'variable' }),
    latencyMode: 'quality',
    hardwareAcceleration: plan.hardwareAcceleration ?? 'no-preference',
    keyFrameInterval: plan.keyFrameInterval ?? 2,
    sizeChangeBehavior: 'deny',
    onEncoderConfig: plan.onEncoderConfig,
    onEncodedPacket: (_packet, meta) => {
      // ここで渡される meta がそのまま MP4 に書かれる
      const dc = meta?.decoderConfig;
      if (!dc || !plan.colorSpace) return;
      const cs = dc.colorSpace;
      if (cs?.primaries && cs.transfer && cs.matrix && cs.fullRange != null) return;
      dc.colorSpace = { ...plan.colorSpace, ...Object.fromEntries(Object.entries(cs ?? {}).filter(([, v]) => v != null)) };
    },
  });
  output.addVideoTrack(video, { frameRate: plan.fps });
  const audio = plan.audio && cb.renderAudio ? new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: plan.audio.bitrate }) }) : null;
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
