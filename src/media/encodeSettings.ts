// 動画書き出しの画質設定（ブラウザに依存しない計算）：
// ビットレートの決め方、予想ファイルサイズ、拡大・縮小されるクリップの検出、色空間の決定と RGB → YUV（I420）変換。

import { itemSize } from '../core/geometry';
import { mainLayout } from '../core/timeline';
import type { DocState } from '../core/types';

/** 画質の選び方 */
export type QualityMode = 'smart' | 'source' | 'max' | 'high' | 'standard' | 'small' | 'custom';

export const QUALITY_MODE_LABEL: Record<QualityMode, string> = {
  smart: '元の画質を優先（可能な区間は無劣化コピー）',
  source: '元の動画に合わせる',
  max: '最高画質（品質固定）',
  high: '高画質',
  standard: '標準',
  small: '小さいファイル',
  custom: 'ビットレートを指定',
};

/** 書き出しの映像コーデック */
export type OutputCodec = 'avc' | 'hevc' | 'av1';

export const OUTPUT_CODEC_LABEL: Record<OutputCodec, string> = { avc: 'H.264', hevc: 'H.265（HEVC）', av1: 'AV1' };

/** エンコーダーの選び方 */
export type EncoderPref = 'auto' | 'hardware' | 'software';

export const ENCODER_PREF_LABEL: Record<EncoderPref, string> = { auto: '自動（ハードウェア優先）', hardware: 'ハードウェア', software: 'ソフトウェア' };

/** 「標準」に対する倍率 */
const MODE_FACTOR: Record<'high' | 'standard' | 'small', number> = { high: 1.5, standard: 1, small: 0.6 };

/**
 * 元動画のコーデックの効率（H.264 を 1 として、同じ画質に必要なビットレートの比）。
 * H.265 / VP9 は H.264 の約 1/1.6、AV1 は約 1/2 で同じ画質になる
 */
const SOURCE_EFFICIENCY: Record<string, number> = { avc: 1, hevc: 1 / 1.6, vp9: 1 / 1.6, av1: 1 / 2, vp8: 1.1 };

/**
 * 書き出しのコーデックの効率。ブラウザのエンコーダーは元の動画の作成元（カメラ・OBS など）より効率が落ちやすいので、
 * 元動画側の値より控えめにしている
 */
const OUTPUT_EFFICIENCY: Record<OutputCodec, number> = { avc: 1, hevc: 0.75, av1: 0.65 };

/** ブラウザのエンコーダー（B フレームや先読みが弱い）と、再エンコードによる劣化を補うための倍率 */
export const BROWSER_ENCODER_FACTOR = 1.3;

/** 「元の動画に合わせる」の上限（標準の何倍まで。ProRes などの非常に高いビットレートの元動画のため） */
const SOURCE_CAP = 4;

/** 「最高画質（品質固定）」で品質固定が使えないときのビットレート（標準の何倍） */
const MAX_FALLBACK_FACTOR = 2.5;

/** 音声のビットレート（AAC） */
export const AUDIO_BITRATE = 192_000;

const WQHD_PIXELS = 2560 * 1440;
const WQHD_30FPS = 16_000_000;
/** WQHD 16Mbps と 4K 40Mbps を通る曲線の指数（画素数 2.25 倍でビットレート 2.5 倍） */
const PIXEL_EXPONENT = Math.log(2.5) / Math.log(2.25);

/**
 * 「標準」のビットレート（bps）。H.264 の目安：WQHD 30fps 16Mbps・60fps 24Mbps、4K 30fps 40Mbps・60fps 60Mbps。
 * そのほかの解像度は画素数に応じて同じ曲線で決め、60fps は 30fps の 1.5 倍。H.265 / AV1 は効率のぶん下げる
 */
export function standardBitrate(width: number, height: number, fps: number, codec: OutputCodec = 'avc'): number {
  const base = WQHD_30FPS * Math.pow((width * height) / WQHD_PIXELS, PIXEL_EXPONENT);
  const k = fps >= 60 ? 1.5 : 1;
  return roundBitrate(base * k * OUTPUT_EFFICIENCY[codec]);
}

