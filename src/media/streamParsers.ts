// ffmpeg の出力を読む小さなパーサ（ブラウザに依存しない）。
// - 映像：MPEG-TS（188 バイトのパケット）から映像の PES を取り出す。1 つの PES = 1 フレーム（Annex B）と PTS / DTS
// - 音声：ADTS（AAC のフレームごとのヘッダ付き）から AAC のフレームを取り出す
// データは少しずつ届くので、どちらも push で受け取り、できた分を返す。

export interface TsFrame {
  /** Annex B（開始コード区切り）の映像データ */
  data: Uint8Array;
  /** 表示時刻（90kHz） */
  pts: number;
  /** デコード時刻（90kHz） */
  dts: number;
}

const TS_SIZE = 188;

/** 33 ビットの PTS / DTS を読む */
function readTimestamp(b: Uint8Array, p: number): number {
  return (((b[p] >> 1) & 0x07) * 2 ** 30) + (((b[p + 1] << 7) | (b[p + 2] >> 1)) * 2 ** 15) + ((b[p + 3] << 7) | (b[p + 4] >> 1));
}

/** MPEG-TS から映像（stream_id 0xE0〜0xEF）の PES を取り出す */
export class TsVideoDemuxer {
  private rest = new Uint8Array(0);
  private videoPid: number | null = null;
  private chunks: Uint8Array[] = [];
  private size = 0;

  /** データを加え、できあがったフレームを返す */
  push(data: Uint8Array): TsFrame[] {
    const buf = this.rest.length ? concat([this.rest, data]) : data;
    const out: TsFrame[] = [];
    let p = 0;
    while (p + TS_SIZE <= buf.length) {
      if (buf[p] !== 0x47) {
        // 同期がずれたら次の 0x47 を探す
        p++;
        continue;
      }
      this.packet(buf.subarray(p, p + TS_SIZE), out);
      p += TS_SIZE;
    }
    this.rest = buf.slice(p);
    return out;
  }

  /** 最後のフレームを取り出す */
  flush(): TsFrame[] {
    const out: TsFrame[] = [];
    this.emit(out);
    return out;
  }

  private packet(pkt: Uint8Array, out: TsFrame[]): void {
    const pusi = (pkt[1] & 0x40) !== 0;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const afc = (pkt[3] >> 4) & 3;
    let p = 4;
    if (afc === 2) return; // 中身なし
    if (afc === 3) p += 1 + pkt[4];
    if (p >= TS_SIZE) return;
    const payload = pkt.subarray(p);
    if (pusi && payload.length > 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
      const sid = payload[3];
      if (sid >= 0xe0 && sid <= 0xef && (this.videoPid === null || this.videoPid === pid)) {
        this.videoPid = pid;
        this.emit(out);
        this.chunks.push(payload);
        this.size = payload.length;
        return;
      }
    }
    if (pid === this.videoPid && this.chunks.length) {
      this.chunks.push(payload);
      this.size += payload.length;
    }
  }

  private emit(out: TsFrame[]): void {
    if (!this.chunks.length) return;
    const pes = concat(this.chunks, this.size);
    this.chunks = [];
    this.size = 0;
    const flags = pes[7];
    const headerLen = pes[8];
    const hasPts = (flags & 0x80) !== 0;
    const hasDts = (flags & 0x40) !== 0;
    if (!hasPts) return;
    const pts = readTimestamp(pes, 9);
    const dts = hasDts ? readTimestamp(pes, 14) : pts;
    out.push({ data: pes.subarray(9 + headerLen), pts, dts });
  }
}

export interface AdtsFrame {
  /** AAC の中身（ヘッダを除く） */
  data: Uint8Array;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig（MP4 の esds に入れる 2 バイト） */
  config: Uint8Array;
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** ADTS のストリームから AAC のフレームを取り出す */
export class AdtsParser {
  private rest = new Uint8Array(0);

  push(data: Uint8Array): AdtsFrame[] {
    const buf = this.rest.length ? concat([this.rest, data]) : data;
    const out: AdtsFrame[] = [];
    let p = 0;
    while (p + 7 <= buf.length) {
      if (buf[p] !== 0xff || (buf[p + 1] & 0xf6) !== 0xf0) {
        p++;
        continue;
      }
      const protectionAbsent = buf[p + 1] & 1;
      const objectType = ((buf[p + 2] >> 6) & 3) + 1;
      const rateIndex = (buf[p + 2] >> 2) & 0x0f;
      const channels = ((buf[p + 2] & 1) << 2) | (buf[p + 3] >> 6);
      const frameLength = ((buf[p + 3] & 3) << 11) | (buf[p + 4] << 3) | (buf[p + 5] >> 5);
      const headerLen = protectionAbsent ? 7 : 9;
      if (frameLength < headerLen) {
        p++;
        continue;
      }
      if (p + frameLength > buf.length) break;
      const config = new Uint8Array([(objectType << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3)]);
      out.push({ data: buf.slice(p + headerLen, p + frameLength), sampleRate: ADTS_RATES[rateIndex] ?? 48000, channels, config });
      p += frameLength;
    }
    this.rest = buf.slice(p);
    return out;
  }
}

function concat(list: Uint8Array[], size = list.reduce((s, x) => s + x.length, 0)): Uint8Array {
  const out = new Uint8Array(size);
  let p = 0;
  for (const x of list) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}
