// タイムライン（動画モードで画面下部に表示）。
// トラック（上ほど手前）：画像 / 動画 / 元音声 / 音楽。目盛り・再生位置・クリップを Canvas に描く。
// 操作：目盛りや空いている所をクリック・ドラッグで再生位置の移動、クリップのクリックで選択、
//       クリップの端のドラッグでトリム、クリップのドラッグで並べ替え、
//       ホイールで横スクロール、Ctrl+ホイールでズーム

import type { Editor } from '../core/Editor';
import { formatTime, snapToFrame, totalDuration, videoTrackLayout, type ClipSpan } from '../core/timeline';
import type { VideoItem } from '../core/types';
import { moveClip, trimClip } from '../features/videoEdit';
import type { MediaStore } from '../media/MediaStore';
import { button, h, text } from './controls';
import { icons } from './icons';

export interface TimelineHost {
  readonly editor: Editor;
  readonly media: MediaStore;
  getTime(): number;
  seek(t: number): void;
  togglePlay(): void;
  isPlaying(): boolean;
  addVideos(): void;
  /** タイムラインを操作した（← → を1コマ移動に使う） */
  focusTimeline(): void;
  /** I / O で指定した範囲（未指定は null） */
  getRange(): { in: number | null; out: number | null };
  /** 1コマの単位（fps） */
  fps(): number;
  split(): void;
  cutRange(): void;
  fitClips(mode: 'fit' | 'fill'): void;
}

/** ドラッグ中の操作 */
type Drag =
  | { kind: 'seek' }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; item0: VideoItem; t0: number }
  | { kind: 'clip'; id: string; x0: number; t: number; moved: boolean; dropIndex: number };

/** クリップの端をつかめる幅（px） */
const EDGE = 6;

const LABEL_W = 76;
const RULER_H = 22;
const ROWS = [
  { key: 'image', label: '画像', h: 26 },
  { key: 'video', label: '動画', h: 42 },
  { key: 'audio', label: '元音声', h: 26 },
  { key: 'music', label: '音楽', h: 26 },
] as const;
const BODY_H = RULER_H + ROWS.reduce((s, r) => s + r.h, 0) + 6;
const MIN_PPS = 2;
const MAX_PPS = 2000;

export class Timeline {
  readonly el: HTMLElement;
  private host: TimelineHost;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private playBtn: HTMLButtonElement;
  private timeText = text('', 'tl-time');
  private cssW = 1;
  /** 1秒あたりのピクセル数 */
  private pps = 60;
  /** 左端の時刻（秒） */
  private scrollT = 0;
  private fitted = false;
  private drag: Drag | null = null;
  private cutBtn: HTMLButtonElement;
  private shownPlaying: boolean | null = null;

  constructor(host: TimelineHost) {
    this.host = host;
    this.canvas = h('canvas', { class: 'tl-canvas' });
    this.ctx = this.canvas.getContext('2d')!;
    this.playBtn = button('', () => host.togglePlay(), { icon: icons.play, title: '再生 / 停止（Space）' });
    this.playBtn.classList.add('tl-play');
    this.cutBtn = button('範囲をカット', () => host.cutRange(), { title: 'I と O で指定した範囲を切り取って詰める（範囲があるときの Delete）' });
    const header = h(
      'div',
      { class: 'tl-header' },
      this.playBtn,
      this.timeText.el,
      button('分割', () => host.split(), { title: '再生位置でクリップを分ける（S）' }),
      this.cutBtn,
      h('div', { class: 'tb-sep' }),
      button('収める', () => host.fitClips('fit'), { title: '選択中（なければ全部）のクリップをキャンバスに収める' }),
      button('埋める', () => host.fitClips('fill'), { title: '選択中（なければ全部）のクリップでキャンバスを埋める（はみ出しは切れる）' }),
      h('div', { class: 'tl-spacer' }),
      button('動画を追加', () => host.addVideos(), { icon: icons.film }),
      h('div', { class: 'tb-sep' }),
      button('', () => this.zoomBy(1 / 1.5), { icon: icons.minus, title: 'タイムラインを縮小（Ctrl+ホイール）' }),
      button('', () => this.zoomBy(1.5), { icon: icons.plus, title: 'タイムラインを拡大（Ctrl+ホイール）' }),
      button('全体', () => this.fit(), { title: '全体が見えるようにする' }),
    );
    this.el = h('section', { class: 'timeline', 'aria-label': 'タイムライン' }, header, h('div', { class: 'tl-body', style: `height:${BODY_H}px` }, this.canvas));
    this.bind();
    new ResizeObserver(() => {
      this.cssW = Math.max(1, this.canvas.parentElement!.clientWidth);
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(this.cssW * dpr);
      this.canvas.height = Math.round(BODY_H * dpr);
      this.canvas.style.width = `${this.cssW}px`;
      this.canvas.style.height = `${BODY_H}px`;
      if (!this.fitted && totalDuration(this.host.editor.doc) > 0) this.fit();
      this.draw();
    }).observe(this.el);
  }

