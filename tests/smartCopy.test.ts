import assert from 'node:assert/strict';
import { ALL_FORMATS, BufferSource, BufferTarget, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Input, Mp4OutputFormat, Output, VideoSample } from 'mediabunny';
import { createDoc, createImageItem, createVideoItem, newClipTiming } from '../src/core/doc';
import type { DocState, VideoItem } from '../src/core/types';
import { buildDecoderRecord, nalTypes, normalizePacket, parseDecoderRecord, splitAnnexB, splitLengthPrefixed } from '../src/media/nal';
import { planSmartCopy, type SmartOutput, type SourceVideoMeta } from '../src/media/smartCopy';
import { copyAudioFeed, mediabunnyEncoderFactory, runSmartExport, type CopySource } from '../src/media/smartExport';
import { registerFakeEncoders } from './fakeEncoders';
import { near, test } from './harness';

// ---- 仮の元動画（H.264 の形をしたデータ。中身はデコードできないが、パケットの扱いを確かめられる） ----

/** 1920×1080・High プロファイルの SPS（x264 の出力の例） */
const SPS = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58];
const PPS = [0x68, 0xee, 0x3c];
/** avcC：High プロファイル、長さ 4 バイト、SPS 1 個、PPS 1 個 */
const SRC_AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS]);
const FPS = 30;
/** 1 秒ごとにキーフレーム、4 秒 */
const SRC_FRAMES = 120;

function lp(...nals: number[][]): Uint8Array {
  const out: number[] = [];
  for (const n of nals) out.push(0, 0, 0, n.length, ...n);
  return new Uint8Array(out);
}

async function makeSource(): Promise<ArrayBuffer> {
  const target = new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat(), target });
  const v = new EncodedVideoPacketSource('avc');
  const a = new EncodedAudioPacketSource('aac');
  out.addVideoTrack(v, { frameRate: FPS });
  out.addAudioTrack(a);
  await out.start();
  let audioT = 0;
  for (let i = 0; i < SRC_FRAMES; i++) {
    const t = i / FPS;
    while (audioT < t + 0.5) {
      await a.add(new EncodedPacket(new Uint8Array([0x21, 1, 2]), 'key', audioT, 1024 / 48000), audioT === 0 ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) } } : undefined);
      audioT += 1024 / 48000;
    }
    const key = i % FPS === 0;
    const data = key ? lp([0x65, 0x88, i]) : lp([0x41, 0x9a, i]);
    await v.add(new EncodedPacket(data, key ? 'key' : 'delta', t, 1 / FPS), i === 0 ? { decoderConfig: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, description: SRC_AVCC } } : undefined);
  }
  while (audioT < SRC_FRAMES / FPS) {
    await a.add(new EncodedPacket(new Uint8Array([0x21, 1, 2]), 'key', audioT, 1024 / 48000));
    audioT += 1024 / 48000;
  }
  await out.finalize();
  return target.buffer!;
}

const META: SourceVideoMeta = {
  codecString: 'avc1.640028',
  width: 1920,
  height: 1080,
  fps: 30,
  rotation: 0,
  hdr: false,
  keyTimes: [0, 1, 2, 3],
  endTime: 4,
  audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
};

function docWith(o: Partial<VideoItem> = {}): DocState {
  const doc = createDoc(1920, 1080);
  doc.items.push({ ...createVideoItem({ id: 'm', name: 'src.mp4', width: 1920, height: 1080, duration: 4 }, 960, 540), id: 'v', ...o });
  return doc;
}

const OUT: SmartOutput = {
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'avc',
  scale: 1,
  from: 0,
  to: 3,
  includeAudio: true,
  audioSampleRate: 48000,
  audioChannels: 2,
  canEncodeProfile: () => true,
};

const metas = new Map([['m', META]]);

test('NAL：長さ付き・Annex B の分解、キーフレームに SPS/PPS を入れる', () => {
  assert.deepEqual(splitLengthPrefixed(lp([0x65, 1], [0x06, 2])).map((n) => [...n]), [[0x65, 1], [0x06, 2]]);
  assert.deepEqual(splitAnnexB(new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 5, 0, 0, 0, 1, 0x65, 7])).map((n) => [...n]), [[0x09, 0xf0], [0x67, 5], [0x65, 7]]);
  const rec = parseDecoderRecord('avc', SRC_AVCC)!;
  assert.equal(rec.lengthSize, 4);
  assert.deepEqual(rec.paramSets.map((n) => [...n]), [SPS, PPS]);
  // キーフレームには入れる（AUD の後ろ）、そうでなければそのまま
  assert.deepEqual(nalTypes('avc', normalizePacket('avc', [new Uint8Array([0x09, 0xf0]), new Uint8Array([0x65, 1])], true, rec.paramSets)), [9, 7, 8, 5]);
  assert.deepEqual(nalTypes('avc', normalizePacket('avc', [new Uint8Array([0x41, 1])], false, rec.paramSets)), [1]);
  // すでに入っていれば重ねない
  assert.deepEqual(nalTypes('avc', normalizePacket('avc', [new Uint8Array(SPS), new Uint8Array(PPS), new Uint8Array([0x65, 1])], true, rec.paramSets)), [7, 8, 5]);
  // SPS / PPS から avcC を作り直せる
  assert.deepEqual([...buildDecoderRecord('avc', rec.paramSets)!.subarray(0, SRC_AVCC.length)], [...SRC_AVCC]);
});

