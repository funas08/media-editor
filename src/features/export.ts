// 書き出し：表示とは別のオフスクリーン Canvas に原寸（×倍率）で描画して画像ファイルにする

import type { AssetStore } from '../core/AssetStore';
import type { DocState } from '../core/types';
import { drawScene } from '../render/scene';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface ExportOptions {
  format: ExportFormat;
  /** 0〜1（JPEG / WebP のみ） */
  quality: number;
  /** 倍率（1 / 1.5 / 2） */
  scale: number;
}

export const FORMAT_INFO: Record<ExportFormat, { mime: string; ext: string; label: string; lossy: boolean }> = {
  png: { mime: 'image/png', ext: 'png', label: 'PNG', lossy: false },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG', lossy: true },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP', lossy: true },
};

export function exportSize(doc: DocState, scale: number): { width: number; height: number } {
  return { width: Math.round(doc.canvas.width * scale), height: Math.round(doc.canvas.height * scale) };
}

export async function renderToBlob(doc: DocState, assets: AssetStore, opts: ExportOptions): Promise<Blob> {
  const { width, height } = exportSize(doc, opts.scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('書き出し用の Canvas を作成できませんでした');
  const info = FORMAT_INFO[opts.format];
  // JPEG は透明を扱えないので、透明背景のときは白で塗る
  if (opts.format === 'jpeg' && doc.canvas.transparent) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.scale(width / doc.canvas.width, height / doc.canvas.height);
  drawScene(ctx, doc, { assets, pixelScale: opts.scale });
  return canvas.convertToBlob({ type: info.mime, quality: info.lossy ? opts.quality : undefined });
}

export function defaultExportName(format: ExportFormat): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `image-${stamp}.${FORMAT_INFO[format].ext}`;
}
