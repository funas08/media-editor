// H.264 / H.265 の圧縮データ（NAL ユニット）を扱う小さな関数群（ブラウザに依存しない）。
// 無劣化コピーで、元動画のパケットと再エンコードしたパケットを1本の映像トラックにつなぐために使う。
// - MP4 の中のパケットは「長さ＋NAL」の並び（AVCC 形式。長さは 4 バイトにそろえる）
// - ffmpeg の出力（MPEG-TS の中身）は「開始コード＋NAL」の並び（Annex B 形式）
// - つなぎ目でデコードの設定（SPS / PPS など）が変わるので、キーフレームごとに設定を入れておく

export type NalCodec = 'avc' | 'hevc';

/** NAL ユニットの種類 */
export function nalType(codec: NalCodec, nal: Uint8Array): number {
  return codec === 'avc' ? nal[0] & 0x1f : (nal[0] >> 1) & 0x3f;
}

/** デコードの設定（H.264：SPS 7・PPS 8、H.265：VPS 32・SPS 33・PPS 34） */
export function isParamSet(codec: NalCodec, type: number): boolean {
  return codec === 'avc' ? type === 7 || type === 8 : type >= 32 && type <= 34;
}

/** 前のフレームを参照せずにデコードを始められるフレーム（H.264：IDR、H.265：IRAP） */
export function isRandomAccess(codec: NalCodec, type: number): boolean {
  return codec === 'avc' ? type === 5 : type >= 16 && type <= 23;
}

/** 映像の中身（スライス）の NAL か */
function isSlice(codec: NalCodec, type: number): boolean {
  return codec === 'avc' ? type >= 1 && type <= 5 : type <= 21;
}

/** 長さ付き（AVCC）のパケットを NAL ユニットに分ける */
export function splitLengthPrefixed(data: Uint8Array, lengthSize = 4): Uint8Array[] {
  const out: Uint8Array[] = [];
  let p = 0;
  while (p + lengthSize <= data.length) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = len * 256 + data[p + i];
    p += lengthSize;
    if (len === 0 || p + len > data.length) break;
    out.push(data.subarray(p, p + len));
    p += len;
  }
  return out;
}

/** 開始コード（00 00 01 / 00 00 00 01）区切り（Annex B）のデータを NAL ユニットに分ける */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; body: number }[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push({ at: i > 0 && data[i - 1] === 0 ? i - 1 : i, body: i + 3 });
      i += 2;
    }
  }
  const out: Uint8Array[] = [];
  for (let k = 0; k < starts.length; k++) {
    let end = k + 1 < starts.length ? starts[k + 1].at : data.length;
    // 次の開始コードの前の 0 は除く（trailing_zero_8bits）
    while (end > starts[k].body && data[end - 1] === 0) end--;
    if (end > starts[k].body) out.push(data.subarray(starts[k].body, end));
  }
  return out;
}

/** NAL ユニットを 4 バイトの長さ付きでつなぐ */
export function joinLengthPrefixed(nals: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nals.reduce((s, n) => s + 4 + n.length, 0));
  let p = 0;
  for (const n of nals) {
    out[p] = n.length >>> 24;
    out[p + 1] = (n.length >>> 16) & 0xff;
    out[p + 2] = (n.length >>> 8) & 0xff;
    out[p + 3] = n.length & 0xff;
    out.set(n, p + 4);
    p += 4 + n.length;
  }
  return out;
}

/** デコーダー設定レコード（avcC / hvcC）から分かること */
export interface DecoderRecord {
  codec: NalCodec;
  /** パケットの長さの欄のバイト数 */
  lengthSize: number;
  /** SPS・PPS など（VPS → SPS → PPS の順） */
  paramSets: Uint8Array[];
}

/** avcC（AVCDecoderConfigurationRecord）・hvcC（HEVCDecoderConfigurationRecord）を読む。読めなければ null */
export function parseDecoderRecord(codec: NalCodec, desc: Uint8Array): DecoderRecord | null {
  try {
    const sets: Uint8Array[] = [];
    if (codec === 'avc') {
      if (desc.length < 7 || desc[0] !== 1) return null;
      const lengthSize = (desc[4] & 3) + 1;
      let p = 5;
      const nSps = desc[p++] & 0x1f;
      for (let i = 0; i < nSps; i++) {
        const len = (desc[p] << 8) | desc[p + 1];
        sets.push(desc.subarray(p + 2, p + 2 + len));
        p += 2 + len;
      }
      const nPps = desc[p++];
      for (let i = 0; i < nPps; i++) {
        const len = (desc[p] << 8) | desc[p + 1];
        sets.push(desc.subarray(p + 2, p + 2 + len));
        p += 2 + len;
      }
      if (p > desc.length) return null;
      return { codec, lengthSize, paramSets: sets };
    }
    if (desc.length < 23) return null;
    const lengthSize = (desc[21] & 3) + 1;
    let p = 23;
    const nArrays = desc[22];
    const byType = new Map<number, Uint8Array[]>();
    for (let a = 0; a < nArrays; a++) {
      const type = desc[p] & 0x3f;
      const n = (desc[p + 1] << 8) | desc[p + 2];
      p += 3;
      for (let i = 0; i < n; i++) {
        const len = (desc[p] << 8) | desc[p + 1];
        const nal = desc.subarray(p + 2, p + 2 + len);
        p += 2 + len;
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type)!.push(nal);
      }
    }
    if (p > desc.length) return null;
    for (const t of [32, 33, 34]) sets.push(...(byType.get(t) ?? []));
    return { codec, lengthSize, paramSets: sets };
  } catch {
    return null;
  }
}

