// タイムライン（動画モードで画面下部に表示）。
// トラック（上ほど手前）：［新しいトラック用の余白］/ オーバーレイ（複数）/ メイン / 元音声 / 音楽
//
// 操作：
// - 目盛りや空いている所のクリック・ドラッグ：再生位置の移動
// - クリップ：クリックで選択、端のドラッグでトリム、ドラッグで移動（時刻・並べ替え・トラック間）、Alt+ドラッグで複製
//   ドラッグ中は境目・再生位置・先頭に吸着（Alt を押している間は吸着しない）
// - 素材パネル・パソコンのファイルのドロップ：その位置に置く
// - ホイールで横スクロール、Ctrl+ホイールでズーム

import type { Editor } from '../core/Editor';
import { clipLength, formatTime, isTrackLocked, mainLayout, musicEnd, overlaySpans, snapToFrame, totalDuration, type ClipSpan, type TimedItem } from '../core/timeline';
import { MAIN_TRACK, type MusicClip, type OverlayTrack } from '../core/types';
import { sourceLength } from '../features/clips';
import {
  MIN_CLIP,
  addTrack,
  cloneClip,
  insertIntoMain,
  moveClipTo,
  nearestBoundary,
  placeOnOverlay,
  removeTrackIfEmpty,
  snapCandidates,
  snapTime,
  trimBy,
  type ClipTarget,
} from '../features/videoEdit';
import type { MediaStore } from '../media/MediaStore';
import { button, h, iconButton, text } from './controls';
import { getLibraryDrag, hasFiles } from './dragState';
import { icons } from './icons';
import type { LibraryEntry } from './Library';

/** 素材を置く先 */
export type DropTarget = { kind: 'main'; t: number } | { kind: 'overlay'; trackId: string; start: number } | { kind: 'newTrack'; start: number };

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
  /** 素材（またはパソコンのファイル）を置く。音楽は target に関係なく音楽トラックの、その時刻に置く */
  placeSources(sources: LibraryEntry[] | File[], target: DropTarget): void;
  /** 選択中の音楽クリップ */
  getMusicSelection(): string | null;
  selectMusic(id: string | null): void;
}

const LABEL_W = 116;
const PAD = 8;
const RULER_H = 22;
const NEW_TRACK_H = 14;
const OVERLAY_H = 30;
const MAIN_H = 42;
const AUDIO_H = 22;
const MUSIC_H = 28;
const MAX_BODY_H = 300;
const MIN_PPS = 2;
const MAX_PPS = 2000;
/** クリップの端をつかめる幅（px） */
const EDGE = 6;
/** 吸着する距離（px） */
const SNAP_PX = 8;
/** ファイルを運んでいる間の影の長さ（中身はドロップするまで分からない） */
const PLACEHOLDER_LEN = 5;

type RowKind = 'newTrack' | 'overlay' | 'main' | 'audio' | 'music';

interface Row {
  kind: RowKind;
  track?: OverlayTrack;
  label: string;
  y: number;
  h: number;
}

/** ドラッグ中の操作 */
type Drag =
  | { kind: 'seek' }
  | { kind: 'trim'; orig: TimedItem; edge: 'start' | 'end'; t0: number }
  | { kind: 'move'; item: TimedItem; dup: boolean; grab: number; x0: number; moved: boolean }
  | { kind: 'music'; clip: MusicClip; grab: number; x0: number; moved: boolean };

type PreviewTarget = ClipTarget | { kind: 'music'; start: number };

/** ドラッグ（またはドロップ）で置かれる位置の表示 */
interface Preview {
  valid: boolean;
  row: Row | null;
  /** 影の開始・長さ（秒） */
  start: number;
  len: number;
  /** メインへの挿入線の時刻 */
  line: number | null;
  target: PreviewTarget | null;
}

