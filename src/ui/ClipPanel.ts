// 設定欄の「クリップ」：動画モードで、タイムラインに置いたクリップを選んだときに表示する。
// 位置のプリセット（四隅・中央＋余白）、不透明度、フェードイン/アウト、表示時間（画像）、開始時刻（オーバーレイ）、音量（動画）。
// 音楽クリップを選んだときは、音量・開始時刻。

import type { Editor } from '../core/Editor';
import { itemBounds } from '../core/geometry';
import { isTimed, isTrackLocked, mainLayout, overlaySpans, formatTime, type TimedItem } from '../core/timeline';
import { MAIN_TRACK, type DocState } from '../core/types';
import { MIN_CLIP } from '../features/videoEdit';
import { button, checkbox, group, h, hint, numberInput, row, slider, text } from './controls';
import { icons } from './icons';

export interface ClipPanelHost {
  readonly editor: Editor;
  getMusicSelection(): string | null;
  selectMusic(id: string | null): void;
}

type Corner = 'tl' | 'tr' | 'bl' | 'br' | 'center';

/** 位置のプリセットの余白（px）。ツールを切り替えても保持 */
let margin = 40;

export class ClipPanel {
  readonly el: HTMLElement;
  private update_: () => void;

  constructor(host: ClipPanelHost) {
    const editor = host.editor;
    const info = text('', 'value strong');
    const sub = text('', 'hint');

    const targets = (): TimedItem[] => editor.doc.items.filter((it): it is TimedItem => isTimed(it) && editor.isSelected(it.id) && !it.locked && !isTrackLocked(editor.doc, it));

    /** スライダー用：動かしている間はプレビューし、離したら1回分として履歴に残す */
    const live = (label: string, fn: (d: DocState, ids: string[]) => void, final: boolean) => {
      const ids = targets().map((it) => it.id);
      if (ids.length === 0) return;
      if (!editor.inTransaction) editor.begin(label);
      editor.preview((d) => fn(d, ids));
      if (final) editor.commit();
    };
    const each = (label: string, fn: (it: TimedItem) => void) => {
      const ids = targets().map((it) => it.id);
      if (ids.length === 0) return;
      editor.update(label, (d) => {
        for (const it of d.items) if (ids.includes(it.id) && isTimed(it)) fn(it);
      });
    };

    // 位置のプリセット
    const place = (c: Corner) =>
      each('位置', (it) => {
        const b = itemBounds(it);
        const { width: W, height: H } = editor.doc.canvas;
        const x = c === 'tl' || c === 'bl' ? margin : c === 'center' ? (W - b.w) / 2 : W - margin - b.w;
        const y = c === 'tl' || c === 'tr' ? margin : c === 'center' ? (H - b.h) / 2 : H - margin - b.h;
        it.cx += x - b.x;
        it.cy += y - b.y;
      });
    const posBtn = (c: Corner, label: string) => button(label, () => place(c));
    const marginIn = numberInput({ value: margin, min: 0, max: 4000, unit: 'px', onChange: (v) => (margin = v) });
    const posGroup = group(
      '位置',
      h('div', { class: 'pos-grid' }, posBtn('tl', '左上'), posBtn('tr', '右上'), posBtn('center', '中央'), posBtn('bl', '左下'), posBtn('br', '右下')),
      row('余白', marginIn.el),
    );

    // 不透明度・フェード
    const opacity = slider({
      label: '不透明度',
      min: 0,
      max: 100,
      value: 100,
      defaultValue: 100,
      unit: '%',
      onInput: (v) => live('不透明度', (d, ids) => setClip(d, ids, (c) => (c.opacity = v / 100)), false),
      onChange: (v) => live('不透明度', (d, ids) => setClip(d, ids, (c) => (c.opacity = v / 100)), true),
    });
    const fadeIn = numberInput({ value: 0, min: 0, max: 60, step: 0.1, digits: 2, unit: '秒', onChange: (v) => each('フェードイン', (it) => (it.clip.fadeIn = v)) });
    const fadeOut = numberInput({ value: 0, min: 0, max: 60, step: 0.1, digits: 2, unit: '秒', onChange: (v) => each('フェードアウト', (it) => (it.clip.fadeOut = v)) });

    // 時間
    const duration = numberInput({ value: 5, min: MIN_CLIP, max: 3600, step: 0.5, digits: 2, unit: '秒', onChange: (v) => each('表示時間', (it) => it.type === 'image' && (it.clip.duration = v)) });
    const durationRow = row('表示時間', duration.el);
    const start = numberInput({ value: 0, min: 0, step: 0.1, digits: 2, unit: '秒', onChange: (v) => each('開始時刻', (it) => it.clip.track !== MAIN_TRACK && (it.clip.start = v)) });
    const startRow = row('開始', start.el);

    // 音量（動画）
    const volume = slider({
      label: '音量',
      min: 0,
      max: 200,
      value: 100,
      defaultValue: 100,
      unit: '%',
      onInput: (v) => live('音量', (d, ids) => setVideo(d, ids, (it) => (it.volume = v / 100)), false),
      onChange: (v) => live('音量', (d, ids) => setVideo(d, ids, (it) => (it.volume = v / 100)), true),
    });
    const mute = checkbox('ミュート', false, (v) => each(v ? 'ミュート' : 'ミュート解除', (it) => it.type === 'video' && (it.muted = v)));
    const audioGroup = group('音声', volume.el, mute.el, hint('オーバーレイの動画（ワイプ）の音声は、最初はミュートになっています。'));

    // 音楽クリップ
    const musicVolume = slider({
      label: '音量',
      min: 0,
      max: 200,
      value: 100,
      defaultValue: 100,
      unit: '%',
      onInput: (v) => liveMusic((m) => (m.volume = v / 100), false),
      onChange: (v) => liveMusic((m) => (m.volume = v / 100), true),
    });
    const musicStart = numberInput({ value: 0, min: 0, step: 0.1, digits: 2, unit: '秒', onChange: (v) => updateMusic('音楽の開始時刻', (m) => (m.start = v)) });
    const musicDel = button('音楽を削除', () => updateMusic('音楽を削除', (m, d) => (d.timeline.music = d.timeline.music.filter((x) => x.id !== m.id))), { icon: icons.trash, danger: true });
    const musicGroup = h('div', {}, group('音楽', musicVolume.el, row('開始', musicStart.el)), musicDel);
    const liveMusic = (fn: (m: DocState['timeline']['music'][number]) => void, final: boolean) => {
      const id = host.getMusicSelection();
      if (!id) return;
      if (!editor.inTransaction) editor.begin('音楽の音量');
      editor.preview((d) => {
        const m = d.timeline.music.find((x) => x.id === id);
        if (m) fn(m);
      });
      if (final) editor.commit();
    };
    const updateMusic = (label: string, fn: (m: DocState['timeline']['music'][number], d: DocState) => void) => {
      const id = host.getMusicSelection();
      if (!id) return;
      editor.update(label, (d) => {
        const m = d.timeline.music.find((x) => x.id === id);
        if (m) fn(m, d);
      });
    };

    const clipBody = h(
      'div',
      {},
      posGroup,
      group('表示', opacity.el, row('フェードイン', fadeIn.el), row('フェードアウト', fadeOut.el)),
      group('時間', startRow, durationRow),
      audioGroup,
    );
    this.el = h('section', { class: 'clip-panel' }, h('div', { class: 'panel-title' }, 'クリップ'), group(null, info.el, sub.el), clipBody, musicGroup);

    this.update_ = () => {
      const doc = editor.doc;
      const musicId = host.getMusicSelection();
      const music = musicId ? doc.timeline.music.find((m) => m.id === musicId) : undefined;
      const items = targets();
      const first = items[0];
      this.el.hidden = !first && !music;
      clipBody.hidden = !first;
      musicGroup.hidden = !!first || !music;
      if (first) {
        const trackName = first.clip.track === MAIN_TRACK ? 'メイン' : `オーバーレイ ${overlayNumber(doc, first.clip.track)}`;
        const span = [...mainLayout(doc), ...overlaySpans(doc)].find((s) => s.item.id === first.id);
        info.set(items.length > 1 ? `${items.length}個のクリップ（数値は1つ目）` : first.name);
        sub.set(`${trackName}・${span ? `${formatTime(span.start)} 〜 ${formatTime(span.end)}` : ''}`);
        opacity.set(Math.round(first.clip.opacity * 100));
        fadeIn.set(first.clip.fadeIn);
        fadeOut.set(first.clip.fadeOut);
        durationRow.hidden = first.type !== 'image';
        duration.set(first.clip.duration);
        startRow.hidden = first.clip.track === MAIN_TRACK;
        start.set(first.clip.start);
        audioGroup.hidden = first.type !== 'video';
        if (first.type === 'video') {
          volume.set(Math.round(first.volume * 100));
          mute.set(first.muted);
        }
      } else if (music) {
        info.set(`♪ ${music.name}`);
        sub.set(`音楽・${formatTime(music.start)} 〜 ${formatTime(music.start + music.outPoint - music.inPoint)}`);
        musicVolume.set(Math.round(music.volume * 100));
        musicStart.set(music.start);
      }
    };
    this.update_();
  }

  update(): void {
    this.update_();
  }
}

function setClip(d: DocState, ids: string[], fn: (c: NonNullable<TimedItem['clip']>) => void): void {
  for (const it of d.items) if (ids.includes(it.id) && it.clip) fn(it.clip);
}

function setVideo(d: DocState, ids: string[], fn: (it: Extract<TimedItem, { type: 'video' }>) => void): void {
  for (const it of d.items) if (ids.includes(it.id) && it.type === 'video' && it.clip) fn(it as Extract<TimedItem, { type: 'video' }>);
}

function overlayNumber(doc: DocState, trackId: string): number {
  const tracks = doc.timeline.overlays;
  return tracks.length - tracks.findIndex((t) => t.id === trackId);
}
