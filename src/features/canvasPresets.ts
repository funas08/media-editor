// キャンバスサイズのプリセット

export interface CanvasPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const CANVAS_PRESETS: CanvasPreset[] = [
  { id: 'wqhd', label: 'WQHD（2560×1440）', width: 2560, height: 1440 },
  { id: '4k', label: '4K（3840×2160）', width: 3840, height: 2160 },
  { id: 'fhd', label: 'FHD（1920×1080）', width: 1920, height: 1080 },
  { id: 'wqhd-v', label: 'WQHD 縦（1440×2560）', width: 1440, height: 2560 },
  { id: '4k-v', label: '4K 縦（2160×3840）', width: 2160, height: 3840 },
  { id: 'fhd-v', label: 'FHD 縦（1080×1920）', width: 1080, height: 1920 },
];

export function findPreset(width: number, height: number): CanvasPreset | undefined {
  return CANVAS_PRESETS.find((p) => p.width === width && p.height === height);
}

/** キャンバスの最大辺（ブラウザの Canvas 上限を考慮） */
export const MAX_CANVAS_SIDE = 16384;