test('計画：カット位置がキーフレームでなければ、次のキーフレームまで再エンコード', () => {
  const doc = docWith({ inPoint: 0.5, outPoint: 3.5 });
  const p = planSmartCopy(doc, metas, OUT);
  assert.deepEqual(
    p.sections.map((s) => [s.kind, +s.start.toFixed(3), +s.end.toFixed(3)]),
    [['render', 0, 0.5], ['copy', 0.5, 2.5], ['render', 2.5, 3]],
  );
  assert.ok(near(p.copySeconds, 2));
  assert.equal(p.codecString, 'avc1.640028');
  const r0 = p.sections[0];
  // 再エンコードの区間も元動画のフレームの時刻に合わせる
  assert.ok(r0.kind === 'render' && r0.frames !== 'grid' && near(r0.frames.srcFrom, 0.5) && near(r0.frames.srcTo, 1));
  assert.ok(p.reasons.some((r) => r.includes('キーフレーム')));
  assert.equal(p.audio.copy, true);
});

test('計画：編集・形式の違い・オーバーレイはコピーしない', () => {
  // 不透明度
  const faded = docWith();
  faded.items[0].clip = { ...newClipTiming('main', 0, 4), fadeIn: 0.5 };
  let p = planSmartCopy(faded, metas, { ...OUT, to: 4 });
  assert.equal(p.copySeconds, 0);
  assert.ok(p.reasons.includes('不透明度・フェードを使っている'));
  // 倍率
  p = planSmartCopy(docWith(), metas, { ...OUT, to: 4, scale: 1.5 });
  assert.equal(p.copySeconds, 0);
  // コーデック・フレームレート
  assert.equal(planSmartCopy(docWith(), metas, { ...OUT, to: 4, codec: 'hevc' }).copySeconds, 0);
  assert.equal(planSmartCopy(docWith(), metas, { ...OUT, to: 4, fps: 60 }).copySeconds, 0);
  // 29.97fps は 30fps と同じとみなす
  assert.equal(planSmartCopy(docWith(), new Map([['m', { ...META, fps: 29.97 }]]), { ...OUT, to: 4 }).copySeconds, 4);
  // オーバーレイが 1.2〜1.5 秒に重なる → 1〜2 秒の GOP だけ再エンコード
  const ov = docWith();
  ov.timeline.overlays.push({ id: 'o1', visible: true, locked: false });
  ov.items.push({ ...createImageItem({ id: 'a', name: 'logo', width: 10, height: 10 }, 5, 5), id: 'img', clip: { ...newClipTiming('o1', 1.2, 0.3) } });
  p = planSmartCopy(ov, metas, { ...OUT, to: 4 });
  assert.deepEqual(p.sections.map((s) => [s.kind, s.start, s.end]), [['copy', 0, 1], ['render', 1, 2], ['copy', 2, 4]]);
  assert.ok(p.reasons.includes('オーバーレイが重なっている'));
  // 音楽があれば音声はコピーしない
  const music = docWith();
  music.timeline.music.push({ id: 'mu', mediaId: 'x', name: 'bgm', start: 0, inPoint: 0, outPoint: 3, srcDuration: 3, volume: 1 });
  assert.deepEqual(planSmartCopy(music, metas, { ...OUT, to: 4 }).audio, { copy: false, reason: '音楽を入れている' });
});

test('計画：範囲（I〜O）と、2 つのクリップのつなぎ', () => {
  const doc = docWith({ inPoint: 1, outPoint: 3 });
  doc.items.push({ ...createVideoItem({ id: 'm', name: 'src.mp4', width: 1920, height: 1080, duration: 4 }, 960, 540), id: 'v2', inPoint: 0, outPoint: 2 });
  const p = planSmartCopy(doc, metas, { ...OUT, from: 0.5, to: 3.5 });
  // タイムライン：v（元 1〜3）が 0〜2、v2（元 0〜2）が 2〜4。0.5〜3.5 を書き出す
  assert.deepEqual(
    p.sections.map((s) => [s.kind, +s.start.toFixed(3), +s.end.toFixed(3)]),
    [['render', 0, 0.5], ['copy', 0.5, 1.5], ['copy', 1.5, 2.5], ['render', 2.5, 3]],
  );
  const c = p.sections[1];
  assert.ok(c.kind === 'copy' && c.srcFrom === 2 && c.srcTo === 3);
  assert.equal(p.audio.copy, true);
});