  /** 全体が見える倍率にする */
  fit(): void {
    const d = Math.max(1, totalDuration(this.host.editor.doc));
    this.pps = clamp((this.cssW - LABEL_W - 24) / d, MIN_PPS, MAX_PPS);
    this.scrollT = 0;
    this.fitted = true;
    this.draw();
  }

  /** 毎フレーム呼ぶ（再生位置・クリップの表示を更新） */
  draw(): void {
    const t = this.host.getTime();
    const duration = totalDuration(this.host.editor.doc);
    this.timeText.set(`${formatTime(t)} / ${formatTime(duration)}`);
    const playing = this.host.isPlaying();
    if (playing !== this.shownPlaying) {
      this.shownPlaying = playing;
      this.playBtn.replaceChildren(h('span', { class: 'icon', html: playing ? icons.pause : icons.play }));
    }
    if (!this.fitted && duration > 0 && this.cssW > 1) this.fit();
    const range = this.host.getRange();
    this.cutBtn.disabled = range.in === null || range.out === null || Math.abs(range.out - range.in) < 1e-6;
    // 再生中は再生位置が見えるようにスクロール
    if (this.host.isPlaying()) {
      const x = this.xOf(t);
      if (x > this.cssW - 40 || x < LABEL_W) this.scrollT = Math.max(0, t - (this.cssW - LABEL_W) * 0.1 / this.pps);
    }
    this.paint(t);
  }

  private xOf(t: number): number {
    return LABEL_W + (t - this.scrollT) * this.pps;
  }

  private tOf(x: number): number {
    return this.scrollT + (x - LABEL_W) / this.pps;
  }

  private zoomBy(k: number, anchorX = LABEL_W + (this.cssW - LABEL_W) / 2): void {
    const t = this.tOf(anchorX);
    this.pps = clamp(this.pps * k, MIN_PPS, MAX_PPS);
    this.scrollT = Math.max(0, t - (anchorX - LABEL_W) / this.pps);
    this.draw();
  }

  /** 行の上端の y 座標 */
  private rowY(key: (typeof ROWS)[number]['key']): { y: number; h: number } {
    let y = RULER_H;
    for (const r of ROWS) {
      if (r.key === key) return { y, h: r.h };
      y += r.h;
    }
    return { y, h: 0 };
  }

  private clipAt(x: number, y: number): ClipSpan | null {
    const rv = this.rowY('video');
    const ra = this.rowY('audio');
    const inRow = (y >= rv.y && y < rv.y + rv.h) || (y >= ra.y && y < ra.y + ra.h);
    if (!inRow || x < LABEL_W) return null;
    const t = this.tOf(x);
    return videoTrackLayout(this.host.editor.doc).find((s) => t >= s.start && t < s.end) ?? null;
  }

  /** クリップの端（トリム用）にいるか */
  private edgeAt(x: number, y: number): { span: ClipSpan; edge: 'start' | 'end' } | null {
    const rv = this.rowY('video');
    if (y < rv.y || y >= rv.y + rv.h || x < LABEL_W) return null;
    for (const span of videoTrackLayout(this.host.editor.doc)) {
      if (Math.abs(x - this.xOf(span.end)) <= EDGE) return { span, edge: 'end' };
      if (Math.abs(x - this.xOf(span.start)) <= EDGE) return { span, edge: 'start' };
    }
    return null;
  }

  /** 並べ替えで落とす位置（動画トラックの中での番号） */
  private dropIndexAt(t: number, draggedId: string): number {
    const spans = videoTrackLayout(this.host.editor.doc).filter((s) => s.item.id !== draggedId);
    // 縮めて詰めた並びで考える：中央より右なら後ろに入れる
    let acc = 0;
    let idx = 0;
    for (const s of spans) {
      const len = s.end - s.start;
      if (t > acc + len / 2) idx++;
      acc += len;
    }
    return idx;
  }

