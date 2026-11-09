// 高画質書き出しサーバ（ffmpeg）と無劣化コピーの組み合わせを、本物の H.264 / AAC で確かめる。
// 元動画は ffmpeg で作り、書き出した MP4 を ffmpeg でデコードしてエラーがないことを確かめる（.tmp/ に置く。commit しない）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import ffmpegPath from 'ffmpeg-static';
import { ALL_FORMATS, AudioSample, BufferSource, BufferTarget, EncodedPacketSink, Input, VideoSample } from 'mediabunny';
import { createDoc, createVideoItem } from '../src/core/doc';
import { ExportServerClient, ffmpegAudioFeed, ffmpegEncoderFactory, x264ProfileLevel } from '../src/media/exportServer';
import { nalTypes } from '../src/media/nal';
import { planSmartCopy, type SourceVideoMeta } from '../src/media/smartCopy';
import { copyAudioFeed, runSmartExport, type CopySource } from '../src/media/smartExport';
import { AdtsParser, TsVideoDemuxer } from '../src/media/streamParsers';
import { test } from './harness';

const TMP = '.tmp/tests';
const W = 640;
const H = 360;
const ffmpeg = ffmpegPath as unknown as string;

function run(args: string[]): { code: number; stderr: string } {
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  return { code: r.status ?? -1, stderr: r.stderr };
}

/** 元動画：640×360・30fps・4 秒・1 秒ごとにキーフレーム（B フレームあり）・AAC 48kHz ステレオ */
function makeSource(): string {
  mkdirSync(TMP, { recursive: true });
  const path = `${TMP}/source.mp4`;
  const r = run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=30:duration=4`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-bf', '2',
    '-c:a', 'aac', '-ac', '2', '-b:a', '128k', path,
  ]);
  assert.equal(r.code, 0, r.stderr);
  return path;
}

/** ffmpeg でデコードしてエラーがないか（エラーの文を返す） */
function decodeErrors(path: string): string {
  const r = run(['-hide_banner', '-v', 'error', '-i', path, '-f', 'null', '-']);
  return r.code === 0 ? r.stderr.trim() : `終了コード ${r.code}：${r.stderr}`;
}

async function startServer() {
  const core = (await import('../scripts/export-server-core.mjs')) as typeof import('../scripts/export-server-core.mjs');
  const token = core.newToken();
  const info = await core.ffmpegInfo(ffmpeg);
  const server = core.createExportServer({ ffmpegPath: ffmpeg, token, info });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, token, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function openSource(path: string) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(readFileSync(path)) });
  const vt = (await input.getPrimaryVideoTrack())!;
  const at = (await input.getPrimaryAudioTrack())!;
  const dc = (await vt.getDecoderConfig())!;
  const sink = new EncodedPacketSink(vt);
  const keyTimes: number[] = [];
  for (let p = await sink.getFirstKeyPacket({ metadataOnly: true }); p; p = await sink.getNextKeyPacket(p, { metadataOnly: true })) keyTimes.push(p.timestamp);
  const endTime = await vt.computeDuration();
  const meta: SourceVideoMeta = { codecString: dc.codec, width: W, height: H, fps: 30, rotation: 0, hdr: false, keyTimes, endTime, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } };
  const desc = dc.description as ArrayBuffer | Uint8Array;
  const source: CopySource = {
    video: sink,
    description: desc instanceof Uint8Array ? desc : new Uint8Array(desc),
    codecString: dc.codec,
    endTime,
    audio: new EncodedPacketSink(at),
    audioConfig: await at.getDecoderConfig(),
  };
  return { meta, source };
}

/** 書き出しで描くフレーム（灰色の背景に、時刻で動く白い縦線） */
function grayFrame(t: number, d: number): VideoSample {
  const buf = new Uint8Array(W * H * 1.5).fill(128);
  const x = Math.floor((t * 200) % W);
  for (let y = 0; y < H; y++) buf[y * W + x] = 235;
  return new VideoSample(buf, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: t, duration: d });
}

test('x264 のプロファイルとレベル（コーデック文字列から）', () => {
  assert.deepEqual(x264ProfileLevel('avc1.640028'), { profile: 'high', level: 40 });
  assert.deepEqual(x264ProfileLevel('avc1.4d401f'), { profile: 'main', level: 31 });
  assert.deepEqual(x264ProfileLevel('hvc1.1.6.L120.90'), {});
});

test('サーバ：トークンがない・違う要求は断る', async () => {
  const s = await startServer();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/info`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/info`, { headers: { 'X-Export-Token': 'x' } })).status, 401);
    // 事前確認（CORS）はトークンなしで通す
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/jobs`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } })).status, 204);
    const info = await new ExportServerClient(s.port, s.token).info();
    assert.equal(info.encoders.libx264, true);
    // 決まった値以外は受け付けない（ffmpeg の引数に入れない）
    await assert.rejects(new ExportServerClient(s.port, s.token).createJob({ type: 'video', codec: 'h264', width: 640, height: 360, fpsNum: 30, fpsDen: 1, crf: 16, preset: 'slow;rm', keyint: 30 }));
  } finally {
    await s.close();
  }
});