/** 0.1 Mbps 単位に丸める */
function roundBitrate(bps: number): number {
  return Math.max(100_000, Math.round(bps / 100_000) * 100_000);
}

/** コーデック名（avc / hevc / avc1.640033 など）から効率の表のキーを取り出す */
export function codecFamily(codec: string | null | undefined): string | null {
  if (!codec) return null;
  const head = codec.split('.')[0].toLowerCase();
  const map: Record<string, string> = { avc1: 'avc', avc3: 'avc', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', av01: 'av1' };
  return map[head] ?? head;
}

/** 元動画のビットレートとコーデック */
export interface SourceRate {
  bitrate: number;
  codec: string | null;
}

/** 元動画のビットレートを、書き出しのコーデックで同じ画質になるビットレートに換算する（補正の倍率は含めない） */
export function equivalentBitrate(src: SourceRate, out: OutputCodec): number {
  const eff = SOURCE_EFFICIENCY[codecFamily(src.codec) ?? 'avc'] ?? 1;
  return (src.bitrate / eff) * OUTPUT_EFFICIENCY[out];
}

/** 複数の元動画のうち、書き出しで最も高いビットレートが必要になるもの */
export function pickHighestSource(sources: SourceRate[], out: OutputCodec): SourceRate | null {
  let best: SourceRate | null = null;
  for (const s of sources) if (s.bitrate > 0 && (!best || equivalentBitrate(s, out) > equivalentBitrate(best, out))) best = s;
  return best;
}

export interface BitrateChoice {
  /** 映像のビットレート（bps）。品質固定のときは、品質固定が使えなかった場合のビットレート */
  bitrate: number;
  /** 品質固定（QP）の値。null ならビットレート指定 */
  quantizer: number | null;
  /** 「元の動画に合わせる」で元のビットレートが分からず、標準にしたとき true */
  fellBack: boolean;
  /** 「元の動画に合わせる」で上限に当たったとき true */
  capped: boolean;
}

/** 品質固定の値（H.264 / H.265 は QP 18。AV1 は Mediabunny の尺度 0〜255 で同じ程度の画質） */
export function maxQualityQuantizer(codec: OutputCodec): number {
  return codec === 'av1' ? 90 : 18;
}

/**
 * 画質の選び方からビットレートを決める。
 * source：メインの元動画のうち、書き出しで最も高いビットレートが必要になるもの（なければ null）
 */
export function resolveBitrate(
  mode: QualityMode,
  size: { width: number; height: number; fps: number },
  source: SourceRate | null,
  customMbps: number,
  codec: OutputCodec = 'avc',
): BitrateChoice {
  const std = standardBitrate(size.width, size.height, size.fps, codec);
  const plain = { quantizer: null, fellBack: false, capped: false };
  switch (mode) {
    // 無劣化コピーできない区間は「元の動画に合わせる」と同じビットレートで再エンコードする
    case 'smart':
    case 'source': {
      if (!source || !(source.bitrate > 0)) return { ...plain, bitrate: std, fellBack: true };
      const want = equivalentBitrate(source, codec) * BROWSER_ENCODER_FACTOR;
      const cap = std * SOURCE_CAP;
      return { ...plain, bitrate: roundBitrate(Math.min(want, cap)), capped: want > cap };
    }
    case 'max':
      return { ...plain, bitrate: roundBitrate(std * MAX_FALLBACK_FACTOR), quantizer: maxQualityQuantizer(codec) };
    case 'custom':
      return { ...plain, bitrate: roundBitrate(Math.max(0.1, customMbps || 0) * 1e6) };
    default:
      return { ...plain, bitrate: roundBitrate(std * MODE_FACTOR[mode]) };
  }
}

/** 元動画のキーフレーム間隔に合わせた、書き出しのキーフレーム間隔（秒）。1〜5 秒、分からなければ 2 秒 */
export function exportKeyFrameInterval(sourceInterval: number | null | undefined): number {
  if (!sourceInterval || !Number.isFinite(sourceInterval) || sourceInterval <= 0) return 2;
  return Math.min(5, Math.max(1, Math.round(sourceInterval * 10) / 10));
}

/** 予想ファイルサイズ（バイト）。可変ビットレートなので実際には前後する。MP4 の管理情報として 0.5% 足す */
export function estimateFileSize(videoBps: number, audioBps: number, duration: number): number {
  return ((videoBps + audioBps) * Math.max(0, duration)) / 8 * 1.005;
}

/** バイト数を「約 1.2 GB」のように表す */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function formatMbps(bps: number): string {
  return `${(bps / 1e6).toFixed(bps >= 10e6 ? 0 : 1)} Mbps`;
}

/** メインの動画クリップの元動画 ID（重複なし） */
export function mainVideoMediaIds(doc: DocState): string[] {
  const ids = new Set<string>();
  for (const s of mainLayout(doc)) if (s.item.type === 'video') ids.add(s.item.mediaId);
  return [...ids];
}

export interface ScaledClip {
  /** 元動画の（切り抜き後の）大きさ */
  srcW: number;
  srcH: number;
  /** 書き出しでの大きさ */
  outW: number;
  outH: number;
}

/**
 * メインの動画クリップのうち、書き出しで拡大・縮小されるもの（同じ大きさの組み合わせはまとめる）。
 * exportScale：キャンバスに対する書き出しの倍率
 */
export function scaledMainClips(doc: DocState, exportScale: number): ScaledClip[] {
  const out = new Map<string, ScaledClip>();
  for (const s of mainLayout(doc)) {
    const it = s.item;
    if (it.type !== 'video') continue;
    const { w, h } = itemSize(it);
    const outW = Math.round(w * exportScale);
    const outH = Math.round(h * exportScale);
    const srcW = Math.round(it.crop.w);
    const srcH = Math.round(it.crop.h);
    if (Math.abs(w * exportScale - it.crop.w) < 0.5 && Math.abs(h * exportScale - it.crop.h) < 0.5) continue;
    out.set(`${srcW}x${srcH}>${outW}x${outH}`, { srcW, srcH, outW, outH });
  }
  return [...out.values()];
}

// ---- 色空間 ----

/** 書き出しで使う色空間（WebCodecs の VideoColorSpaceInit と同じ形） */
export interface OutputColorSpace {
  primaries: 'bt709' | 'bt470bg' | 'smpte170m';
  transfer: 'bt709' | 'smpte170m' | 'iec61966-2-1';
  matrix: 'bt709' | 'bt470bg' | 'smpte170m';
  fullRange: boolean;
}

/** 元動画の色空間（分からない項目は null） */
export interface SourceColorSpace {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}

export const DEFAULT_COLOR_SPACE: OutputColorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

/**
 * 元動画の色空間から、書き出しの色空間を決める。SDR の BT.709 / BT.601 はそのまま引き継ぎ、
 * HDR（BT.2020 など）や不明な場合は BT.709（リミテッドレンジ）にする（Canvas は SDR のため）
 */
export function outputColorSpace(src: SourceColorSpace | null | undefined): OutputColorSpace {
  if (!src) return { ...DEFAULT_COLOR_SPACE };
  const matrices = ['bt709', 'bt470bg', 'smpte170m'] as const;
  const matrix = matrices.find((m) => m === src.matrix);
  if (!matrix) return { ...DEFAULT_COLOR_SPACE };
  const primaries = (['bt709', 'bt470bg', 'smpte170m'] as const).find((p) => p === src.primaries) ?? (matrix === 'bt709' ? 'bt709' : 'smpte170m');
  const transfer = (['bt709', 'smpte170m', 'iec61966-2-1'] as const).find((t) => t === src.transfer) ?? (matrix === 'bt709' ? 'bt709' : 'smpte170m');
  return { primaries, transfer, matrix, fullRange: src.fullRange === true };
}

/** 色空間を短い文字で表す（例：BT.709・リミテッド） */
export function describeColorSpace(c: SourceColorSpace | null | undefined): string {
  if (!c || (!c.matrix && !c.primaries && !c.transfer)) return '不明（情報なし）';
  const name = (v: string | null | undefined) =>
    v == null ? '?' : ({ bt709: 'BT.709', bt470bg: 'BT.601', smpte170m: 'BT.601', bt2020: 'BT.2020', 'bt2020-ncl': 'BT.2020', pq: 'PQ', hlg: 'HLG', 'iec61966-2-1': 'sRGB', rgb: 'RGB' } as Record<string, string>)[v] ?? v;
  const range = c.fullRange == null ? '' : c.fullRange ? '・フルレンジ' : '・リミテッド';
  return `行列 ${name(c.matrix)}・原色 ${name(c.primaries)}・伝達 ${name(c.transfer)}${range}`;
}

/** YUV 変換の係数（Kr, Kb） */
const MATRIX_K: Record<OutputColorSpace['matrix'], [number, number]> = {
  bt709: [0.2126, 0.0722],
  bt470bg: [0.299, 0.114],
  smpte170m: [0.299, 0.114],
};

/**
 * RGBA（Canvas の getImageData）を I420（Y 全面、U・V は 2×2 ごと）に変換する。幅・高さは偶数。
 * エンコーダーに任せると、ブラウザによって変換の行列やレンジが変わり色がずれることがあるため、自前で変換して色空間を明示する
 */
export function rgbaToI420(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, cs: Pick<OutputColorSpace, 'matrix' | 'fullRange'>, out?: Uint8Array): Uint8Array {
  const ySize = width * height;
  const cw = width >> 1;
  const ch = height >> 1;
  const cSize = cw * ch;
  const buf = out && out.length >= ySize + 2 * cSize ? out : new Uint8Array(ySize + 2 * cSize);
  const [kr, kb] = MATRIX_K[cs.matrix];
  const kg = 1 - kr - kb;
  // 出力のレンジ（リミテッド：Y 16〜235、UV 16〜240）
  const yScale = cs.fullRange ? 1 : 219 / 255;
  const yOff = cs.fullRange ? 0.5 : 16.5;
  const cScale = cs.fullRange ? 1 : 224 / 255;
  // 整数演算用の係数（16 ビット固定小数点）
  const F = 1 << 16;
  const yr = Math.round(kr * yScale * F);
  const yg = Math.round(kg * yScale * F);
  const yb = Math.round(kb * yScale * F);
  const yo = Math.round(yOff * F);
  // U = (B - Y) / (2(1 - Kb))、V = (R - Y) / (2(1 - Kr))
  const ur = Math.round((-kr / (2 * (1 - kb))) * cScale * F);
  const ug = Math.round((-kg / (2 * (1 - kb))) * cScale * F);
  const ub = Math.round(0.5 * cScale * F);
  const vr = ub;
  const vg = Math.round((-kg / (2 * (1 - kr))) * cScale * F);
  const vb = Math.round((-kb / (2 * (1 - kr))) * cScale * F);
  const co = Math.round(128.5 * F);
  for (let y = 0; y < height; y++) {
    let p = y * width * 4;
    let o = y * width;
    for (let x = 0; x < width; x++, p += 4, o++) {
      buf[o] = (yr * rgba[p] + yg * rgba[p + 1] + yb * rgba[p + 2] + yo) >> 16;
    }
  }
  // 色差は 2×2 の平均から作る
  const uBase = ySize;
  const vBase = ySize + cSize;
  const stride = width * 4;
  for (let cy = 0; cy < ch; cy++) {
    let p = cy * 2 * stride;
    let o = cy * cw;
    for (let cx = 0; cx < cw; cx++, p += 8, o++) {
      const q = p + stride;
      const r = (rgba[p] + rgba[p + 4] + rgba[q] + rgba[q + 4]) >> 2;
      const g = (rgba[p + 1] + rgba[p + 5] + rgba[q + 1] + rgba[q + 5]) >> 2;
      const b = (rgba[p + 2] + rgba[p + 6] + rgba[q + 2] + rgba[q + 6]) >> 2;
      // フルレンジでは 256 になることがあるので 255 で止める
      const u = (ur * r + ug * g + ub * b + co) >> 16;
      const v = (vr * r + vg * g + vb * b + co) >> 16;
      buf[uBase + o] = u > 255 ? 255 : u;
      buf[vBase + o] = v > 255 ? 255 : v;
    }
  }
  return buf;
}
