// 動画ファイルの中身を表示する：npm run inspect-video <ファイル> [<ファイル>...]
// （ブラウザで書き出した MP4 と元の動画の、長さ・解像度・ビットレート・プロファイル・色空間などを比べるため）
import { statSync } from 'node:fs';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { createServer } from 'vite';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('使い方：npm run inspect-video <動画ファイル> [<動画ファイル>...]');
  process.exit(1);
}

// 表示用の関数はアプリと同じもの（src/media）を Vite の SSR ローダーで読み込んで使う
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { describeCodec } = await server.ssrLoadModule('/src/media/codecName.ts');
const { describeColorSpace } = await server.ssrLoadModule('/src/media/encodeSettings.ts');

const mbps = (bps) => `${(bps / 1e6).toFixed(2)} Mbps`;

let failed = false;
for (const file of files) {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
  try {
    const format = await input.getFormat();
    const tracks = await input.getTracks();
    const duration = await input.computeDuration();
    const size = statSync(file).size;
    console.log(`ファイル：${file}`);
    console.log(`形式：${format.name}`);
    console.log(`サイズ：${(size / 1e6).toFixed(1)} MB（全体の平均 ${mbps((size * 8) / duration)}）`);
    console.log(`長さ：${duration.toFixed(3)} 秒`);
    console.log(`トラック数：${tracks.length}`);
    for (const t of tracks) {
      if (t.isVideoTrack()) {
        const stats = await t.computePacketStats();
        const codec = await t.getCodecParameterString().catch(() => null);
        const cs = await t.getColorSpace().catch(() => null);
        const hdr = await t.hasHighDynamicRange().catch(() => false);
        console.log(`  映像：${t.codec}  ${await t.getDisplayWidth()}×${await t.getDisplayHeight()}  ${stats.averagePacketRate.toFixed(2)} fps  ${stats.packetCount} フレーム`);
        console.log(`    ビットレート：${mbps(stats.averageBitrate)}`);
        console.log(`    コーデック：${describeCodec(codec ?? t.codec)}`);
        console.log(`    色空間：${describeColorSpace(cs)}${hdr ? '（HDR）' : ''}`);
        console.log(`      （primaries=${cs?.primaries ?? '-'} transfer=${cs?.transfer ?? '-'} matrix=${cs?.matrix ?? '-'} fullRange=${cs?.fullRange ?? '-'}）`);
      } else if (t.isAudioTrack()) {
        const stats = await t.computePacketStats();
        console.log(`  音声：${t.codec}  ${t.sampleRate} Hz  ${t.numberOfChannels} ch  ${(stats.averageBitrate / 1000).toFixed(0)} kbps`);
      } else {
        console.log(`  その他：${t.type}`);
      }
    }
  } catch (e) {
    failed = true;
    console.error(`${file}：読み込めませんでした（${e instanceof Error ? e.message : String(e)}）`);
  } finally {
    input.dispose();
  }
  if (files.length > 1) console.log('');
}
await server.close();
process.exit(failed ? 1 : 0);