test('MPEG-TS・ADTS の読み取り（ffmpeg の出力）', () => {
  mkdirSync(TMP, { recursive: true });
  let r = run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1', '-c:v', 'libx264', '-bf', '2', '-g', '15', '-f', 'mpegts', `${TMP}/a.ts`]);
  assert.equal(r.code, 0, r.stderr);
  const demux = new TsVideoDemuxer();
  const bytes = readFileSync(`${TMP}/a.ts`);
  // 少しずつ届いても読める
  const frames = [];
  for (let p = 0; p < bytes.length; p += 1000) frames.push(...demux.push(bytes.subarray(p, p + 1000)));
  frames.push(...demux.flush());
  assert.equal(frames.length, 30);
  // B フレームがあるので、デコード順と表示順が違う
  assert.ok(frames.some((f, i) => i > 0 && f.pts < frames[i - 1].pts));
  r = run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=1', '-ac', '2', '-c:a', 'aac', '-f', 'adts', `${TMP}/a.aac`]);
  assert.equal(r.code, 0, r.stderr);
  const aac = new AdtsParser().push(readFileSync(`${TMP}/a.aac`));
  assert.ok(aac.length >= 47 && aac.length <= 49, `AAC フレーム ${aac.length}`);
  assert.deepEqual([...aac[0].config], [0x11, 0x90]);
});

