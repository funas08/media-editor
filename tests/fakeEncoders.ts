// テスト用の仮エンコーダー（Node には WebCodecs がないため）。
// 中身のないパケットを出すだけだが、MP4 の構造（長さ・解像度・トラック数）は本物と同じように作られる。
// 映像は VP9 として登録する（H.264 は SPS/PPS の実データが必要なため。本番は H.264）。
// 仮エンコーダーは色空間を返さない（返さないブラウザでも MP4 に色情報が入ることを確かめるため）。

import { CustomAudioEncoder, CustomVideoEncoder, EncodedPacket, registerEncoder, type AudioSample, type VideoSample } from 'mediabunny';

class FakeVideoEncoder extends CustomVideoEncoder {
  private n = 0;
  static override supports(codec: string): boolean {
    return codec === 'vp9';
  }
  init(): void {
    this.n = 0;
  }
  encode(sample: VideoSample): void {
    const key = this.n++ % 60 === 0;
    const meta = key ? { decoderConfig: { codec: 'vp09.00.31.08', codedWidth: this.config.width, codedHeight: this.config.height } } : undefined;
    this.onPacket(new EncodedPacket(new Uint8Array(16), key ? 'key' : 'delta', sample.timestamp, sample.duration), meta);
  }
  flush(): void {}
  close(): void {}
}

/** 仮の H.264 エンコーダー（無劣化コピーのつなぎ目のテスト用）。SPS のレベルを 4.1 にして元動画（4.0）と区別する */
const FAKE_SPS = [0x67, 0x64, 0x00, 0x29, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58];
const FAKE_PPS = [0x68, 0xee, 0x3c];
export const FAKE_AVCC = new Uint8Array([1, 0x64, 0, 0x29, 0xff, 0xe1, 0, FAKE_SPS.length, ...FAKE_SPS, 1, 0, FAKE_PPS.length, ...FAKE_PPS]);

class FakeAvcEncoder extends CustomVideoEncoder {
  private n = 0;
  static override supports(codec: string): boolean {
    return codec === 'avc';
  }
  init(): void {
    this.n = 0;
  }
  encode(sample: VideoSample): void {
    const key = this.n++ % 60 === 0;
    const nal = key ? [0x65, 0xee] : [0x41, 0xee];
    const meta = key ? { decoderConfig: { codec: 'avc1.640029', codedWidth: this.config.width, codedHeight: this.config.height, description: FAKE_AVCC } } : undefined;
    this.onPacket(new EncodedPacket(new Uint8Array([0, 0, 0, nal.length, ...nal]), key ? 'key' : 'delta', sample.timestamp, sample.duration), meta);
  }
  flush(): void {}
  close(): void {}
}

class FakeAacEncoder extends CustomAudioEncoder {
  private sent = false;
  static override supports(codec: string): boolean {
    return codec === 'aac';
  }
  init(): void {
    this.sent = false;
  }
  encode(sample: AudioSample): void {
    const meta = this.sent
      ? undefined
      : { decoderConfig: { codec: 'mp4a.40.2', sampleRate: this.config.sampleRate, numberOfChannels: this.config.numberOfChannels, description: new Uint8Array([0x11, 0x90]) } };
    this.sent = true;
    this.onPacket(new EncodedPacket(new Uint8Array(8), 'key', sample.timestamp, sample.duration), meta);
  }
  flush(): void {}
  close(): void {}
}

let registered = false;
export function registerFakeEncoders(): void {
  if (registered) return;
  registered = true;
  registerEncoder(FakeVideoEncoder);
  registerEncoder(FakeAvcEncoder);
  registerEncoder(FakeAacEncoder);
}
