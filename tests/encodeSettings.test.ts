import assert from 'node:assert/strict';
import { ALL_FORMATS, BufferSource, BufferTarget, Input, VideoSample } from 'mediabunny';
import { createDoc, createVideoItem } from '../src/core/doc';
import { describeCodec, parseCodec } from '../src/media/codecName';
import {
  codecFamily,
  estimateFileSize,
  exportKeyFrameInterval,
  pickHighestSource,
  mainVideoMediaIds,
  outputColorSpace,
  resolveBitrate,
  rgbaToI420,
  scaledMainClips,
  standardBitrate,
} from '../src/media/encodeSettings';
import { runExport } from '../src/media/exportPipeline';
import { registerFakeEncoders } from './fakeEncoders';
import { test } from './harness';

test('画質：標準のビットレート（WQHD 30/60fps、4K 30/60fps の目安どおり）', () => {
  assert.equal(standardBitrate(2560, 1440, 30), 16e6);
  assert.equal(standardBitrate(2560, 1440, 60), 24e6);
  assert.equal(standardBitrate(3840, 2160, 30), 40e6);
  assert.equal(standardBitrate(3840, 2160, 60), 60e6);
  // FHD は WQHD より小さい
  assert.ok(standardBitrate(1920, 1080, 30) < 16e6 && standardBitrate(1920, 1080, 30) > 5e6);
});

test('画質：高画質 1.5 倍・小さいファイル 0.6 倍・指定・元の動画に合わせる', () => {
  const size = { width: 2560, height: 1440, fps: 30 };
  assert.equal(resolveBitrate('high', size, null, 0).bitrate, 24e6);
  assert.equal(resolveBitrate('small', size, null, 0).bitrate, 9.6e6);
  assert.equal(resolveBitrate('custom', size, null, 35).bitrate, 35e6);
  // 元が H.264 なら、元のビットレート × 1.3（再エンコードの劣化を補う）
  assert.deepEqual(resolveBitrate('source', size, { bitrate: 20e6, codec: 'avc1.640033' }, 0), { bitrate: 26e6, quantizer: null, fellBack: false, capped: false });
  // 元のビットレートが分からなければ標準
  assert.deepEqual(resolveBitrate('source', size, null, 0), { bitrate: 16e6, quantizer: null, fellBack: true, capped: false });
});

test('画質：元が H.265 / AV1 なら H.264 換算で上げる。上限は標準の 4 倍', () => {
  const size = { width: 2560, height: 1440, fps: 30 };
  // H.265 20Mbps → H.264 換算 32Mbps → ×1.3 = 41.6Mbps
  assert.equal(resolveBitrate('source', size, { bitrate: 20e6, codec: 'hvc1.1.6.L153.B0' }, 0).bitrate, 41.6e6);
  // AV1 10Mbps → H.264 換算 20Mbps → ×1.3 = 26Mbps
  assert.equal(resolveBitrate('source', size, { bitrate: 10e6, codec: 'av01.0.08M.08' }, 0).bitrate, 26e6);
  // 書き出しも H.265 なら、H.265 同士（書き出し側の効率は控えめ）：20 / 0.625 × 0.75 × 1.3 = 31.2Mbps
  assert.equal(resolveBitrate('source', size, { bitrate: 20e6, codec: 'hevc' }, 0, 'hevc').bitrate, 31.2e6);
  // ProRes など非常に高いもの：標準 16Mbps × 4 = 64Mbps で止める
  const pro = resolveBitrate('source', size, { bitrate: 200e6, codec: 'prores' }, 0);
  assert.deepEqual([pro.bitrate, pro.capped], [64e6, true]);
});

test('画質：複数の元動画では、書き出しで最も高いビットレートが必要なものを基準にする', () => {
  const a = { bitrate: 30e6, codec: 'avc1.640033' };
  const b = { bitrate: 20e6, codec: 'hvc1.1.6.L153.B0' };
  assert.equal(pickHighestSource([a, b], 'avc'), b);
  assert.equal(pickHighestSource([], 'avc'), null);
});

