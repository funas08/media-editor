// 表示位置と倍率（ビュー変換）。画面座標 = キャンバス座標 × zoom + pan（CSS px）

import { clamp } from '../core/geometry';
import type { Point } from '../core/types';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;
const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

export class View {
  zoom = 1;
  panX = 0;
  panY = 0;

  docToScreen(p: Point): Point {
    return { x: p.x * this.zoom + this.panX, y: p.y * this.zoom + this.panY };
  }

  screenToDoc(p: Point): Point {
    return { x: (p.x - this.panX) / this.zoom, y: (p.y - this.panY) / this.zoom };
  }

  /** 画面上の (sx, sy) を固定したまま倍率を変える */
  zoomAt(zoom: number, sx: number, sy: number): void {
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const d = this.screenToDoc({ x: sx, y: sy });
    this.zoom = z;
    this.panX = sx - d.x * z;
    this.panY = sy - d.y * z;
  }

  /** 一段階上（dir=1）／下（dir=-1）の倍率 */
  stepZoom(dir: 1 | -1): number {
    const cur = this.zoom;
    if (dir > 0) return ZOOM_STEPS.find((z) => z > cur * 1.001) ?? MAX_ZOOM;
    return [...ZOOM_STEPS].reverse().find((z) => z < cur / 1.001) ?? MIN_ZOOM;
  }

  /** キャンバス全体が表示領域に収まるようにする */
  fit(viewW: number, viewH: number, docW: number, docH: number, padding = 32): void {
    const z = clamp(Math.min((viewW - padding * 2) / docW, (viewH - padding * 2) / docH), MIN_ZOOM, MAX_ZOOM);
    this.zoom = z;
    this.panX = (viewW - docW * z) / 2;
    this.panY = (viewH - docH * z) / 2;
  }

  /** 表示領域の中央を中心に倍率を設定 */
  setZoomCentered(zoom: number, viewW: number, viewH: number): void {
    this.zoomAt(zoom, viewW / 2, viewH / 2);
  }
}
