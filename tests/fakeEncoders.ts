// テスト用の仮エンコーダー（Node には WebCodecs がないため）。
// 中身のないパケットを出すだけだが、MP4 の構造（長さ・解像度・トラック数）は本物と同じように作られる。
// 映像は VP9 として登録する（H.264 は SPS/PPS の実データが必要なため。本番は H.264）。

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
  registerEncoder(FakeAacEncoder);
}
