// アプリ全体の組み立て：Editor・表示・ツール・UI をつなぎ、入力（マウス・キーボード・D&D・貼り付け）を振り分ける

import { Editor } from '../core/Editor';
import type { Point } from '../core/types';
import {
  addImageItems,
  blankDocument,
  deleteSelected,
  documentFromImage,
  duplicateSelected,
  loadAssets,
  moveLayers,
  selectAll,
  usedAssetIds,
} from '../features/commands';
import { IMAGE_ACCEPT, filesFromDrop, imagesFromClipboard, isImageFile, pickFiles } from '../io/files';
import { PROJECT_EXT, buildProject, restoreProject } from '../io/project';
import { LocalFileProjectStorage, type ProjectStorage } from '../io/ProjectStorage';
import type { DocState } from '../core/types';
import { ACCENT, strokeItem } from '../render/overlay';
import { CanvasSceneView } from '../render/ViewRenderer';
import { View } from '../render/view';
import { getTool, getTools } from '../tools/registry';
import type { Tool, ToolActivateOptions, ToolHost, ToolPointerEvent } from '../tools/Tool';
import { h } from './controls';
import { isDialogOpen } from './Dialog';
import { openExportDialog } from './ExportDialog';
import { icons } from './icons';
import { LayerPanel } from './LayerPanel';
import { LeftPanel } from './LeftPanel';
import { openShortcutsDialog } from './ShortcutsDialog';
import { openStartDialog } from './StartDialog';
import { StatusBar } from './StatusBar';
import { Toaster } from './toast';
import { TopBar } from './TopBar';

export class App implements ToolHost {
  readonly editor = new Editor();
  readonly view = new View();

  private tool: Tool;
  private scene: CanvasSceneView;
  private viewport: HTMLElement;
  private emptyState: HTMLElement;
  private topBar: TopBar;
  private left: LeftPanel;
  private layers: LayerPanel;
  private status = new StatusBar();
  private toaster = new Toaster();

  private renderQueued = false;
  private fitted = false;
  private cursorDoc: Point | null = null;
  private cursorOverride: string | null = null;
  private spaceDown = false;
  private panning: { last: Point; pointerId: number } | null = null;
  private dropTimer = 0;
  private lastCanvasSize = { w: 0, h: 0 };

  /** プロジェクトの保存先（差し替え可能） */
  private storage: ProjectStorage = new LocalFileProjectStorage();
  private projectName: string | null = null;
  /** 最後に保存（または読み込み）した時点のドキュメント。今の doc と同じなら未保存の変更なし */
  private savedDoc: DocState;

