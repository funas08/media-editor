// 動画ファイルの中身を表示する：npm run inspect-video <ファイル>
// （ブラウザで書き出した MP4 の長さ・解像度・トラック数などを確認するため）
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';

const file = process.argv[2];
if (!file) {
  console.error('使い方：npm run inspect-video <動画ファイル>');
  process.exit(1);
}
const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
const format = await input.getFormat();
const tracks = await input.getTracks();
console.log(`ファイル：${file}`);
console.log(`形式：${format.name}`);
console.log(`長さ：${(await input.computeDuration()).toFixed(3)} 秒`);
console.log(`トラック数：${tracks.length}`);
for (const t of tracks) {
  if (t.isVideoTrack()) {
    const stats = await t.computePacketStats();
    console.log(`  映像：${t.codec}  ${await t.getDisplayWidth()}×${await t.getDisplayHeight()}  ${stats.averagePacketRate.toFixed(2)} fps  ${stats.packetCount} フレーム  ${(stats.averageBitrate / 1e6).toFixed(2)} Mbps`);
  } else if (t.isAudioTrack()) {
    const stats = await t.computePacketStats();
    console.log(`  音声：${t.codec}  ${t.sampleRate} Hz  ${t.numberOfChannels} ch  ${(stats.averageBitrate / 1000).toFixed(0)} kbps`);
  } else {
    console.log(`  その他：${t.type}`);
  }
}
input.dispose();
