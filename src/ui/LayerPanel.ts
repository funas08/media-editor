// レイヤー一覧（折りたたみ可能）：選択、表示/非表示、ロック、並べ替え、削除、複製、名前の変更

import type { Editor } from '../core/Editor';
import type { Item } from '../core/types';
import { deleteSelected, duplicateSelected, moveLayers, setItemProps } from '../features/commands';
import { h, iconButton } from './controls';
import { icons } from './icons';

const STORAGE_KEY = 'image-editor.layersCollapsed';
const THUMB_W = 40;
const THUMB_H = 26;

export class LayerPanel {
  readonly el: HTMLElement;
  private editor: Editor;
  private list: HTMLElement;
  private count: HTMLElement;
  private body: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private actionBtns: HTMLButtonElement[];
  private signature = '';
  private thumbs = new Map<string, string>();
  private collapsed: boolean;
  private renaming: string | null = null;

  constructor(editor: Editor) {
    this.editor = editor;
    this.collapsed = loadCollapsed();
    this.count = h('span', { class: 'layer-count' });
    this.toggleBtn = h(
      'button',
      { class: 'layers-header', type: 'button', onclick: () => this.setCollapsed(!this.collapsed) },
      h('span', { class: 'icon chevron', html: icons.chevron }),
      h('span', {}, 'レイヤー'),
      this.count,
    ) as HTMLButtonElement;
    this.toggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.list = h('ul', { class: 'layer-list', role: 'listbox', 'aria-label': 'レイヤー', 'aria-multiselectable': 'true' });
    this.actionBtns = [
      iconButton(icons.up, '前面へ（Ctrl+]）', () => moveLayers(editor, 'up')),
      iconButton(icons.down, '背面へ（Ctrl+[）', () => moveLayers(editor, 'down')),
      iconButton(icons.copy, '複製（Ctrl+D）', () => duplicateSelected(editor)),
      iconButton(icons.trash, '削除（Delete）', () => deleteSelected(editor)),
    ];
    this.body = h('div', { class: 'layers-body' }, this.list, h('div', { class: 'layer-actions' }, ...this.actionBtns));
    this.el = h('section', { class: 'layers' }, this.toggleBtn, this.body);
    this.applyCollapsed();
  }

  private setCollapsed(v: boolean): void {
    this.collapsed = v;
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
    } catch {
      // 保存できなくても動作には影響しない
    }
    this.applyCollapsed();
  }

  private applyCollapsed(): void {
    this.el.classList.toggle('collapsed', this.collapsed);
    this.toggleBtn.setAttribute('aria-expanded', String(!this.collapsed));
  }

  /**
   * 一覧の内容が変わったときだけ行を作り直す（ドラッグ中の位置の変化や選択の変化では作り直さない）。
   * 選択の変化で作り直すと、ダブルクリックの途中で行が置き換わって名前の変更が始まらないため
   */
  update(): void {
    const { doc, selection } = this.editor;
    const sig = JSON.stringify([doc.items.map((it) => [it.id, it.name, it.visible, it.locked, it.type === 'image' ? it.crop : 0]), this.renaming]);
    for (const b of this.actionBtns) b.disabled = selection.length === 0;
    if (sig !== this.signature) {
      this.signature = sig;
      this.count.textContent = `${doc.items.length}`;
      const rows = [...doc.items].reverse().map((it) => this.row(it));
      if (rows.length === 0) rows.push(h('li', { class: 'layer-empty' }, '画像はまだありません'));
      this.list.replaceChildren(...rows);
    }
    // 選択状態の表示だけを更新
    for (const li of this.list.querySelectorAll<HTMLElement>('li.layer')) {
      const sel = selection.includes(li.dataset.id ?? '');
      li.classList.toggle('selected', sel);
      li.setAttribute('aria-selected', String(sel));
    }
  }

  private row(it: Item): HTMLElement {
    const editor = this.editor;
    const name: HTMLElement =
      this.renaming === it.id ? this.renameInput(it) : h('span', { class: 'layer-name', title: `${it.name}（ダブルクリックで名前を変更）` }, it.name);
    const visBtn = iconButton(it.visible ? icons.eye : icons.eyeOff, it.visible ? '非表示にする' : '表示する', () =>
      setItemProps(editor, it.id, it.visible ? '非表示' : '表示', { visible: !it.visible }),
    );
    const lockBtn = iconButton(it.locked ? icons.lock : icons.unlock, it.locked ? 'ロックを解除' : 'ロックする', () =>
      setItemProps(editor, it.id, it.locked ? 'ロック解除' : 'ロック', { locked: !it.locked }),
    );
    lockBtn.classList.toggle('on', it.locked);
    visBtn.classList.toggle('off', !it.visible);
    const li = h(
      'li',
      {
        class: it.visible ? 'layer' : 'layer hidden-item',
        role: 'option',
        'data-id': it.id,
      },
      h('img', { class: 'layer-thumb', src: this.thumb(it), alt: '' }),
      name,
      visBtn,
      lockBtn,
    );
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.icon-btn, input')) return;
      const sel = editor.selection;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        editor.setSelection(sel.includes(it.id) ? sel.filter((id) => id !== it.id) : [...sel, it.id]);
      } else {
        editor.setSelection([it.id]);
      }
    });
    li.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.icon-btn')) return;
      this.renaming = it.id;
      this.signature = '';
      this.update();
    });
    return li;
  }

  private renameInput(it: Item): HTMLElement {
    const input = h('input', { class: 'layer-rename', value: it.name }) as HTMLInputElement;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.renaming = null;
      this.signature = '';
      const v = input.value.trim();
      if (save && v && v !== it.name) setItemProps(this.editor, it.id, '名前の変更', { name: v });
      else this.update();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  /** サムネイル（トリミング後の見た目）。アセットとトリミング範囲ごとにキャッシュ */
  private thumb(it: Item): string {
    if (it.type !== 'image') return '';
    const key = `${it.assetId}:${it.crop.x},${it.crop.y},${it.crop.w},${it.crop.h}`;
    const cached = this.thumbs.get(key);
    if (cached) return cached;
    const asset = this.editor.assets.get(it.assetId);
    if (!asset) return '';
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    c.width = THUMB_W * dpr;
    c.height = THUMB_H * dpr;
    const g = c.getContext('2d')!;
    const s = Math.min(c.width / it.crop.w, c.height / it.crop.h);
    const w = it.crop.w * s;
    const hh = it.crop.h * s;
    g.imageSmoothingQuality = 'high';
    g.drawImage(asset.bitmap, it.crop.x, it.crop.y, it.crop.w, it.crop.h, (c.width - w) / 2, (c.height - hh) / 2, w, hh);
    const url = c.toDataURL();
    this.thumbs.set(key, url);
    return url;
  }
}

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
