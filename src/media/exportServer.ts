// 高画質書き出し（ローカルサーバの ffmpeg）を使うためのブラウザ側の部品。
// サーバは npm run export-server で起動する（scripts/export-server.mjs）。なくてもアプリは動く。
// - 映像：区間ごとに ffmpeg のジョブを作り、I420 のフレームを送って、MPEG-TS で返ってくる圧縮データを受け取る
// - 音声：ミックスした音声（f32）を送り、ADTS（AAC）で受け取る
// MP4 へのまとめと保存はブラウザ（Mediabunny）が行う。サーバはファイルを保存しない。

import { EncodedAudioPacketSource, EncodedPacket, type AudioSample, type Output } from 'mediabunny';
import { isRandomAccess, joinLengthPrefixed, nalType, splitAnnexB, type NalCodec } from './nal';
import type { AudioFeed, SegmentEncoder, SegmentEncoderFactory } from './smartExport';
import { AdtsParser, TsVideoDemuxer, type TsFrame } from './streamParsers';

export const DEFAULT_SERVER_PORT = 8765;

export interface ServerInfo {
  app: string;
  serverVersion: number;
  /** ffmpeg の版（1 行目） */
  ffmpeg: string;
  encoders: { libx264: boolean; libx265: boolean; aac: boolean };
}

/** サーバにつながらない・断られたとき */
export class ExportServerError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export class ExportServerClient {
  readonly base: string;
  private token: string;

