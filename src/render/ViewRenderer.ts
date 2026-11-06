// 画面表示用のレンダラー（Canvas 2D 実装）。
// 将来 WebGL/WebGPU に差し替える場合は SceneView インターフェースを実装した別クラスを用意する。

import type { AssetStore } from '../core/AssetStore';
import type { DocState } from '../core/types';
import { drawItems, drawScene } from './scene';
import type { View } from './view';

export interface RenderFrame {
  doc: DocState;
  assets: AssetStore;
  view: View;
  /** 画面座標（CSS px）でオーバーレイを描く */
  overlay?: (ctx: CanvasRenderingContext2D) => void;
}

export interface SceneView {
  readonly width: number;
  readonly height: number;
  resize(cssW: number, cssH: number): void;
  render(frame: RenderFrame): void;
}

const WORKSPACE_COLOR = '#16181c';
/** キャンバス外にはみ出した部分の不透明度 */
const OUTSIDE_ALPHA = 0.28;

export class CanvasSceneView implements SceneView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private checker: CanvasPattern | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D を初期化できませんでした');
    this.ctx = ctx;
  }

  get width(): number {
    return this.cssW;
  }

  get height(): number {
    return this.cssH;
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
  }

  render({ doc, assets, view, overlay }: RenderFrame): void {
    // 別モニターへの移動などで DPR が変わったら作り直す
    if ((window.devicePixelRatio || 1) !== this.dpr) this.resize(this.cssW, this.cssH);
    const { ctx, dpr } = this;
    const z = view.zoom;
    const cw = doc.canvas.width;
    const ch = doc.canvas.height;
    const sx = view.panX;
    const sy = view.panY;

    // 作業領域
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = WORKSPACE_COLOR;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // キャンバスの影と透明時の市松模様（画面座標）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#000';
    ctx.fillRect(sx, sy, cw * z, ch * z);
    ctx.restore();
    if (doc.canvas.transparent) {
      ctx.fillStyle = this.checkerPattern();
      ctx.fillRect(sx, sy, cw * z, ch * z);
    }

    // キャンバス座標で描く
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * sx, dpr * sy);
    const env = { assets, pixelScale: dpr * z, pixelated: true };

    // はみ出した部分（薄く）
    ctx.save();
    ctx.beginPath();
    ctx.rect(-1e7, -1e7, 2e7, 2e7);
    ctx.rect(0, 0, cw, ch);
    ctx.clip('evenodd');
    ctx.globalAlpha = OUTSIDE_ALPHA;
    drawItems(ctx, doc.items, env);
    ctx.restore();

    // キャンバス内
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.clip();
    drawScene(ctx, doc, env);
    ctx.restore();

    // 枠線とオーバーレイ（画面座標）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(sx) - 0.5, Math.round(sy) - 0.5, Math.round(cw * z) + 1, Math.round(ch * z) + 1);
    if (overlay) {
      ctx.save();
      overlay(ctx);
      ctx.restore();
    }
  }

  private checkerPattern(): CanvasPattern {
    if (this.checker) return this.checker;
    const size = 8;
    const c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const g = c.getContext('2d')!;
    g.fillStyle = '#e4e4e4';
    g.fillRect(0, 0, size * 2, size * 2);
    g.fillStyle = '#c4c4c4';
    g.fillRect(0, 0, size, size);
    g.fillRect(size, size, size, size);
    this.checker = this.ctx.createPattern(c, 'repeat')!;
    return this.checker;
  }
}
