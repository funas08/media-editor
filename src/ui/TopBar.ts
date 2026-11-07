// 上部バー：画像を追加、開く、保存、書き出し、元に戻す／やり直し、ズーム

import type { Editor } from '../core/Editor';
import type { View } from '../render/view';
import { h } from './controls';
import { icons } from './icons';

export interface TopBarActions {
  addImages(): void;
  open(): void;
  save(): void;
  exportImage(): void;
  undo(): void;
  redo(): void;
  zoomOut(): void;
  zoomIn(): void;
  zoom100(): void;
  fit(): void;
  help(): void;
}

function barButton(icon: string, label: string | null, title: string, onClick: () => void): HTMLButtonElement {
  const b = h(
    'button',
    { class: label ? 'tb-btn' : 'tb-btn icon-only', type: 'button', title, 'aria-label': label ?? title, onclick: onClick },
    h('span', { class: 'icon', html: icon }),
    label ? h('span', {}, label) : null,
  ) as HTMLButtonElement;
  // クリックでフォーカスを奪わない（Space パンなどのショートカットを妨げないため）
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}

export class TopBar {
  readonly el: HTMLElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private zoomBtn: HTMLButtonElement;
  readonly saveBtn: HTMLButtonElement;

  constructor(a: TopBarActions) {
    this.undoBtn = barButton(icons.undo, null, '元に戻す（Ctrl+Z）', a.undo);
    this.redoBtn = barButton(icons.redo, null, 'やり直し（Ctrl+Shift+Z）', a.redo);
    this.zoomBtn = h('button', { class: 'tb-btn zoom-label', type: 'button', title: '100% 表示（Ctrl+1）', onclick: a.zoom100 }, '100%') as HTMLButtonElement;
    this.zoomBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.saveBtn = barButton(icons.save, '保存', 'プロジェクトを保存（Ctrl+S、名前を付けて保存は Ctrl+Shift+S）', a.save);

    this.el = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, '画像エディタ'),
      h(
        'div',
        { class: 'tb-group' },
        barButton(icons.imagePlus, '画像を追加', '画像を追加（複数可）', a.addImages),
        barButton(icons.open, '開く', '画像として開く（キャンバスを画像のサイズにする）／プロジェクト（.json）を開く（Ctrl+O）', a.open),
        this.saveBtn,
        barButton(icons.export, '書き出し', '画像として書き出す：形式・品質・倍率を選択（Ctrl+Shift+E）', a.exportImage),
      ),
      h('div', { class: 'tb-sep' }),
      h('div', { class: 'tb-group' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'tb-spacer' }),
      h(
        'div',
        { class: 'tb-group' },
        barButton(icons.minus, null, '縮小（Ctrl+-）', a.zoomOut),
        this.zoomBtn,
        barButton(icons.plus, null, '拡大（Ctrl++）', a.zoomIn),
        barButton(icons.fit, '全体表示', '全体表示（Ctrl+0）', a.fit),
      ),
      h('div', { class: 'tb-sep' }),
      barButton(icons.help, null, 'ショートカット一覧（?）', a.help),
    );
  }

  update(editor: Editor, view: View): void {
    this.undoBtn.disabled = !editor.canUndo;
    this.redoBtn.disabled = !editor.canRedo;
    this.undoBtn.title = editor.undoLabel ? `元に戻す：${editor.undoLabel}（Ctrl+Z）` : '元に戻す（Ctrl+Z）';
    this.redoBtn.title = editor.redoLabel ? `やり直し：${editor.redoLabel}（Ctrl+Shift+Z）` : 'やり直し（Ctrl+Shift+Z）';
    this.updateZoom(view);
  }

  updateZoom(view: View): void {
    const t = `${formatZoom(view.zoom)}%`;
    if (this.zoomBtn.textContent !== t) this.zoomBtn.textContent = t;
  }
}

export function formatZoom(z: number): string {
  const p = z * 100;
  return p < 10 ? p.toFixed(1) : String(Math.round(p));
}