  constructor(port: number, token: string) {
    this.base = `http://127.0.0.1:${port}`;
    this.token = token.trim();
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.base + path, { ...init, headers: { ...(init.headers ?? {}), 'X-Export-Token': this.token } });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ExportServerError('サーバに接続できません（起動していないか、ポート番号が違います）');
    }
    if (res.status === 401) throw new ExportServerError('トークンが違います（サーバを起動し直した場合は、新しいトークンを貼り付けてください）', 401);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; stderr?: string } | null;
      throw new ExportServerError(`${body?.error ?? `サーバのエラー（${res.status}）`}${body?.stderr ? `：${body.stderr.trim().split('\n').pop()}` : ''}`, res.status);
    }
    return res;
  }

  /** つながるか確かめ、ffmpeg の情報を得る */
  async info(): Promise<ServerInfo> {
    const r = (await (await this.req('/info')).json()) as ServerInfo;
    if (r.app !== 'image-editor-export-server') throw new ExportServerError('このアプリの書き出しサーバではありません');
    return r;
  }

  async createJob(params: Record<string, unknown>): Promise<string> {
    const r = (await (await this.req('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })).json()) as { id: string };
    return r.id;
  }

  async input(id: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.req(`/jobs/${id}/input`, { method: 'POST', body: data as BodyInit, signal });
  }

  async end(id: string): Promise<void> {
    await this.req(`/jobs/${id}/end`, { method: 'POST' });
  }

  async output(id: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.req(`/jobs/${id}/output`, { signal });
    if (!res.body) throw new ExportServerError('サーバから出力を受け取れません');
    return res.body;
  }

  /** ffmpeg の終了コードとエラー出力（終わるまで待つ） */
  async result(id: string): Promise<{ code: number; stderr: string }> {
    return (await (await this.req(`/jobs/${id}/result`)).json()) as { code: number; stderr: string };
  }

  async cancel(id: string): Promise<void> {
    await this.req(`/jobs/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

/** ジョブの出力を最後まで読み、届いた分ずつ渡す */
function readAll(stream: ReadableStream<Uint8Array>, onData: (d: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader();
  return (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      onData(r.value);
    }
  })();
}

/** ffmpeg の画質の選択肢 */
export type FfmpegQuality = 'best' | 'high';

export const FFMPEG_QUALITY: Record<FfmpegQuality, { label: string; crf: number; preset: string }> = {
  best: { label: '最高画質（CRF 16・preset slow）', crf: 16, preset: 'slow' },
  high: { label: '高画質（CRF 18・preset medium）', crf: 18, preset: 'medium' },
};

/** 音声のビットレート（ffmpeg の AAC） */
export const FFMPEG_AUDIO_BITRATE = 320_000;

export interface FfmpegVideoOptions {
  codec: NalCodec;
  quality: FfmpegQuality;
  /** キーフレームの間隔（秒） */
  keyFrameInterval: number;
  colorSpace: { matrix: string; primaries: string; transfer: string; fullRange: boolean };
}

/** コーデック文字列（avc1.PPCCLL）から x264 のプロファイルとレベル */
export function x264ProfileLevel(codecString: string | null): { profile?: string; level?: number } {
  const m = codecString?.match(/^avc[13]\.([0-9a-f]{2})[0-9a-f]{2}([0-9a-f]{2})$/i);
  if (!m) return {};
  const profile = ({ 0x42: 'baseline', 0x4d: 'main', 0x64: 'high' } as Record<number, string>)[parseInt(m[1], 16)];
  return { profile, level: parseInt(m[2], 16) };
}

/** 区間ごとに ffmpeg（x264 / x265）で圧縮するエンコーダー */
export function ffmpegEncoderFactory(client: ExportServerClient, o: FfmpegVideoOptions, signal?: AbortSignal): SegmentEncoderFactory {
  return async (info) => {
    const q = FFMPEG_QUALITY[o.quality];
    const fps = Math.max(1, Math.round(info.fps));
    const pl = o.codec === 'avc' ? x264ProfileLevel(info.codecString) : {};
    const id = await client.createJob({
      type: 'video',
      codec: o.codec === 'avc' ? 'h264' : 'h265',
      width: info.width,
      height: info.height,
      fpsNum: fps,
      fpsDen: 1,
      crf: q.crf,
      preset: q.preset,
      keyint: Math.max(1, Math.round(o.keyFrameInterval * fps)),
      colorSpace: o.colorSpace,
      ...pl,
    });
    const demux = new TsVideoDemuxer();
    const frames: TsFrame[] = [];
    /** 送ったフレームの時刻と長さ（ffmpeg の k 番目のフレーム → 書き出しの時刻） */
    const times: { t: number; d: number }[] = [];
    let base: number | null = null;
    let failed: unknown = null;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort);
    const reading = client
      .output(id, ac.signal)
      .then((s) => readAll(s, (d) => frames.push(...demux.push(d))))
      .then(() => {
        frames.push(...demux.flush());
      })
      .catch((e) => {
        failed ??= e;
      });
    let buf: Uint8Array | null = null;
    const toPackets = (): EncodedPacket[] => {
      const out: EncodedPacket[] = [];
      for (const f of frames.splice(0)) {
        base ??= f.pts;
        const k = Math.round(((f.pts - base) * fps) / 90000);
        const tm = times[k] ?? times[times.length - 1];
        const nals = splitAnnexB(f.data);
        const key = nals.some((n) => isRandomAccess(o.codec, nalType(o.codec, n)));
        // アクセスユニット区切り（AUD）は MP4 では不要なので除く
        const aud = o.codec === 'avc' ? 9 : 35;
        out.push(new EncodedPacket(joinLengthPrefixed(nals.filter((n) => nalType(o.codec, n) !== aud)), key ? 'key' : 'delta', tm.t, tm.d));
      }
      return out;
    };
    const enc: SegmentEncoder = {
      add: async (sample) => {
        if (failed) throw failed;
        times.push({ t: sample.timestamp, d: sample.duration });
        const size = sample.allocationSize();
        if (!buf || buf.length !== size) buf = new Uint8Array(size);
        await sample.copyTo(buf);
        await client.input(id, buf, signal);
      },
      finish: async () => {
        await client.end(id);
        await reading;
        const r = await client.result(id);
        signal?.removeEventListener('abort', onAbort);
        if (failed) throw failed;
        if (r.code !== 0) throw new ExportServerError(`ffmpeg（映像）がエラーで終了しました：${r.stderr.trim().split('\n').pop() ?? r.code}`);
      },
      cancel: async () => {
        ac.abort();
        signal?.removeEventListener('abort', onAbort);
        await client.cancel(id);
      },
      // ffmpeg は表示順と違う順（B フレーム）でもデコード順に出す。時刻は PTS から決める
      take: () => toPackets(),
      // SPS / PPS はキーフレームごとに入っている（repeat-headers）
      description: () => null,
    };
    return enc;
  };
}

/** 音声を ffmpeg の AAC（320kbps）で圧縮する */
export function ffmpegAudioFeed(
  client: ExportServerClient,
  o: { duration: number; sampleRate: number; channels: number; bitrate: number; render: (t0: number, t1: number) => Promise<AudioSample>; signal?: AbortSignal },
): AudioFeed {
  const src = new EncodedAudioPacketSource('aac');
  const parser = new AdtsParser();
  const queue: { data: Uint8Array; config: Uint8Array }[] = [];
  let id: string | null = null;
  let reading: Promise<void> | null = null;
  let failed: unknown = null;
  let sent = 0;
  let n = 0;
  let started = false;
  const ac = new AbortController();
  const frameDur = 1024 / o.sampleRate;

  const start = async () => {
    if (id) return;
    id = await client.createJob({ type: 'audio', sampleRate: o.sampleRate, channels: o.channels, bitrate: o.bitrate });
    const jobId = id;
    o.signal?.addEventListener('abort', () => ac.abort());
    reading = client
      .output(jobId, ac.signal)
      .then((s) => readAll(s, (d) => queue.push(...parser.push(d))))
      .catch((e) => {
        failed ??= e;
      });
  };
  /** 届いた AAC のフレームを出力に渡す。ffmpeg の AAC は先頭に 1024 サンプルの準備用のフレームが入るので、その分だけ前にずらす */
  const drain = async () => {
    for (const f of queue.splice(0)) {
      const ts = (n - 1) * frameDur;
      n++;
      const meta = started ? undefined : { decoderConfig: { codec: 'mp4a.40.2', sampleRate: o.sampleRate, numberOfChannels: o.channels, description: f.config } };
      await src.add(new EncodedPacket(f.data, 'key', ts, frameDur), meta);
      started = true;
    }
  };
  const fillTo = async (t: number) => {
    await start();
    while (sent < Math.min(t, o.duration) - 1e-9) {
      if (failed) throw failed;
      const t1 = Math.min(o.duration, sent + 1);
      const s = await o.render(sent, t1);
      try {
        // f32 のインターリーブ（L R L R …）にして送る
        const bytes = new Float32Array(s.numberOfFrames * s.numberOfChannels);
        s.copyTo(bytes, { planeIndex: 0, format: 'f32' });
        await client.input(id!, new Uint8Array(bytes.buffer), o.signal);
      } finally {
        s.close();
      }
      sent = t1;
      await drain();
    }
  };
  return {
    attach: (output: Output) => output.addAudioTrack(src),
    fillTo,
    finish: async () => {
      await fillTo(o.duration);
      await client.end(id!);
      await reading;
      if (failed) throw failed;
      const r = await client.result(id!);
      if (r.code !== 0) throw new ExportServerError(`ffmpeg（音声）がエラーで終了しました：${r.stderr.trim().split('\n').pop() ?? r.code}`);
      await drain();
    },
    cancel: async () => {
      ac.abort();
      if (id) await client.cancel(id);
    },
  };
}