/** 長さの欄を 4 バイトにした設定レコード（元が 4 バイトならそのまま） */
export function withLengthSize4(codec: NalCodec, desc: Uint8Array): Uint8Array {
  const out = desc.slice();
  if (codec === 'avc') out[4] = (out[4] & 0xfc) | 3;
  else out[21] = (out[21] & 0xfc) | 3;
  return out;
}

/**
 * 4 バイトの長さ付きパケットにそろえ、キーフレームには（まだ入っていなければ）デコードの設定を先頭に入れる。
 * 元動画の区間と再エンコードした区間で設定が違っても、それぞれのキーフレームから正しくデコード・シークできるようにする
 */
export function normalizePacket(codec: NalCodec, nals: Uint8Array[], key: boolean, paramSets: Uint8Array[]): Uint8Array {
  if (!key || paramSets.length === 0 || nals.some((n) => isParamSet(codec, nalType(codec, n)))) return joinLengthPrefixed(nals);
  // アクセスユニット区切り（AUD）があればその後ろに入れる（H.264：9、H.265：35）
  const aud = codec === 'avc' ? 9 : 35;
  const head = nals.length > 0 && nalType(codec, nals[0]) === aud ? 1 : 0;
  return joinLengthPrefixed([...nals.slice(0, head), ...paramSets, ...nals.slice(head)]);
}

/** パケットの最初のスライスの種類（スライスがなければ null） */
export function firstSliceType(codec: NalCodec, nals: Uint8Array[]): number | null {
  for (const n of nals) {
    const t = nalType(codec, n);
    if (isSlice(codec, t)) return t;
  }
  return null;
}

/** 4 バイトの長さ付きデータを 1 つの数値の配列に（テスト・表示用） */
export function nalTypes(codec: NalCodec, data: Uint8Array): number[] {
  return splitLengthPrefixed(data).map((n) => nalType(codec, n));
}

// ---- 設定レコードを作る（ffmpeg の出力など、設定レコードがないとき） ----

/** NAL から防止バイト（00 00 03 の 03）を除く */
function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return new Uint8Array(out);
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

/**
 * SPS / PPS（H.265 は VPS も）から avcC / hvcC を作る。映像は 4:2:0・8 ビット（ブラウザから送るフレーム）とする
 */
export function buildDecoderRecord(codec: NalCodec, paramSets: Uint8Array[]): Uint8Array | null {
  const of = (t: number) => paramSets.filter((n) => nalType(codec, n) === t);
  if (codec === 'avc') {
    const sps = of(7);
    const pps = of(8);
    if (!sps.length || !pps.length || sps[0].length < 4) return null;
    const profile = sps[0][1];
    const bytes = [1, profile, sps[0][2], sps[0][3], 0xff, 0xe0 | sps.length];
    for (const s of sps) bytes.push(...u16(s.length), ...s);
    bytes.push(pps.length);
    for (const s of pps) bytes.push(...u16(s.length), ...s);
    // High 系のプロファイルでは色差の形式とビット深度を書く（4:2:0・8 ビット）
    if ([100, 110, 122, 144].includes(profile)) bytes.push(0xfc | 1, 0xf8, 0xf8, 0);
    return new Uint8Array(bytes);
  }
  const vps = of(32);
  const sps = of(33);
  const pps = of(34);
  if (!vps.length || !sps.length || !pps.length) return null;
  // SPS の profile_tier_level（全体部分の 12 バイト）は NAL ヘッダ 2 バイト＋1 バイトの後ろにある
  const rbsp = unescapeRbsp(sps[0]);
  if (rbsp.length < 15) return null;
  const ptl = rbsp.subarray(3, 15);
  const bytes = [
    1,
    ...ptl.subarray(0, 1), // profile_space・tier・profile_idc
    ...ptl.subarray(1, 5), // profile_compatibility_flags
    ...ptl.subarray(5, 11), // constraint_indicator_flags
    ptl[11], // level_idc
    0xf0, 0x00, // min_spatial_segmentation_idc
    0xfc, // parallelismType
    0xfc | 1, // chroma_format_idc（4:2:0）
    0xf8, // bit_depth_luma_minus8
    0xf8, // bit_depth_chroma_minus8
    0, 0, // avgFrameRate
    // constantFrameRate 0・numTemporalLayers 1・temporalIdNested 1・lengthSizeMinusOne 3
    (1 << 3) | (1 << 2) | 3,
    3,
  ];
  for (const [t, list] of [[32, vps], [33, sps], [34, pps]] as const) {
    bytes.push(0x80 | t, ...u16(list.length));
    for (const s of list) bytes.push(...u16(s.length), ...s);
  }
  return new Uint8Array(bytes);
}
