// コーデック文字列（例：avc1.640033）を、プロファイルとレベルの分かる日本語の名前にする。

const AVC_PROFILES: Record<number, string> = {
  66: 'Baseline',
  77: 'Main',
  88: 'Extended',
  100: 'High',
  110: 'High 10',
  122: 'High 4:2:2',
  244: 'High 4:4:4',
};

const HEVC_PROFILES: Record<number, string> = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions' };

export interface CodecDetails {
  /** H.264 / H.265 などの名前 */
  name: string;
  profile: string | null;
  level: string | null;
}

/** コーデック文字列を読み取る（分からない部分は null） */
export function parseCodec(codec: string | null | undefined): CodecDetails | null {
  if (!codec) return null;
  const avc = /^(?:avc[13])\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(codec);
  if (avc) {
    const profile = parseInt(avc[1], 16);
    const constraint = parseInt(avc[2], 16);
    const level = parseInt(avc[3], 16);
    let p = AVC_PROFILES[profile] ?? `プロファイル ${profile}`;
    if (profile === 66 && constraint & 0x40) p = 'Constrained Baseline';
    return { name: 'H.264', profile: p, level: (level / 10).toFixed(1) };
  }
  const hevc = /^(?:hvc1|hev1)\.([A-C]?)(\d+)\.[0-9a-f]+\.([LH])(\d+)/i.exec(codec);
  if (hevc) {
    const profile = Number(hevc[2]);
    return { name: 'H.265', profile: HEVC_PROFILES[profile] ?? `プロファイル ${profile}`, level: (Number(hevc[4]) / 30).toFixed(1) };
  }
  const short: Record<string, string> = { avc: 'H.264', hevc: 'H.265', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', vp09: 'VP9', av01: 'AV1' };
  const head = codec.split('.')[0].toLowerCase();
  return { name: short[head] ?? codec, profile: null, level: null };
}

/** 例：「H.264 High プロファイル・レベル 5.1（avc1.640033）」 */
export function describeCodec(codec: string | null | undefined): string {
  const d = parseCodec(codec);
  if (!d) return '不明';
  const parts = [d.name];
  if (d.profile) parts.push(`${d.profile} プロファイル`);
  const main = parts.join(' ') + (d.level ? `・レベル ${d.level}` : '');
  return codec && codec.includes('.') ? `${main}（${codec}）` : main;
}
