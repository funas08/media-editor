// ステータスバー：現在のツール、ズーム率、カーソル位置、キャンバスサイズ

import type { Point } from '../core/types';
import { h, text } from './controls';
import { formatTime } from '../core/timeline';
import { formatZoom } from './TopBar';

export interface StatusInfo {
  tool: string;
  zoom: number;
  cursor: Point | null;
  canvasW: number;
  canvasH: number;
  selected: number;
  total: number;
  /** 動画モードの再生位置（画像モードでは null） */
  time: number | null;
}

export class StatusBar {
  readonly el: HTMLElement;
  private tool = text('', 'sb-item');
  private zoom = text('', 'sb-item');
  private cursor = text('', 'sb-item sb-cursor');
  private canvas = text('', 'sb-item');
  private sel = text('', 'sb-item');
  private time = text('', 'sb-item');

  constructor() {
    this.el = h('footer', { class: 'statusbar' }, this.tool.el, this.zoom.el, this.cursor.el, this.canvas.el, this.sel.el, this.time.el);
  }

  update(s: StatusInfo): void {
    this.tool.set(`ツール：${s.tool}`);
    this.zoom.set(`ズーム：${formatZoom(s.zoom)}%`);
    this.cursor.set(s.cursor ? `X ${Math.floor(s.cursor.x)}  Y ${Math.floor(s.cursor.y)}` : 'X —  Y —');
    this.canvas.set(`キャンバス：${s.canvasW} × ${s.canvasH}`);
    this.sel.set(`選択：${s.selected} / ${s.total}`);
    this.time.set(s.time === null ? '' : `再生位置：${formatTime(s.time)}`);
  }
}