test('画質：最高画質は品質固定（H.264 / H.265 は QP 18）、使えない場合のビットレートは標準の 2.5 倍', () => {
  const size = { width: 2560, height: 1440, fps: 30 };
  assert.deepEqual(resolveBitrate('max', size, null, 0), { bitrate: 40e6, quantizer: 18, fellBack: false, capped: false });
  assert.equal(resolveBitrate('max', size, null, 0, 'av1').quantizer, 90);
  // H.265 の標準は H.264 の 0.75 倍
  assert.equal(standardBitrate(2560, 1440, 30, 'hevc'), 12e6);
});

test('キーフレーム間隔：元に合わせて 1〜5 秒、分からなければ 2 秒', () => {
  assert.equal(exportKeyFrameInterval(1.001), 1);
  assert.equal(exportKeyFrameInterval(4.2), 4.2);
  assert.equal(exportKeyFrameInterval(10), 5);
  assert.equal(exportKeyFrameInterval(0.5), 1);
  assert.equal(exportKeyFrameInterval(null), 2);
  assert.equal(codecFamily('avc1.640033'), 'avc');
  assert.equal(codecFamily('hev1.1.6.L93.B0'), 'hevc');
});

test('画質：予想ファイルサイズ', () => {
  // 映像 16Mbps + 音声 192kbps で 60 秒 ≒ 121MB
  const b = estimateFileSize(16e6, 192e3, 60);
  assert.ok(b > 121e6 && b < 123e6, String(b));
});

test('メインの動画の元動画と、拡大・縮小されるクリップの検出', () => {
  const doc = createDoc(2560, 1440);
  const fhd = createVideoItem({ id: 'a', name: 'a.mp4', width: 1920, height: 1080, duration: 5 }, 1280, 720);
  const same = createVideoItem({ id: 'b', name: 'b.mp4', width: 2560, height: 1440, duration: 5 }, 1280, 720);
  fhd.scaleX = fhd.scaleY = 2560 / 1920;
  doc.items.push(fhd, same);
  assert.deepEqual(mainVideoMediaIds(doc), ['a', 'b']);
  assert.deepEqual(scaledMainClips(doc, 1), [{ srcW: 1920, srcH: 1080, outW: 2560, outH: 1440 }]);
  // 倍率 1.5 で書き出すと、同じサイズだった動画も拡大になる
  assert.equal(scaledMainClips(doc, 1.5).length, 2);
});