  private bind(): void {
    const c = this.canvas;
    const pos = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const editor = this.host.editor;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.host.focusTimeline();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const p = pos(e);
      if (p.x < LABEL_W) return;
      c.setPointerCapture(e.pointerId);
      const t = Math.max(0, this.tOf(p.x));
      // クリップの端：トリム
      const edge = p.y >= RULER_H ? this.edgeAt(p.x, p.y) : null;
      if (edge) {
        editor.setSelection([edge.span.item.id]);
        editor.begin('トリム');
        this.drag = { kind: 'trim', id: edge.span.item.id, edge: edge.edge, item0: structuredClone(edge.span.item), t0: t };
        return;
      }
      // クリップ：選択（ドラッグしたら並べ替え、しなければ再生位置の移動）
      const clip = p.y >= RULER_H ? this.clipAt(p.x, p.y) : null;
      if (clip) {
        const sel = editor.selection;
        if (e.shiftKey) editor.setSelection(sel.includes(clip.item.id) ? sel.filter((id) => id !== clip.item.id) : [...sel, clip.item.id]);
        else if (!sel.includes(clip.item.id) || sel.length > 1) editor.setSelection([clip.item.id]);
        this.drag = { kind: 'clip', id: clip.item.id, x0: p.x, t, moved: false, dropIndex: -1 };
        return;
      }
      // 目盛り・空いている所：再生位置の移動
      this.drag = { kind: 'seek' };
      this.host.seek(t);
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      const d = this.drag;
      if (!d) {
        // カーソルの形
        c.style.cursor = this.edgeAt(p.x, p.y) ? 'ew-resize' : p.y >= RULER_H && this.clipAt(p.x, p.y) ? 'grab' : 'text';
        return;
      }
      const t = clamp(this.tOf(p.x), 0, Math.max(0, totalDuration(editor.doc)));
      if (d.kind === 'seek') {
        this.host.seek(t);
      } else if (d.kind === 'trim') {
        // 動かした量だけ元動画の範囲を変える（コマ単位）
        const fps = this.host.fps();
        const dt = snapToFrame(this.tOf(p.x) - d.t0, fps);
        const v = d.item0;
        const src = (d.edge === 'start' ? v.inPoint : v.outPoint) + dt * v.speed;
        editor.preview((draft) => trimClip(draft, d.id, d.edge, src));
        // 変えた端のフレームを表示する
        const span = videoTrackLayout(editor.doc).find((s) => s.item.id === d.id);
        if (span) this.host.seek(d.edge === 'start' ? span.start : Math.max(span.start, span.end - 1 / fps));
      } else if (d.kind === 'clip') {
        if (!d.moved && Math.abs(p.x - d.x0) < 4) return;
        d.moved = true;
        c.style.cursor = 'grabbing';
        d.dropIndex = this.dropIndexAt(this.tOf(p.x), d.id);
        this.draw();
      }
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      this.drag = null;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      c.style.cursor = 'text';
      if (!d) return;
      if (d.kind === 'trim') {
        editor.commit();
      } else if (d.kind === 'clip') {
        if (d.moved && d.dropIndex >= 0) editor.update('並べ替え', (draft) => moveClip(draft, d.id, d.dropIndex));
        else if (!d.moved) this.host.seek(d.t);
      }
      this.draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          this.zoomBy(Math.exp(-e.deltaY * 0.002), pos(e).x);
        } else {
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.scrollT = Math.max(0, this.scrollT + d / this.pps);
          this.draw();
        }
      },
      { passive: false },
    );
  }

  private paint(t: number): void {
    const { ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = this.cssW;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1b1e23';
    ctx.fillRect(0, 0, W, BODY_H);
    const doc = this.host.editor.doc;
    const duration = totalDuration(doc);

    // 行の背景
    for (const r of ROWS) {
      const { y, h: rh } = this.rowY(r.key);
      ctx.fillStyle = r.key === 'video' ? '#22262c' : '#1f2227';
      ctx.fillRect(LABEL_W, y, W - LABEL_W, rh - 1);
    }
    // 作品の終わり以降は暗く
    const endX = this.xOf(duration);
    if (endX < W) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(Math.max(LABEL_W, endX), RULER_H, W, BODY_H - RULER_H);
    }

    // 目盛り
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * this.pps >= 70) ?? 600;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const t0 = Math.floor(this.scrollT / step) * step;
    for (let tt = t0; this.xOf(tt) < W; tt += step) {
      const x = Math.round(this.xOf(tt)) + 0.5;
      if (x < LABEL_W) continue;
      ctx.strokeStyle = '#3a3f47';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 8);
      ctx.lineTo(x, BODY_H);
      ctx.stroke();
      ctx.fillStyle = '#9aa1ab';
      ctx.fillText(formatTime(tt, step < 1), x + 3, RULER_H / 2);
    }

    // I / O の範囲
    const range = this.host.getRange();
    if (range.in !== null || range.out !== null) {
      const a = range.in ?? range.out!;
      const b = range.out ?? range.in!;
      const x0 = Math.max(LABEL_W, this.xOf(Math.min(a, b)));
      const x1 = Math.min(W, this.xOf(Math.max(a, b)));
      if (x1 > x0) {
        ctx.fillStyle = 'rgba(255, 196, 0, 0.16)';
        ctx.fillRect(x0, 0, x1 - x0, BODY_H);
      }
      ctx.fillStyle = '#ffc400';
      for (const [tt, label] of [
        [range.in, 'I'],
        [range.out, 'O'],
      ] as const) {
        if (tt === null) continue;
        const x = this.xOf(tt);
        if (x < LABEL_W || x > W) continue;
        ctx.fillRect(Math.round(x) - 0.5, 0, 1.5, BODY_H);
        ctx.fillText(label, x + 3, 7);
      }
    }

    // クリップ
    const sel = new Set(this.host.editor.selection);
    const rv = this.rowY('video');
    const ra = this.rowY('audio');
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, 0, W - LABEL_W, BODY_H);
    ctx.clip();
    for (const s of videoTrackLayout(doc)) {
      const x0 = this.xOf(s.start);
      const x1 = this.xOf(s.end);
      if (x1 < LABEL_W || x0 > W) continue;
      const selected = sel.has(s.item.id);
      this.block(x0, rv.y + 2, x1 - x0, rv.h - 5, selected ? '#3f78e0' : '#2f5aa8', selected, `${s.item.name}  ${formatTime(s.end - s.start)}`);
      // 選択中のクリップはトリム用のつまみを表示
      if (selected) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x0 + 1, rv.y + 8, 3, rv.h - 17);
        ctx.fillRect(x1 - 4, rv.y + 8, 3, rv.h - 17);
      }
      const info = this.host.media.get(s.item.mediaId)?.info;
      if (info?.hasAudio) {
        const muted = s.item.muted || s.item.volume <= 0;
        this.block(x0, ra.y + 2, x1 - x0, ra.h - 5, muted ? '#3a3f47' : selected ? '#2f9a63' : '#277a50', selected, muted ? 'ミュート' : '');
      }
    }
    // 並べ替えで落とす位置
    const d = this.drag;
    if (d?.kind === 'clip' && d.moved && d.dropIndex >= 0) {
      const others = videoTrackLayout(doc).filter((s) => s.item.id !== d.id);
      const at = others.slice(0, d.dropIndex).reduce((sum, s) => sum + (s.end - s.start), 0);
      const x = this.xOf(at);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(x) - 1.5, rv.y - 2, 3, rv.h + ra.h + 2);
    }
    ctx.restore();

    // 行の名前
    ctx.fillStyle = '#1f2227';
    ctx.fillRect(0, 0, LABEL_W, BODY_H);
    ctx.fillStyle = '#9aa1ab';
    for (const r of ROWS) {
      const { y, h: rh } = this.rowY(r.key);
      ctx.fillText(r.label, 10, y + rh / 2);
    }
    if (videoTrackLayout(doc).length === 0) {
      ctx.fillStyle = '#6c727c';
      ctx.fillText('「動画を追加」または動画ファイルをドロップしてください', LABEL_W + 12, rv.y + rv.h / 2);
    }

    // 再生位置
    const px = Math.round(this.xOf(t)) + 0.5;
    if (px >= LABEL_W && px <= W) {
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, BODY_H);
      ctx.stroke();
      ctx.fillStyle = '#ff4d4d';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 7);
      ctx.fill();
    }
  }

  private block(x: number, y: number, w: number, hh: number, color: string, selected: boolean, label: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y, Math.max(1, w - 1), hh, 4);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (label && w > 30) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 4, y, w - 8, hh);
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + 6, y + hh / 2);
      ctx.restore();
    }
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}