test('無劣化コピー＋ x264（ローカルサーバ）：つなぎ目もデコードでき、コピーした区間は元のまま', async () => {
  const src = makeSource();
  const { meta, source } = await openSource(src);
  const s = await startServer();
  try {
    const client = new ExportServerClient(s.port, s.token);
    const doc = createDoc(W, H);
    doc.items.push({ ...createVideoItem({ id: 'm', name: 'source.mp4', width: W, height: H, duration: 4 }, W / 2, H / 2), id: 'v', inPoint: 0.5, outPoint: 3.5 });
    const plan = planSmartCopy(doc, new Map([['m', meta]]), {
      width: W, height: H, fps: 30, codec: 'avc', scale: 1, from: 0, to: 3, includeAudio: true, audioSampleRate: 48000, audioChannels: 2, canEncodeProfile: () => true,
    });
    assert.deepEqual(plan.sections.map((x) => x.kind), ['render', 'copy', 'render']);
    const sources = new Map([['m', source]]);
    const target = new BufferTarget();
    const stats = await runSmartExport(
      { width: W, height: H, fps: 30, codec: 'avc', duration: 3, sections: plan.sections, sources, codecString: plan.codecString, primaryMediaId: plan.primaryMediaId, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } },
      target,
      {
        renderFrame: async (t, d) => grayFrame(t, d),
        encoder: ffmpegEncoderFactory(client, { codec: 'avc', quality: 'high', keyFrameInterval: 1, colorSpace: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false } }),
        audio: plan.audio.copy ? copyAudioFeed(plan.audio.parts, sources) : null,
      },
    );
    assert.equal(stats.demotedSections, 0);
    assert.equal(stats.copiedPackets, 60);
    assert.equal(stats.encodedPackets, 30);
    const out = `${TMP}/smart-x264.mp4`;
    writeFileSync(out, new Uint8Array(target.buffer!));
    assert.equal(decodeErrors(out), '');

    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer!) });
    const vt = (await input.getPrimaryVideoTrack())!;
    assert.ok(Math.abs((await input.computeDuration()) - 3) < 0.05, `長さ ${await input.computeDuration()}`);
    assert.equal((await vt.computePacketStats()).packetCount, 90);
    // 表示時刻が 1/30 秒ずつ隙間なく並ぶ
    const times: number[] = [];
    for await (const p of new EncodedPacketSink(vt).packets(undefined, undefined, { metadataOnly: true })) times.push(p.timestamp);
    times.sort((a, b) => a - b);
    times.forEach((t, i) => assert.ok(Math.abs(t - i / 30) < 2e-3, `フレーム ${i}：${t}`));
    // 0.5 秒（元の 1 秒）のキーフレームは、元のデータに SPS / PPS を入れたもの
    const k = await new EncodedPacketSink(vt).getKeyPacket(0.5 + 1e-4);
    assert.ok(k && Math.abs(k.timestamp - 0.5) < 1e-3);
    const types = nalTypes('avc', k.data);
    assert.ok(types.includes(7) && types.includes(8) && types.includes(5), `NAL ${types}`);
    const orig = await source.video!.getKeyPacket(1 + 1e-4);
    assert.ok(k.data.length >= orig!.data.length);
    // 音声もコピー
    const at = (await input.getPrimaryAudioTrack())!;
    assert.ok(Math.abs((await at.computeDuration()) - 3) < 0.05);
  } finally {
    await s.close();
  }
});

test('ffmpeg だけで書き出す（x265・AAC 320kbps）', async () => {
  const s = await startServer();
  try {
    const client = new ExportServerClient(s.port, s.token);
    const target = new BufferTarget();
    const duration = 2;
    const render = async (t0: number, t1: number) => {
      const frames = Math.round((t1 - t0) * 48000);
      const data = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) data[i] = data[frames + i] = 0.2 * Math.sin((2 * Math.PI * 440 * (t0 * 48000 + i)) / 48000);
      return new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: 48000, timestamp: t0 });
    };
    const stats = await runSmartExport(
      { width: W, height: H, fps: 30, codec: 'hevc', duration, sections: [{ kind: 'render', start: 0, end: duration, frames: 'grid' }], sources: new Map(), codecString: null, primaryMediaId: null },
      target,
      {
        renderFrame: async (t, d) => grayFrame(t, d),
        encoder: ffmpegEncoderFactory(client, { codec: 'hevc', quality: 'high', keyFrameInterval: 1, colorSpace: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false } }),
        audio: ffmpegAudioFeed(client, { duration, sampleRate: 48000, channels: 2, bitrate: 320_000, render }),
      },
    );
    assert.equal(stats.encodedPackets, 60);
    const out = `${TMP}/x265.mp4`;
    writeFileSync(out, new Uint8Array(target.buffer!));
    assert.equal(decodeErrors(out), '');
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer!) });
    const vt = (await input.getPrimaryVideoTrack())!;
    assert.equal(vt.codec, 'hevc');
    assert.ok(Math.abs((await input.computeDuration()) - duration) < 0.05, `長さ ${await input.computeDuration()}`);
    const at = (await input.getPrimaryAudioTrack())!;
    assert.ok(Math.abs((await at.computeDuration()) - duration) < 0.05, `音声の長さ ${await at.computeDuration()}`);
  } finally {
    await s.close();
  }
});