export class Timeline {
  readonly el: HTMLElement;
  private host: TimelineHost;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private labels: HTMLElement;
  private scroller: HTMLElement;
  private playBtn: HTMLButtonElement;
  private cutBtn: HTMLButtonElement;
  private timeText = text('', 'tl-time');
  private cssW = 1;
  private rows: Row[] = [];
  private rowsSig = '';
  private bodyH = 0;
  /** 1秒あたりのピクセル数 */
  private pps = 60;
  /** 左端の時刻（秒） */
  private scrollT = 0;
  private fitted = false;
  private drag: Drag | null = null;
  private preview: Preview | null = null;
  private shownPlaying: boolean | null = null;
  private altHeld = false;

  constructor(host: TimelineHost) {
    this.host = host;
    this.canvas = h('canvas', { class: 'tl-canvas' });
    this.ctx = this.canvas.getContext('2d')!;
    this.labels = h('div', { class: 'tl-labels', style: `width:${LABEL_W}px` });
    this.playBtn = button('', () => host.togglePlay(), { icon: icons.play, title: '再生 / 停止（Space）' });
    this.playBtn.classList.add('tl-play');
    this.cutBtn = button('範囲をカット', () => host.cutRange(), { title: 'I と O で指定した範囲を切り取って詰める（範囲があるときの Delete）' });
    const header = h(
      'div',
      { class: 'tl-header' },
      this.playBtn,
      this.timeText.el,
      button('分割', () => host.split(), { title: '再生位置でメインのクリップを分ける（S）' }),
      this.cutBtn,
      h('div', { class: 'tb-sep' }),
      button('収める', () => host.fitClips('fit'), { title: '選択中（なければメインの全部）のクリップをキャンバスに収める' }),
      button('埋める', () => host.fitClips('fill'), { title: '選択中（なければメインの全部）のクリップでキャンバスを埋める（はみ出しは切れる）' }),
      h('div', { class: 'tb-sep' }),
      button(
        '＋トラック',
        () =>
          host.editor.update('トラックを追加', (d) => {
            addTrack(d);
          }),
        { title: 'オーバーレイトラックを一番上に追加' },
      ),
      h('div', { class: 'tl-spacer' }),
      button('動画を追加', () => host.addVideos(), { icon: icons.film, title: 'メインの最後に動画を追加' }),
      h('div', { class: 'tb-sep' }),
      button('', () => this.zoomBy(1 / 1.5), { icon: icons.minus, title: 'タイムラインを縮小（Ctrl+ホイール）' }),
      button('', () => this.zoomBy(1.5), { icon: icons.plus, title: 'タイムラインを拡大（Ctrl+ホイール）' }),
      button('全体', () => this.fit(), { title: '全体が見えるようにする' }),
    );
    const inner = h('div', { class: 'tl-inner' }, this.labels, h('div', { class: 'tl-track-area' }, this.canvas));
    this.scroller = h('div', { class: 'tl-body', style: `max-height:${MAX_BODY_H}px` }, inner);
    this.el = h('section', { class: 'timeline', 'aria-label': 'タイムライン' }, header, this.scroller);
    this.bindPointer();
    this.bindDrop();
    window.addEventListener('keydown', (e) => this.setAlt(e.altKey));
    window.addEventListener('keyup', (e) => this.setAlt(e.altKey));
    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  // ===== 配置 =====

  private resize(): void {
    this.cssW = Math.max(1, this.scroller.clientWidth - LABEL_W);
    this.layoutRows(true);
    if (!this.fitted && totalDuration(this.host.editor.doc) > 0) this.fit();
    this.draw();
  }

  /** トラックの行を作り直す（トラックが変わったときだけ DOM も作り直す） */
  private layoutRows(force = false): void {
    const doc = this.host.editor.doc;
    const tracks = doc.timeline.overlays;
    const used = new Set(doc.items.map((it) => it.clip?.track));
    const sig = JSON.stringify([tracks, tracks.map((t) => used.has(t.id))]);
    if (!force && sig === this.rowsSig) return;
    this.rowsSig = sig;
    const rows: Row[] = [];
    let y = RULER_H;
    const push = (r: Omit<Row, 'y'>) => {
      rows.push({ ...r, y });
      y += r.h;
    };
    push({ kind: 'newTrack', label: '', h: NEW_TRACK_H });
    tracks.forEach((t, i) => push({ kind: 'overlay', track: t, label: `オーバーレイ ${tracks.length - i}`, h: OVERLAY_H }));
    push({ kind: 'main', label: 'メイン', h: MAIN_H });
    push({ kind: 'audio', label: '元音声', h: AUDIO_H });
    push({ kind: 'music', label: '音楽', h: MUSIC_H });
    this.rows = rows;
    this.bodyH = y + 4;
    // キャンバスの大きさ
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.bodyH * dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.bodyH}px`;
    // トラック名の欄（HTML）
    const editor = this.host.editor;
    const cells = rows.map((r) => {
      const cell = h('div', { class: `tl-label tl-label-${r.kind}`, style: `height:${r.h}px` });
      if (r.kind === 'newTrack') return cell;
      cell.append(h('span', { class: 'tl-label-text' }, r.label));
      const t = r.track;
      if (t) {
        const empty = !used.has(t.id);
        const toggle = (label: string, key: 'visible' | 'locked') =>
          editor.update(label, (d) => {
            const x = d.timeline.overlays.find((o) => o.id === t.id);
            if (x) x[key] = !x[key];
          });
        const vis = iconButton(t.visible ? icons.eye : icons.eyeOff, t.visible ? '非表示にする' : '表示する', () => toggle(t.visible ? 'トラックを非表示' : 'トラックを表示', 'visible'));
        const lock = iconButton(t.locked ? icons.lock : icons.unlock, t.locked ? 'ロックを解除' : 'ロックする', () => toggle(t.locked ? 'トラックのロック解除' : 'トラックをロック', 'locked'));
        const del = iconButton(icons.trash, empty ? '空のトラックを削除' : 'クリップがあるトラックは削除できません', () =>
          editor.update('トラックを削除', (d) => {
            removeTrackIfEmpty(d, t.id);
          }),
        );
        del.disabled = !empty;
        vis.classList.toggle('off', !t.visible);
        lock.classList.toggle('on', t.locked);
        cell.append(vis, lock, del);
      }
      return cell;
    });
    this.labels.replaceChildren(h('div', { class: 'tl-label tl-label-ruler', style: `height:${RULER_H}px` }), ...cells);
  }

  /** 全体が見える倍率にする */
  fit(): void {
    const d = Math.max(1, totalDuration(this.host.editor.doc));
    this.pps = clamp((this.cssW - PAD * 2 - 16) / d, MIN_PPS, MAX_PPS);
    this.scrollT = 0;
    this.fitted = true;
    this.draw();
  }

  /** 毎フレーム呼ぶ（再生位置・クリップの表示を更新） */
  draw(): void {
    this.layoutRows();
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
    if (playing) {
      const x = this.xOf(t);
      if (x > this.cssW - 40 || x < 0) this.scrollT = Math.max(0, t - (this.cssW * 0.1) / this.pps);
    }
    this.paint(t);
  }

  private xOf(t: number): number {
    return PAD + (t - this.scrollT) * this.pps;
  }

  private tOf(x: number): number {
    return this.scrollT + (x - PAD) / this.pps;
  }

  private zoomBy(k: number, anchorX = this.cssW / 2): void {
    const t = this.tOf(anchorX);
    this.pps = clamp(this.pps * k, MIN_PPS, MAX_PPS);
    this.scrollT = Math.max(0, t - (anchorX - PAD) / this.pps);
    this.draw();
  }

  private rowAt(y: number): Row | null {
    return this.rows.find((r) => y >= r.y && y < r.y + r.h) ?? null;
  }

  private rowOfTrack(track: string): Row | undefined {
    return track === MAIN_TRACK ? this.rows.find((r) => r.kind === 'main') : this.rows.find((r) => r.track?.id === track);
  }

  /** 位置にあるクリップ（メイン・オーバーレイ・元音声）か音楽クリップ */
  private hitAt(x: number, y: number): { span: ClipSpan } | { music: MusicClip } | null {
    const row = this.rowAt(y);
    if (!row) return null;
    const t = this.tOf(x);
    const doc = this.host.editor.doc;
    if (row.kind === 'main' || row.kind === 'audio') {
      const s = mainLayout(doc).find((sp) => t >= sp.start && t < sp.end);
      return s ? { span: s } : null;
    }
    if (row.kind === 'overlay' && row.track) {
      const s = overlaySpans(doc, row.track.id).find((sp) => t >= sp.start && t < sp.end);
      return s ? { span: s } : null;
    }
    if (row.kind === 'music') {
      const m = doc.timeline.music.find((c) => t >= c.start && t < musicEnd(c));
      return m ? { music: m } : null;
    }
    return null;
  }

  /** クリップの端（トリム用）にいるか */
  private edgeAt(x: number, y: number): { span: ClipSpan; edge: 'start' | 'end' } | null {
    const row = this.rowAt(y);
    if (!row || (row.kind !== 'main' && row.kind !== 'overlay')) return null;
    const doc = this.host.editor.doc;
    const spans = row.kind === 'main' ? mainLayout(doc) : overlaySpans(doc, row.track!.id);
    for (const span of spans) {
      if (Math.abs(x - this.xOf(span.end)) <= EDGE) return { span, edge: 'end' };
      if (Math.abs(x - this.xOf(span.start)) <= EDGE) return { span, edge: 'start' };
    }
    return null;
  }

  // ===== 置く位置の計算（ドラッグとドロップで共通） =====

  /**
   * 位置 (x, y) にクリップ（長さ len、つかんだ位置 grab 秒）を置くときの行き先。
   * fromMain：メインの中で動かす（境目への並べ替え。分割しない）、excludeId：吸着の候補から外すクリップ
   */
  private computeTarget(x: number, y: number, len: number, grab: number, opts: { fromMain?: boolean; excludeId?: string; music?: boolean }): Preview {
    const row = this.rowAt(y);
    const base: Preview = { valid: false, row, start: 0, len, line: null, target: null };
    if (!row || y < RULER_H) return base;
    const doc = this.host.editor.doc;
    const pointerT = Math.max(0, this.tOf(x));
    const snapSec = SNAP_PX / this.pps;
    const cands = snapCandidates(doc, this.host.getTime(), opts.excludeId);
    const snapped = (start: number) => (this.altHeld ? Math.max(0, start) : snapTime(start, len, cands, snapSec).t);
    if (opts.music) {
      // 音楽はどの行に落としても音楽トラックへ
      const start = snapped(pointerT - grab);
      return { ...base, valid: true, row: this.rows.find((r) => r.kind === 'music')!, start, target: { kind: 'music', start } };
    }
    if (row.kind === 'music') return base;
    if (row.kind === 'main' || row.kind === 'audio') {
      const mainRow = this.rows.find((r) => r.kind === 'main')!;
      if (opts.fromMain) {
        const b = nearestBoundary(doc, pointerT, opts.excludeId);
        return { ...base, valid: true, row: mainRow, start: b.time, line: b.time, target: { kind: 'main', t: pointerT } };
      }
      // 境目に近ければ境目、クリップの途中ならそこで分割して挿入
      const b = nearestBoundary(doc, pointerT);
      const at = Math.abs(b.time - pointerT) <= snapSec ? b.time : pointerT;
      return { ...base, valid: true, row: mainRow, start: at, line: at, target: { kind: 'main', t: at } };
    }
    const start = snapped(pointerT - grab);
    if (row.kind === 'newTrack') return { ...base, valid: true, start, target: { kind: 'newTrack', start } };
    if (row.kind === 'overlay' && row.track) {
      if (row.track.locked) return base;
      return { ...base, valid: true, start, target: { kind: 'overlay', trackId: row.track.id, start } };
    }
    return base;
  }

  // ===== マウス操作 =====

  private setAlt(v: boolean): void {
    if (this.altHeld === v) return;
    this.altHeld = v;
    if (this.drag) this.draw();
  }

  private bindPointer(): void {
    const c = this.canvas;
    const editor = this.host.editor;
    const pos = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.host.focusTimeline();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const p = pos(e);
      this.altHeld = e.altKey;
      c.setPointerCapture(e.pointerId);
      const t = Math.max(0, this.tOf(p.x));
      const doc = editor.doc;
      if (p.y >= RULER_H) {
        // クリップの端：トリム
        const edge = this.edgeAt(p.x, p.y);
        if (edge && !isTrackLocked(doc, edge.span.item)) {
          this.host.selectMusic(null);
          editor.setSelection([edge.span.item.id]);
          editor.begin('トリム');
          this.drag = { kind: 'trim', orig: structuredClone(edge.span.item), edge: edge.edge, t0: t };
          return;
        }
        const hit = this.hitAt(p.x, p.y);
        if (hit && 'span' in hit) {
          const it = hit.span.item;
          if (isTrackLocked(doc, it)) return;
          this.host.selectMusic(null);
          const sel = editor.selection;
          if (e.shiftKey) editor.setSelection(sel.includes(it.id) ? sel.filter((id) => id !== it.id) : [...sel, it.id]);
          else if (!sel.includes(it.id) || sel.length > 1) editor.setSelection([it.id]);
          this.drag = { kind: 'move', item: structuredClone(it), dup: e.altKey, grab: t - hit.span.start, x0: p.x, moved: false };
          return;
        }
        if (hit && 'music' in hit) {
          editor.setSelection([]);
          this.host.selectMusic(hit.music.id);
          this.drag = { kind: 'music', clip: structuredClone(hit.music), grab: t - hit.music.start, x0: p.x, moved: false };
          this.draw();
          return;
        }
      }
      // 目盛り・空いている所：再生位置の移動
      this.drag = { kind: 'seek' };
      this.host.seek(t);
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      const d = this.drag;
      this.altHeld = e.altKey;
      if (!d) {
        const edge = p.y >= RULER_H ? this.edgeAt(p.x, p.y) : null;
        c.style.cursor = edge ? 'ew-resize' : p.y >= RULER_H && this.hitAt(p.x, p.y) ? 'grab' : 'text';
        return;
      }
      if (d.kind === 'seek') {
        this.host.seek(clamp(this.tOf(p.x), 0, Math.max(0, totalDuration(editor.doc))));
      } else if (d.kind === 'trim') {
        // 動かした量だけ長さを変える（コマ単位）
        const fps = this.host.fps();
        const dt = snapToFrame(this.tOf(p.x) - d.t0, fps);
        editor.preview((draft) => trimBy(draft, d.orig, d.edge, dt));
        // 変えた端のフレームを表示する
        const span = [...mainLayout(editor.doc), ...overlaySpans(editor.doc)].find((s) => s.item.id === d.orig.id);
        if (span) this.host.seek(d.edge === 'start' ? span.start : Math.max(span.start, span.end - 1 / fps));
      } else {
        if (!d.moved && Math.abs(p.x - d.x0) < 4) return;
        d.moved = true;
        if (d.kind === 'move') {
          this.preview = this.computeTarget(p.x, p.y, clipLength(d.item), d.grab, {
            fromMain: d.item.clip.track === MAIN_TRACK && !d.dup,
            excludeId: d.dup ? undefined : d.item.id,
          });
        } else {
          this.preview = this.computeTarget(p.x, p.y, musicEnd(d.clip) - d.clip.start, d.grab, { music: true, excludeId: d.clip.id });
        }
        c.style.cursor = this.preview.valid ? (d.kind === 'move' && d.dup ? 'copy' : 'grabbing') : 'not-allowed';
        this.draw();
      }
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      const pv = this.preview;
      this.drag = null;
      this.preview = null;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      c.style.cursor = 'text';
      if (!d) return;
      if (d.kind === 'trim') {
        editor.commit();
      } else if (d.kind === 'move') {
        if (!d.moved) this.host.seek(Math.max(0, this.tOf(d.x0)));
        else if (pv?.valid && pv.target && pv.target.kind !== 'music') this.applyMove(d.item, d.dup, pv.target);
      } else if (d.kind === 'music') {
        if (!d.moved) this.host.seek(Math.max(0, this.tOf(d.x0)));
        else if (pv?.valid && pv.target?.kind === 'music') {
          const start = pv.target.start;
          editor.update('音楽を移動', (draft) => {
            const m = draft.timeline.music.find((x) => x.id === d.clip.id);
            if (m) m.start = start;
          });
        }
      }
      this.draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.zoomBy(Math.exp(-e.deltaY * 0.002), pos(e).x);
        } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
          e.preventDefault();
          this.scrollT = Math.max(0, this.scrollT + (e.shiftKey ? e.deltaY : e.deltaX) / this.pps);
          this.draw();
        } else if (this.bodyH <= this.scroller.clientHeight + 1) {
          // 縦にスクロールする必要がないときは、ホイールで横スクロール
          e.preventDefault();
          this.scrollT = Math.max(0, this.scrollT + e.deltaY / this.pps);
          this.draw();
        }
      },
      { passive: false },
    );
  }

  /** ドラッグで動かした（または複製した）クリップを置く。1回の操作として履歴に残す */
  private applyMove(orig: TimedItem, dup: boolean, target: ClipTarget): void {
    const snap = SNAP_PX / this.pps;
    let newId: string | null = null;
    this.host.editor.update(dup ? 'クリップを複製' : 'クリップを移動', (d) => {
      if (!dup) {
        moveClipTo(d, orig.id, target, snap);
        return;
      }
      const src = d.items.find((x) => x.id === orig.id);
      if (!src) return;
      const copy = cloneClip(src);
      newId = copy.id;
      if (target.kind === 'main') insertIntoMain(d, [copy], target.t, snap);
      else if (target.kind === 'overlay') placeOnOverlay(d, copy, target.trackId, target.start);
      else {
        const tr = addTrack(d, target.above);
        placeOnOverlay(d, copy, tr.id, target.start);
      }
    });
    if (newId) this.host.editor.setSelection([newId]);
  }

  // ===== 素材・ファイルのドロップ =====

  private bindDrop(): void {
    const c = this.canvas;
    const previewFor = (e: DragEvent): Preview | null => {
      const lib = getLibraryDrag(e);
      if (!lib && !hasFiles(e)) return null;
      const r = c.getBoundingClientRect();
      this.altHeld = e.altKey;
      // ファイルの中身（長さ）はドロップするまで分からないので、仮の長さで影を出す
      const visual = lib?.find((s) => s.kind !== 'audio');
      // パソコンのファイルは、運んでいる間も種類（MIME）だけは分かる
      const fileItems = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === 'file');
      const music = lib ? lib.length > 0 && lib.every((s) => s.kind === 'audio') : fileItems.length > 0 && fileItems.every((i) => i.type.startsWith('audio/'));
      const len = visual ? sourceLength(visual) : music && lib ? lib[0].duration : PLACEHOLDER_LEN;
      return this.computeTarget(e.clientX - r.left, e.clientY - r.top, len, 0, { music });
    };
    c.addEventListener('dragover', (e) => {
      const pv = previewFor(e);
      if (!pv) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = pv.valid ? 'copy' : 'none';
      this.preview = pv;
      this.draw();
    });
    c.addEventListener('dragleave', () => {
      this.preview = null;
      this.draw();
    });
    c.addEventListener('drop', (e) => {
      const pv = previewFor(e);
      this.preview = null;
      if (!pv) return;
      e.preventDefault();
      e.stopPropagation();
      this.draw();
      if (!pv.valid || !pv.target) return;
      const t = pv.target;
      const target: DropTarget = t.kind === 'music' ? { kind: 'main', t: t.start } : t.kind === 'newTrack' ? { kind: 'newTrack', start: t.start } : t;
      const lib = getLibraryDrag(e);
      this.host.placeSources(lib ?? [...(e.dataTransfer?.files ?? [])], target);
    });
  }

  // ===== 描画 =====

  private paint(t: number): void {
    const { ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = this.cssW;
    const H = this.bodyH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1b1e23';
    ctx.fillRect(0, 0, W, H);
    const doc = this.host.editor.doc;
    const duration = totalDuration(doc);
    const pv = this.preview;

    // 行の背景（ドラッグ先の行は強調）
    for (const r of this.rows) {
      if (r.kind === 'newTrack') {
        const on = pv?.row === r && pv.valid;
        ctx.fillStyle = on ? 'rgba(76,141,255,0.35)' : '#1b1e23';
        ctx.fillRect(0, r.y, W, r.h - 1);
        if (on) {
          ctx.fillStyle = '#cfe0ff';
          ctx.font = '10px system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText('新しいトラックに置く', 8, r.y + r.h / 2);
        }
        continue;
      }
      ctx.fillStyle = r.kind === 'main' ? '#22262c' : '#1f2227';
      ctx.fillRect(0, r.y, W, r.h - 1);
      if (r.track && !r.track.visible) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(0, r.y, W, r.h - 1);
      }
      if (pv?.row === r) {
        ctx.fillStyle = pv.valid ? 'rgba(76,141,255,0.16)' : 'rgba(229,83,75,0.18)';
        ctx.fillRect(0, r.y, W, r.h - 1);
      }
    }
    // 作品の終わり以降は暗く
    const endX = this.xOf(duration);
    if (endX < W) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(Math.max(0, endX), RULER_H, W, H - RULER_H);
    }

    // 目盛り
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * this.pps >= 70) ?? 600;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const t0 = Math.floor(this.scrollT / step) * step;
    for (let tt = t0; this.xOf(tt) < W; tt += step) {
      const x = Math.round(this.xOf(tt)) + 0.5;
      if (x < 0) continue;
      ctx.strokeStyle = '#3a3f47';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 8);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = '#9aa1ab';
      ctx.fillText(formatTime(tt, step < 1), x + 3, RULER_H / 2);
    }

    // I / O の範囲
    const range = this.host.getRange();
    if (range.in !== null || range.out !== null) {
      const a = range.in ?? range.out!;
      const b = range.out ?? range.in!;
      const x0 = Math.max(0, this.xOf(Math.min(a, b)));
      const x1 = Math.min(W, this.xOf(Math.max(a, b)));
      if (x1 > x0) {
        ctx.fillStyle = 'rgba(255, 196, 0, 0.14)';
        ctx.fillRect(x0, 0, x1 - x0, H);
      }
      ctx.fillStyle = '#ffc400';
      for (const [tt, label] of [
        [range.in, 'I'],
        [range.out, 'O'],
      ] as const) {
        if (tt === null) continue;
        const x = this.xOf(tt);
        if (x < 0 || x > W) continue;
        ctx.fillRect(Math.round(x) - 0.5, 0, 1.5, H);
        ctx.fillText(label, x + 3, 7);
      }
    }

    // クリップ
    const sel = new Set(this.host.editor.selection);
    const mainRow = this.rows.find((r) => r.kind === 'main')!;
    const audioRow = this.rows.find((r) => r.kind === 'audio')!;
    const musicRow = this.rows.find((r) => r.kind === 'music')!;
    const d = this.drag;
    const drawSpan = (s: ClipSpan, row: Row) => {
      const it = s.item;
      const selected = sel.has(it.id);
      const dim = d?.kind === 'move' && d.moved && !d.dup && d.item.id === it.id;
      const color = it.type === 'video' ? (selected ? '#3f78e0' : '#2f5aa8') : selected ? '#9a5fd6' : '#7445a8';
      const label = `${it.type === 'image' ? '▣ ' : ''}${it.name}  ${formatTime(s.end - s.start)}`;
      this.block(this.xOf(s.start), row.y + 2, (s.end - s.start) * this.pps, row.h - 5, color, selected, label, dim ? 0.35 : 1);
      if (selected) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(this.xOf(s.start) + 1, row.y + 7, 3, row.h - 15);
        ctx.fillRect(this.xOf(s.end) - 4, row.y + 7, 3, row.h - 15);
      }
    };
    for (const s of mainLayout(doc)) {
      drawSpan(s, mainRow);
      const it = s.item;
      if (it.type === 'video' && this.host.media.get(it.mediaId)?.info.hasAudio) {
        const muted = it.muted || it.volume <= 0;
        const color = muted ? '#3a3f47' : sel.has(it.id) ? '#2f9a63' : '#277a50';
        this.block(this.xOf(s.start), audioRow.y + 2, (s.end - s.start) * this.pps, audioRow.h - 5, color, sel.has(it.id), muted ? 'ミュート' : '');
      }
    }
    for (const s of overlaySpans(doc)) {
      const row = this.rowOfTrack(s.track);
      if (row) drawSpan(s, row);
    }
    const musicSel = this.host.getMusicSelection();
    for (const m of doc.timeline.music) {
      const selected = m.id === musicSel;
      const dim = d?.kind === 'music' && d.moved && d.clip.id === m.id;
      this.block(this.xOf(m.start), musicRow.y + 2, (musicEnd(m) - m.start) * this.pps, musicRow.h - 5, selected ? '#d08a2a' : '#a86a1c', selected, `♪ ${m.name}`, dim ? 0.35 : 1);
    }
    if (mainLayout(doc).length === 0 && !pv) {
      ctx.fillStyle = '#6c727c';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('動画・画像をここにドラッグ&ドロップ（「素材」タブから、またはパソコンから）', 12, mainRow.y + mainRow.h / 2);
    }

    // 置かれる位置の影・挿入線・時刻の吹き出し
    if (pv?.row && pv.valid) {
      const r = pv.row;
      if (pv.line !== null) {
        const x = this.xOf(pv.line);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(x) - 1.5, r.y - 2, 3, r.h + 2);
      }
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(this.xOf(pv.start), r.y + 3, Math.max(4, Math.max(pv.len, MIN_CLIP) * this.pps), r.h - 7, 4);
      ctx.fill();
      ctx.restore();
      this.bubble(formatTime(pv.start), Math.max(4, this.xOf(pv.start)), Math.max(1, r.y - 19));
    }

    // 再生位置
    const px = Math.round(this.xOf(t)) + 0.5;
    if (px >= 0 && px <= W) {
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.stroke();
      ctx.fillStyle = '#ff4d4d';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 7);
      ctx.fill();
    }
  }

  private block(x: number, y: number, w: number, hh: number, color: string, selected: boolean, label: string, alpha = 1): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
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
      ctx.beginPath();
      ctx.rect(x + 4, y, w - 8, hh);
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 6, y + hh / 2);
    }
    ctx.restore();
  }

  private bubble(value: string, x: number, y: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    const w = ctx.measureText(value).width + 10;
    const bx = Math.min(x, this.cssW - w - 2);
    ctx.fillStyle = 'rgba(20,22,26,0.95)';
    ctx.strokeStyle = '#4c8dff';
    ctx.beginPath();
    ctx.roundRect(bx, y, w, 18, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(value, bx + 5, y + 9.5);
    ctx.restore();
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}
