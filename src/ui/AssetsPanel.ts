// 素材パネル：読み込んだ動画・画像・音楽の一覧（サムネイル・長さ・解像度）。
// 「＋」かパネルへのドロップで読み込む（タイムラインには置かない）。タイムライン・キャンバスへドラッグして置く。
// ダブルクリックでメインの最後（音楽は再生位置）に置く。

import { formatTime } from '../core/timeline';
import { button, h, iconButton } from './controls';
import { LIBRARY_DRAG_TYPE, setLibraryDrag } from './dragState';
import { icons } from './icons';
import type { Library, LibraryEntry } from './Library';

export interface AssetsPanelHost {
  /** ファイルを素材として読み込む */
  importFiles(files: File[]): Promise<LibraryEntry[]>;
  pickAndImport(): void;
  /** ダブルクリックで置く */
  quickPlace(entry: LibraryEntry): void;
  /** 素材を削除する（使用中なら確認する） */
  removeSource(entry: LibraryEntry): void;
}

export class AssetsPanel {
  readonly el: HTMLElement;
  private library: Library;
  private host: AssetsPanelHost;
  private list: HTMLElement;

  constructor(library: Library, host: AssetsPanelHost) {
    this.library = library;
    this.host = host;
    this.list = h('ul', { class: 'asset-list' });
    const addBtn = button('素材を読み込む', () => host.pickAndImport(), { icon: icons.plus, title: '動画・画像・音楽を読み込む（タイムラインには置きません）' });
    addBtn.classList.add('block-left');
    this.el = h('div', { class: 'assets' }, this.list, h('div', { class: 'asset-actions' }, addBtn));
    // パネルへのドロップで読み込む
    this.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      this.el.classList.add('drag-over');
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drag-over'));
    this.el.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      this.el.classList.remove('drag-over');
      void host.importFiles([...e.dataTransfer.files]);
    });
    library.changed.on(() => this.render());
    this.render();
  }

  get count(): number {
    return this.library.entries().length;
  }

  private render(): void {
    const entries = this.library.entries();
    if (entries.length === 0) {
      this.list.replaceChildren(h('li', { class: 'layer-empty' }, '素材はまだありません。「素材を読み込む」か、ここにファイルをドロップしてください'));
      return;
    }
    this.list.replaceChildren(...entries.map((e) => this.row(e)));
  }

  private row(e: LibraryEntry): HTMLElement {
    const kindLabel = { image: '画像', video: '動画', audio: '音楽' }[e.kind];
    const meta = [kindLabel, e.width > 0 ? `${e.width}×${e.height}` : '', e.duration > 0 ? formatTime(e.duration) : '', e.bitrateText ?? ''].filter(Boolean).join('・');
    const thumb = e.thumb ? h('img', { class: 'asset-thumb', src: e.thumb, alt: '' }) : h('span', { class: 'asset-thumb asset-thumb-icon', html: e.kind === 'audio' ? icons.music : icons.film });
    const del = iconButton(icons.trash, '素材を削除', () => this.host.removeSource(e));
    const li = h(
      'li',
      { class: 'asset', draggable: true, title: `${e.name}${e.details ? `\n${e.details}` : ''}\nドラッグしてタイムライン・キャンバスに置く／ダブルクリックで追加` },
      thumb,
      h('div', { class: 'asset-text' }, h('span', { class: 'asset-name' }, e.name), h('span', { class: 'asset-meta' }, meta)),
      del,
    );
    li.addEventListener('dragstart', (ev) => {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.setData(LIBRARY_DRAG_TYPE, e.id);
      ev.dataTransfer.effectAllowed = 'copy';
      setLibraryDrag([e]);
    });
    li.addEventListener('dragend', () => setLibraryDrag(null));
    li.addEventListener('dblclick', (ev) => {
      if ((ev.target as HTMLElement).closest('.icon-btn')) return;
      this.host.quickPlace(e);
    });
    return li;
  }
}