/** 仮の H.264 エンコーダーで、元動画のコピーと再エンコードをつなぐ */
async function exportSmart(doc: DocState, out: SmartOutput) {
  registerFakeEncoders();
  const buf = await makeSource();
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(buf) });
  const vt = (await input.getPrimaryVideoTrack())!;
  const at = (await input.getPrimaryAudioTrack())!;
  const dc = (await vt.getDecoderConfig())!;
  const source: CopySource = {
    video: new EncodedPacketSink(vt),
    description: new Uint8Array(dc.description as ArrayBuffer),
    codecString: dc.codec,
    endTime: await vt.computeDuration(),
    audio: new EncodedPacketSink(at),
    audioConfig: await at.getDecoderConfig(),
  };
  const sources = new Map([['m', source]]);
  const plan = planSmartCopy(doc, metas, out);
  const target = new BufferTarget();
  const rgba = new Uint8Array(1920 * 1080 * 4);
  const rendered: number[] = [];
  const stats = await runSmartExport(
    { width: 1920, height: 1080, fps: 30, codec: 'avc', duration: out.to - out.from, sections: plan.sections, sources, codecString: plan.codecString, primaryMediaId: plan.primaryMediaId },
    target,
    {
      renderFrame: async (t, d) => {
        rendered.push(t);
        return new VideoSample(rgba, { format: 'RGBA', codedWidth: 1920, codedHeight: 1080, timestamp: t, duration: d });
      },
      encoder: mediabunnyEncoderFactory({ codec: 'avc', bitrate: 1e6 }),
      audio: plan.audio.copy ? copyAudioFeed(plan.audio.parts, sources) : null,
    },
  );
  return { buf: target.buffer!, stats, rendered };
}

test('書き出し：コピーした区間は元のパケットそのまま（キーフレームには SPS/PPS）、つなぎ目は再エンコード', async () => {
  const { buf, stats, rendered } = await exportSmart(docWith({ inPoint: 0.5, outPoint: 3.5 }), OUT);
  // 再エンコード：0〜0.5 秒（元 0.5〜1）と 2.5〜3 秒（元 3〜3.5）の 15 フレームずつ。時刻は元動画のフレームに合わせる
  assert.equal(rendered.length, 30);
  assert.ok(near(rendered[1] - rendered[0], 1 / 30, 1e-6));
  assert.equal(stats.copiedPackets, 60);
  assert.equal(stats.encodedPackets, 30);
  assert.equal(stats.demotedSections, 0);

  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(buf) });
  const vt = (await input.getPrimaryVideoTrack())!;
  const sink = new EncodedPacketSink(vt);
  const packets: EncodedPacket[] = [];
  for await (const p of sink.packets()) packets.push(p);
  assert.equal(packets.length, 90);
  // 時刻が隙間なく並ぶ
  packets.forEach((p, i) => assert.ok(near(p.timestamp, i / 30, 2e-3), `パケット ${i} の時刻 ${p.timestamp}`));
  // 0.5 秒（元の 1 秒）から元のキーフレーム：SPS / PPS を先頭に入れた元のデータ
  const k = packets[15];
  assert.equal(k.type, 'key');
  assert.deepEqual(nalTypes('avc', k.data), [7, 8, 5]);
  assert.deepEqual([...splitLengthPrefixed(k.data)[2]], [0x65, 0x88, 30]);
  // コピーの途中のフレームは元のまま
  assert.deepEqual([...packets[16].data], [...lp([0x41, 0x9a, 31])]);
  // 再エンコードの区間の先頭はキーフレームで、エンコーダーの SPS / PPS が入る
  assert.equal(packets[0].type, 'key');
  assert.deepEqual(nalTypes('avc', packets[0].data), [7, 8, 5]);
  assert.equal(splitLengthPrefixed(packets[0].data)[0][3], 0x29, 'エンコーダーの SPS（レベル 4.1）');
  assert.equal(packets[75].type, 'key');
  // 長さ
  assert.ok(Math.abs((await input.computeDuration()) - 3) < 0.05);
  // 音声もコピー（約 3 秒ぶん）
  const at = (await input.getPrimaryAudioTrack())!;
  const stats2 = await at.computePacketStats();
  assert.ok(Math.abs(stats2.packetCount - Math.round((3 * 48000) / 1024)) <= 2, `音声パケット ${stats2.packetCount}`);
});

test('書き出し：キーフレームちょうどで切れば全部コピー', async () => {
  const { stats, rendered } = await exportSmart(docWith({ inPoint: 1, outPoint: 3 }), { ...OUT, to: 2 });
  assert.equal(rendered.length, 0);
  assert.equal(stats.copiedPackets, 60);
  assert.equal(stats.encodedPackets, 0);
});
