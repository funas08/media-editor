import assert from 'node:assert/strict';
import { ALL_FORMATS, AudioSample, BufferSource, BufferTarget, Input, VideoSample } from 'mediabunny';
import { createDoc, createImageItem, createVideoItem } from '../src/core/doc';
import { activeClipAt, audioSegments, clipDuration, formatTime, isItemShownAt, totalDuration, videoTimesAt, videoTrackLayout } from '../src/core/timeline';
import { ExportCanceledError, frameCount, runExport, type ExportPlan } from '../src/media/exportPipeline';
import { registerFakeEncoders } from './fakeEncoders';
import { near, test } from './harness';

function docWithClips(durations: number[]) {
  const doc = createDoc(1920, 1080);
  doc.items.push({ ...createImageItem({ id: 'asset', name: 'overlay', width: 100, height: 100 }, 50, 50), id: 'img' });
  durations.forEach((d, i) => doc.items.push({ ...createVideoItem({ id: `m${i}`, name: `v${i}.mp4`, width: 1920, height: 1080, duration: d }, 960, 540), id: `v${i}` }));
  return doc;
}

test('動画トラック：クリップを順に隙間なく並べる', () => {
  const doc = docWithClips([3, 2.5, 4]);
  assert.deepEqual(videoTrackLayout(doc).map((s) => [s.item.id, s.start, s.end]), [['v0', 0, 3], ['v1', 3, 5.5], ['v2', 5.5, 9.5]]);
  assert.equal(totalDuration(doc), 9.5);
});

test('時刻ごとに表示するクリップと元動画の時刻（境目は次のクリップ、最後は最終フレーム）', () => {
  const doc = docWithClips([3, 2]);
  assert.deepEqual([activeClipAt(doc, 1)?.span.item.id, activeClipAt(doc, 1)?.sourceTime], ['v0', 1]);
  assert.equal(activeClipAt(doc, 3)?.span.item.id, 'v1');
  assert.equal(activeClipAt(doc, 3.5)?.sourceTime, 0.5);
  assert.equal(activeClipAt(doc, 5)?.span.item.id, 'v1');
  assert.equal(activeClipAt(doc, 5.5), null);
});

test('使う範囲（in/out）と再生速度を反映', () => {
  const doc = docWithClips([10]);
  const v = doc.items[1];
  if (v.type !== 'video') throw new Error();
  Object.assign(v, { inPoint: 2, outPoint: 8, speed: 2 });
  assert.equal(clipDuration(v), 3);
  assert.ok(near(activeClipAt(doc, 1)!.sourceTime, 4));
});

test('描画対象：その時刻のクリップだけ（画像は常に）', () => {
  const doc = docWithClips([3, 2]);
  const times = videoTimesAt(doc, 4);
  assert.deepEqual(doc.items.filter((it) => isItemShownAt(it, times)).map((it) => it.id), ['img', 'v1']);
});

test('元の音声の区間（ミュート・音量 0 は除く）', () => {
  const doc = docWithClips([3, 2, 1]);
  const [, , v1] = doc.items;
  if (v1.type !== 'video') throw new Error();
  v1.muted = true;
  assert.deepEqual(audioSegments(doc).map((s) => [s.mediaId, s.start, s.end]), [['m0', 0, 3], ['m2', 5, 6]]);
});

test('時刻の表示', () => {
  assert.equal(formatTime(75.256), '01:15.26');
  assert.equal(formatTime(5, false), '00:05');
});

const plan = (o: Partial<ExportPlan> = {}): ExportPlan => ({
  width: 320,
  height: 180,
  fps: 30,
  duration: 2,
  videoCodec: 'vp9',
  videoBitrate: 1e6,
  audio: { bitrate: 128000, sampleRate: 48000, channels: 2 },
  ...o,
});

const rgba = new Uint8Array(320 * 180 * 4);
const frame = (t: number, fps: number) => new VideoSample(rgba, { format: 'RGBA', codedWidth: 320, codedHeight: 180, timestamp: t, duration: 1 / fps });
const silence = (t0: number, t1: number) => {
  const n = Math.round((t1 - t0) * 48000);
  return new AudioSample({ data: new Float32Array(n * 2), format: 'f32-planar', numberOfChannels: 2, sampleRate: 48000, timestamp: t0 });
};

async function inspect(buf: ArrayBuffer) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(buf) });
  const v = await input.getPrimaryVideoTrack();
  const a = await input.getPrimaryAudioTrack();
  return {
    duration: await input.computeDuration(),
    width: await v?.getDisplayWidth(),
    height: await v?.getDisplayHeight(),
    tracks: (await input.getTracks()).length,
    audioRate: a?.sampleRate,
    frames: (await v?.computePacketStats())?.packetCount,
  };
}

test('書き出し（映像＋音声）：長さ・解像度・トラック数・フレーム数', async () => {
  registerFakeEncoders();
  const target = new BufferTarget();
  let progress = 0;
  await runExport(plan(), target, { renderFrame: async (t) => frame(t, 30), renderAudio: async (a, b) => silence(a, b), onProgress: (r) => (progress = r) });
  const info = await inspect(target.buffer!);
  assert.ok(Math.abs(info.duration - 2) < 0.05, `長さ ${info.duration}`);
  assert.deepEqual([info.width, info.height, info.tracks, info.audioRate, info.frames], [320, 180, 2, 48000, 60]);
  assert.equal(progress, 1);
});

test('書き出し（音声なし・60fps・端数の長さ）', async () => {
  registerFakeEncoders();
  const target = new BufferTarget();
  await runExport(plan({ fps: 60, duration: 1.51, audio: null }), target, { renderFrame: async (t) => frame(t, 60) });
  const info = await inspect(target.buffer!);
  assert.equal(info.tracks, 1);
  assert.equal(info.frames, frameCount(1.51, 60));
  assert.ok(Math.abs(info.duration - 91 / 60) < 0.02, `長さ ${info.duration}`);
});

test('書き出しのキャンセル', async () => {
  registerFakeEncoders();
  const ac = new AbortController();
  await assert.rejects(
    runExport(plan(), new BufferTarget(), {
      signal: ac.signal,
      renderFrame: async (t, i) => {
        if (i === 10) ac.abort();
        return frame(t, 30);
      },
    }),
    ExportCanceledError,
  );
});