  constructor(root: HTMLElement) {
    const first = getTool('select') ?? getTools()[0];
    if (!first) throw new Error('ツールが登録されていません');
    this.tool = first;
    this.savedDoc = this.editor.doc;

    // ---- 画面の組み立て ----
    this.topBar = new TopBar({
      newDoc: () => this.newDocument(),
      addImages: () => void this.addImagesFromPicker(),
      open: () => void this.openFromPicker(),
      save: () => void this.saveProject(false),
      exportImage: () => this.openExport(),
      undo: () => this.editor.undo(),
      redo: () => this.editor.redo(),
      zoomOut: () => this.stepZoom(-1),
      zoomIn: () => this.stepZoom(1),
      zoom100: () => this.setZoom(1),
      fit: () => this.fitView(),
      help: () => openShortcutsDialog(),
    });

    this.left = new LeftPanel(this);
    this.layers = new LayerPanel(this.editor);
    this.left.bottom.append(this.layers.el);
    const canvas = h('canvas', { class: 'scene' });
    this.scene = new CanvasSceneView(canvas);
    this.emptyState = h(
      'div',
      { class: 'empty-state' },
      h('div', { class: 'empty-icon', html: icons.imagePlus }),
      h('p', { class: 'empty-title' }, 'ここに画像をドラッグ&ドロップ'),
      h('p', { class: 'empty-sub' }, '複数枚まとめて追加できます。Ctrl+V で貼り付け、プロジェクト（.json）のドロップもできます'),
      h(
        'div',
        { class: 'empty-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => void this.addImagesFromPicker() }, '画像を追加'),
        h('button', { class: 'btn', type: 'button', onclick: () => this.newDocument() }, '新規作成…'),
      ),
    );
    this.viewport = h('main', { class: 'viewport' }, canvas, this.emptyState);

    root.replaceChildren(
      h('div', { class: 'app' }, this.topBar.el, this.left.el, this.viewport, this.status.el),
      this.toaster.el,
    );

    // ---- イベント ----
    this.editor.changed.on(() => {
      // キャンバスのサイズが変わったら（トリミングの確定・元に戻すなど）全体表示にする
      const c = this.editor.doc.canvas;
      if (c.width !== this.lastCanvasSize.w || c.height !== this.lastCanvasSize.h) {
        this.lastCanvasSize = { w: c.width, h: c.height };
        if (this.fitted) this.fitView();
      }
      this.refreshUI();
    });
    this.bindViewport();
    this.bindKeyboard();
    this.bindDropAndPaste();

    new ResizeObserver(() => {
      const r = this.viewport.getBoundingClientRect();
      this.scene.resize(r.width, r.height);
      if (!this.fitted) {
        this.fitted = true;
        this.fitView();
      }
      this.renderNow();
    }).observe(this.viewport);

    this.left.showTool(this.tool, this);
    this.tool.activate?.(this);
    this.updateCursor();
    this.refreshUI();
    // 起動時は「新規作成」の画面を出す
    queueMicrotask(() => this.showStartScreen());
  }

  // ===== ToolHost =====

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  refreshUI(): void {
    this.left.update();
    this.layers.update();
    this.topBar.update(this.editor, this.view);
    this.emptyState.hidden = this.editor.doc.items.length > 0;
    document.title = `${this.isDirty() ? '● ' : ''}${this.projectName ?? '無題'} - 画像エディタ`;
    this.requestRender();
  }

  /** 保存していない変更があるか */
  private isDirty(): boolean {
    return this.editor.doc !== this.savedDoc && this.editor.doc.items.length > 0;
  }

  fitView(): void {
    const c = this.editor.doc.canvas;
    this.view.fit(this.scene.width, this.scene.height, c.width, c.height);
    this.requestRender();
  }

  setTool(id: string, opts?: ToolActivateOptions): void {
    const next = getTool(id);
    if (!next || (next === this.tool && !opts)) return;
    this.editor.commit();
    this.tool.deactivate?.(this);
    this.tool = next;
    this.cursorOverride = null;
    this.left.showTool(next, this);
    next.activate?.(this, opts);
    this.updateCursor();
    this.refreshUI();
  }

  toast(message: string): void {
    this.toaster.show(message);
  }

  setCursor(cursor: string | null): void {
    this.cursorOverride = cursor;
    this.updateCursor();
  }

  // ===== 描画 =====

  private renderNow(): void {
    const doc = this.tool.getPreview?.(this.editor.doc, this) ?? this.editor.doc;
    this.scene.render({
      doc,
      canvasArea: this.tool.getCanvasArea?.(this.editor.doc, this) ?? null,
      assets: this.editor.assets,
      view: this.view,
      overlay: (ctx) => {
        // 選択枠（どのツールでも表示）
        for (const id of this.editor.selection) {
          const it = doc.items.find((x) => x.id === id);
          if (it && it.visible) strokeItem(ctx, this.view, it, ACCENT, 1.5);
        }
        this.tool.drawOverlay?.(ctx, this);
      },
    });
    this.topBar.updateZoom(this.view);
    this.status.update({
      tool: `${this.tool.name}（${this.tool.shortcut}）`,
      zoom: this.view.zoom,
      cursor: this.cursorDoc,
      canvasW: this.editor.doc.canvas.width,
      canvasH: this.editor.doc.canvas.height,
      selected: this.editor.selection.length,
      total: this.editor.doc.items.length,
    });
  }

  // ===== ズーム =====

  private setZoom(z: number): void {
    this.view.setZoomCentered(z, this.scene.width, this.scene.height);
    this.requestRender();
  }

  private stepZoom(dir: 1 | -1): void {
    this.setZoom(this.view.stepZoom(dir));
  }

  // ===== マウス・ホイール =====

  private toolEvent(e: PointerEvent | MouseEvent): ToolPointerEvent {
    const r = this.viewport.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    return {
      doc: this.view.screenToDoc(screen),
      screen,
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey || e.metaKey,
      buttons: e.buttons,
      original: e as PointerEvent,
    };
  }

  private bindViewport(): void {
    const vp = this.viewport;
    vp.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.empty-actions')) return;
      // 入力欄からフォーカスを外して、ショートカットが効くようにする
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const te = this.toolEvent(e);
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        e.preventDefault();
        vp.setPointerCapture(e.pointerId);
        this.panning = { last: te.screen, pointerId: e.pointerId };
        this.updateCursor();
        return;
      }
      if (e.button !== 0) return;
      vp.setPointerCapture(e.pointerId);
      this.tool.onPointerDown?.(te, this);
      this.requestRender();
    });
    vp.addEventListener('pointermove', (e) => {
      const te = this.toolEvent(e);
      this.cursorDoc = te.doc;
      if (this.panning) {
        this.view.panX += te.screen.x - this.panning.last.x;
        this.view.panY += te.screen.y - this.panning.last.y;
        this.panning.last = te.screen;
      } else {
        this.tool.onPointerMove?.(te, this);
      }
      this.requestRender();
    });
    const end = (e: PointerEvent) => {
      if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);
      if (this.panning) {
        this.panning = null;
        this.updateCursor();
        return;
      }
      this.tool.onPointerUp?.(this.toolEvent(e), this);
      this.requestRender();
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
    vp.addEventListener('pointerleave', () => {
      this.cursorDoc = null;
      this.requestRender();
    });
    vp.addEventListener('dblclick', (e) => {
      if (this.spaceDown) return;
      this.tool.onDoubleClick?.(this.toolEvent(e), this);
      this.requestRender();
    });
    vp.addEventListener('contextmenu', (e) => e.preventDefault());
    // ホイールでズーム（カーソル位置基準）
    vp.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        // タッチパッドのピンチは ctrlKey 付きで細かい値が来るので感度を上げる
        const k = e.ctrlKey ? 0.01 : 0.0015;
        const factor = Math.exp(-e.deltaY * unit * k);
        this.view.zoomAt(this.view.zoom * factor, e.clientX - r.left, e.clientY - r.top);
        this.requestRender();
      },
      { passive: false },
    );
  }

  private updateCursor(): void {
    const c = this.panning ? 'grabbing' : this.spaceDown ? 'grab' : (this.cursorOverride ?? this.tool.cursor ?? 'default');
    this.viewport.style.cursor = c;
  }

  // ===== キーボード =====

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      // ダイアログ表示中はキャンバスのショートカットを無効にする
      if (isDialogOpen() || isTypingTarget(e)) return;
      // Alt 単独で押したときにブラウザのメニューへフォーカスが移るのを防ぐ（Alt はスナップの一時無効に使う）
      if (e.key === 'Alt') {
        e.preventDefault();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (!this.spaceDown) {
          this.spaceDown = true;
          this.updateCursor();
        }
        return;
      }
      // ツール固有のキー操作が優先
      if (this.tool.onKeyDown?.(e, this)) {
        e.preventDefault();
        this.requestRender();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        let handled = true;
        switch (e.code) {
          case 'KeyZ':
            if (e.shiftKey) this.editor.redo();
            else this.editor.undo();
            break;
          case 'KeyY':
            this.editor.redo();
            break;
          case 'KeyA':
            selectAll(this.editor);
            break;
          case 'KeyD':
            duplicateSelected(this.editor);
            break;
          case 'Digit0':
          case 'Numpad0':
            this.fitView();
            break;
          case 'Digit1':
          case 'Numpad1':
            this.setZoom(1);
            break;
          case 'Equal':
          case 'Semicolon': // JIS 配列の「+」
          case 'NumpadAdd':
            this.stepZoom(1);
            break;
          case 'Minus':
          case 'NumpadSubtract':
            this.stepZoom(-1);
            break;
          case 'KeyO':
            void this.openFromPicker();
            break;
          case 'KeyN':
            // アプリとしてインストールした場合などは Ctrl+N も使える
            this.newDocument();
            break;
          case 'KeyS':
            void this.saveProject(e.shiftKey);
            break;
          case 'KeyE':
            if (e.shiftKey) this.openExport();
            else handled = false;
            break;
          default:
            // レイヤーの前面・背面（キー配列に依存しないよう e.key で判定）
            if (e.key === ']') moveLayers(this.editor, e.shiftKey ? 'top' : 'up');
            else if (e.key === '[') moveLayers(this.editor, e.shiftKey ? 'bottom' : 'down');
            else if (e.key === '}') moveLayers(this.editor, 'top');
            else if (e.key === '{') moveLayers(this.editor, 'bottom');
            else handled = false;
        }
        if (handled) e.preventDefault();
        return;
      }
      // 新規作成：Alt+N（Chrome の通常のタブでは Ctrl+N をページ側で受け取れないため）
      if (e.altKey && !e.shiftKey && e.code === 'KeyN') {
        e.preventDefault();
        this.newDocument();
        return;
      }
      if (e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected(this.editor);
        return;
      }
      if (e.key === 'Escape') {
        this.editor.setSelection([]);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        openShortcutsDialog();
        return;
      }
      // ツールの切り替え（IME がオンでも効くよう e.code で判定）
      const t = getTools().find((x) => e.code === `Key${x.shortcut}`);
      if (t && !e.shiftKey) {
        e.preventDefault();
        this.setTool(t.id);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') e.preventDefault();
      this.tool.onKeyUp?.(e, this);
      if (e.code === 'Space' && this.spaceDown) {
        this.spaceDown = false;
        this.updateCursor();
      }
    });
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      this.updateCursor();
    });
  }

  // ===== D&D・貼り付け =====

  private bindDropAndPaste(): void {
    // ページ全体でドロップを受け付ける（ブラウザがファイルを開いてしまうのを防ぐ）
    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.viewport.classList.add('drag-over');
      clearTimeout(this.dropTimer);
      this.dropTimer = window.setTimeout(() => this.viewport.classList.remove('drag-over'), 150);
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.viewport.classList.remove('drag-over');
      if (isDialogOpen()) return;
      const files = filesFromDrop(e);
      const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXT));
      if (project) void this.loadProject(project);
      else void this.addFiles(files);
    });
    // 保存していない変更があるときは、ページを閉じる前に確認する
    window.addEventListener('beforeunload', (e) => {
      if (this.isDirty()) e.preventDefault();
    });
    document.addEventListener('paste', (e) => {
      if (isDialogOpen() || isTypingTarget(e)) return;
      const files = imagesFromClipboard(e);
      if (files.length === 0) return;
      e.preventDefault();
      void this.addFiles(files);
    });
  }

  // ===== ファイル操作 =====

  private async addImagesFromPicker(): Promise<void> {
    const files = await pickFiles(IMAGE_ACCEPT, true);
    await this.addFiles(files);
  }

  async addFiles(files: File[]): Promise<void> {
    const images = files.filter(isImageFile);
    const skipped = files.length - images.length;
    if (images.length === 0) {
      if (files.length > 0) this.toast('画像ファイルではありません');
      return;
    }
    const { assets, failed } = await loadAssets(this.editor, images);
    addImageItems(this.editor, assets);
    if (assets.length > 0) this.toast(`${assets.length}枚の画像を追加しました`);
    if (failed.length > 0) this.toast(`読み込めませんでした：${failed.join('、')}`);
    else if (skipped > 0) this.toast(`画像以外のファイル ${skipped} 件は無視しました`);
  }

  // ===== 新規作成・開く =====

  /** 未保存の変更があれば、破棄してよいか確認する */
  private confirmDiscard(): boolean {
    return !this.isDirty() || window.confirm('保存していない変更があります。破棄して続けますか？');
  }

  /** ドキュメントを丸ごと差し替える（新規作成・画像を開く・プロジェクトを開く） */
  private replaceDocument(doc: DocState, projectName: string | null): void {
    this.editor.reset(doc);
    this.editor.assets.retainOnly(usedAssetIds(doc));
    this.savedDoc = this.editor.doc;
    this.projectName = projectName;
    if (projectName === null) this.storage.forget();
    this.fitView();
    this.refreshUI();
  }

  /** 新規作成：起動画面を出す */
  newDocument(): void {
    if (isDialogOpen() || !this.confirmDiscard()) return;
    this.showStartScreen();
  }

  /** 起動画面（確認は済んでいる前提） */
  showStartScreen(): void {
    openStartDialog({
      openImages: (files) => this.openImagesAsNew(files),
      pickImage: async () => {
        const files = await pickFiles(IMAGE_ACCEPT, true);
        return files.length > 0 ? this.openImagesAsNew(files) : false;
      },
      openProject: (file) => this.loadProject(file, false),
      newBlank: (opts) => {
        this.replaceDocument(blankDocument(opts), null);
        this.toast(`${opts.width}×${opts.height} のキャンバスを作成しました`);
      },
    });
  }

  /**
   * 画像を開く：1枚目でキャンバスのサイズを決めて (0,0) にぴったり置き、2枚目以降は追加の画像として置く。
   * 新しいドキュメントになったら true
   */
  private async openImagesAsNew(files: File[]): Promise<boolean> {
    const images = files.filter(isImageFile);
    if (images.length === 0) {
      this.toast('画像ファイルではありません');
      return false;
    }
    const [first, ...rest] = images;
    const { assets, failed } = await loadAssets(this.editor, [first]);
    if (failed.length > 0 || !assets[0]) {
      this.toast(`読み込めませんでした：${first.name}`);
      return false;
    }
    this.replaceDocument(documentFromImage(assets[0]), null);
    this.toast(`${first.name} を開きました（${assets[0].width}×${assets[0].height}）`);
    if (rest.length > 0) await this.addFiles(rest);
    return true;
  }

  /** 開く：画像なら「画像を開く」（新しいドキュメント）、.json ならプロジェクトを読み込む */
  private async openFromPicker(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const files = await pickFiles(`${IMAGE_ACCEPT},${PROJECT_EXT},application/json`, false);
    const f = files[0];
    if (!f) return;
    if (f.name.toLowerCase().endsWith(PROJECT_EXT)) await this.loadProject(f, false);
    else await this.openImagesAsNew([f]);
  }

  private openExport(): void {
    this.editor.commit();
    openExportDialog(this.editor, (m) => this.toast(m));
  }

  // ===== プロジェクトの保存・読み込み =====

  private async saveProject(saveAs: boolean): Promise<void> {
    this.editor.commit();
    const doc = this.editor.doc;
    try {
      const project = await buildProject(doc, this.editor.assets);
      const name = await this.storage.save(project, { suggestedName: this.projectName ?? defaultProjectName(), saveAs });
      if (!name) return;
      this.projectName = name;
      this.savedDoc = doc;
      this.refreshUI();
      this.toast(`${name} に保存しました`);
    } catch (err) {
      console.error(err);
      this.toast('保存に失敗しました');
    }
  }

  /** プロジェクトを開く。ask=true なら未保存の確認をする。開けたら true */
  private async loadProject(file?: File, ask = true): Promise<boolean> {
    if (ask && !this.confirmDiscard()) return false;
    try {
      const loaded = await this.storage.load(file);
      if (!loaded) return false;
      const { doc, missing } = await restoreProject(loaded.project, this.editor.assets);
      this.replaceDocument(doc, loaded.name);
      this.toast(`${loaded.name} を開きました${missing > 0 ? `（元画像がない ${missing} 件は除外）` : ''}`);
      return true;
    } catch (err) {
      console.error(err);
      this.toast(`プロジェクトを開けませんでした：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}

function defaultProjectName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `project-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 文字入力中のキー操作はショートカットとして扱わない */
function isTypingTarget(e: Event): boolean {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    const type = t.type;
    if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'color') return false;
    if (type === 'range') return e instanceof KeyboardEvent && e.key.startsWith('Arrow');
    return true;
  }
  return false;
}