test('色空間：元動画の BT.709 / BT.601 を引き継ぎ、HDR や不明なら BT.709', () => {
  assert.deepEqual(outputColorSpace({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }), { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
  assert.deepEqual(outputColorSpace({ primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: true }), {
    primaries: 'smpte170m',
    transfer: 'smpte170m',
    matrix: 'smpte170m',
    fullRange: true,
  });
  assert.equal(outputColorSpace({ primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false }).matrix, 'bt709');
  assert.equal(outputColorSpace(null).matrix, 'bt709');
});

function solid(r: number, g: number, b: number, w = 4, h = 2): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set([r, g, b, 255], i * 4);
  return a;
}

test('RGB → YUV（BT.709 リミテッド）：白 235・黒 16・灰色は色差 128・赤の値', () => {
  const lim = { matrix: 'bt709' as const, fullRange: false };
  const yuv = (r: number, g: number, b: number) => {
    const o = rgbaToI420(solid(r, g, b), 4, 2, lim);
    return [o[0], o[8], o[10]];
  };
  assert.deepEqual(yuv(255, 255, 255), [235, 128, 128]);
  assert.deepEqual(yuv(0, 0, 0), [16, 128, 128]);
  assert.deepEqual(yuv(128, 128, 128), [126, 128, 128]);
  // BT.709 の赤：Y ≒ 63、U ≒ 102、V = 240
  assert.deepEqual(yuv(255, 0, 0), [63, 102, 240]);
});

test('RGB → YUV：BT.601 とフルレンジ（色差が 255 を超えない）', () => {
  const o601 = rgbaToI420(solid(255, 0, 0), 4, 2, { matrix: 'smpte170m', fullRange: false });
  assert.equal(o601[0], 81);
  const full = rgbaToI420(solid(0, 0, 255), 4, 2, { matrix: 'bt709', fullRange: true });
  assert.deepEqual([full[0], full[8]], [18, 255]);
  const white = rgbaToI420(solid(255, 255, 255), 4, 2, { matrix: 'bt709', fullRange: true });
  assert.deepEqual([white[0], white[8], white[10]], [255, 128, 128]);
});

test('RGB → YUV：色差は 2×2 の平均、大きさは幅×高さ×1.5', () => {
  const w = 4;
  const h = 2;
  const a = solid(0, 0, 0, w, h);
  // 左上の 2×2 だけ白
  for (const i of [0, 1, 4, 5]) a.set([255, 255, 255, 255], i * 4);
  const o = rgbaToI420(a, w, h, { matrix: 'bt709', fullRange: false });
  assert.equal(o.length, w * h * 1.5);
  assert.deepEqual([o[0], o[2], o[8], o[9]], [235, 16, 128, 128]);
});

test('コーデック名：H.264 のプロファイルとレベル', () => {
  assert.deepEqual(parseCodec('avc1.640033'), { name: 'H.264', profile: 'High', level: '5.1' });
  assert.deepEqual(parseCodec('avc1.42c01f'), { name: 'H.264', profile: 'Constrained Baseline', level: '3.1' });
  assert.equal(parseCodec('avc1.4d0028')?.profile, 'Main');
  assert.equal(describeCodec('avc1.640033'), 'H.264 High プロファイル・レベル 5.1（avc1.640033）');
  assert.equal(parseCodec('hvc1.1.6.L153.B0')?.level, '5.1');
  assert.equal(describeCodec(null), '不明');
});

test('書き出し：品質固定（量子化値）の指定でも書き出せる', async () => {
  registerFakeEncoders();
  const target = new BufferTarget();
  const yuv = new Uint8Array(64 * 36 * 1.5);
  let mode: string | undefined;
  await runExport(
    { width: 64, height: 36, fps: 30, duration: 0.5, videoCodec: 'vp9', videoBitrate: 2e6, videoQuantizer: 30, keyFrameInterval: 4, audio: null, onEncoderConfig: (c) => (mode = c.bitrateMode) },
    target,
    { renderFrame: async (t) => new VideoSample(yuv, { format: 'I420', codedWidth: 64, codedHeight: 36, timestamp: t, duration: 1 / 30 }) },
  );
  assert.equal(mode, 'quantizer');
  assert.ok(target.buffer && target.buffer.byteLength > 0);
});

test('書き出し：YUV（I420）のフレームを渡せて、MP4 に色空間の情報が入る（エンコーダーが返さなくても）', async () => {
  registerFakeEncoders();
  const target = new BufferTarget();
  const cs = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const;
  const yuv = rgbaToI420(solid(10, 200, 30, 64, 36), 64, 36, cs);
  await runExport(
    { width: 64, height: 36, fps: 30, duration: 1, videoCodec: 'vp9', videoBitrate: 2e6, audio: null, colorSpace: cs },
    target,
    { renderFrame: async (t) => new VideoSample(yuv, { format: 'I420', codedWidth: 64, codedHeight: 36, timestamp: t, duration: 1 / 30, colorSpace: cs }) },
  );
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(target.buffer!) });
  const v = await input.getPrimaryVideoTrack();
  assert.deepEqual(await v?.getColorSpace(), cs);
  assert.equal((await v?.computePacketStats())?.packetCount, 30);
  input.dispose();
});
