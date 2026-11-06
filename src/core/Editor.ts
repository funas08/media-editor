// エディタ本体：ドキュメント状態（DocState）を一元管理し、変更を履歴に残す。
//
// 変更の方法は2通り：
//   1) editor.update(label, fn)         … 1回の変更 = 履歴1件
//   2) editor.begin(label) → preview(fn) を何度でも → commit() / cancel()
//      ドラッグ操作などはこちら。何回 preview しても履歴は1件にまとまる
//
// DocState は外から直接書き換えないこと（必ず update / preview の fn の中で変更する）。

import { AssetStore } from './AssetStore';
import { cloneDoc, createDoc } from './doc';
import { Emitter } from './emitter';
import type { DocState } from './types';

interface HistoryEntry {
  label: string;
  doc: DocState;
  selection: string[];
}

export interface ChangeEvent {
  /** ドキュメントが変わった */
  doc: boolean;
  /** 選択が変わった */
  selection: boolean;
  /** 履歴（Undo/Redo できるか）が変わった */
  history: boolean;
}

const HISTORY_LIMIT = 200;

export class Editor {
  readonly assets = new AssetStore();
  readonly changed = new Emitter<ChangeEvent>();

  private _doc: DocState;
  private _selection: string[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private txn: { label: string; before: DocState; selection: string[] } | null = null;

  constructor(doc: DocState = createDoc()) {
    this._doc = doc;
  }

  get doc(): DocState {
    return this._doc;
  }

  get selection(): readonly string[] {
    return this._selection;
  }

  get inTransaction(): boolean {
    return this.txn !== null;
  }

  // ---- 変更 ----

  /** 1回分の変更を適用して履歴に残す */
  update(label: string, fn: (draft: DocState) => void): void {
    if (this.txn) {
      // トランザクション中ならその一部として扱う
      fn(this._doc);
      this.afterDocChange(false);
      return;
    }
    const before = this._doc;
    const next = cloneDoc(before);
    fn(next);
    if (sameDoc(before, next)) return;
    this.pushUndo({ label, doc: before, selection: [...this._selection] });
    this._doc = next;
    this.afterDocChange(true);
  }

  /** まとめて1件にする変更を開始（ドラッグ開始時など） */
  begin(label: string): void {
    if (this.txn) this.commit();
    this.txn = { label, before: this._doc, selection: [...this._selection] };
    this._doc = cloneDoc(this._doc);
  }

  /** トランザクション中の途中経過を反映（履歴は増えない） */
  preview(fn: (draft: DocState) => void): void {
    if (!this.txn) this.begin('変更');
    fn(this._doc);
    this.afterDocChange(false);
  }

  /** トランザクションを確定（変化がなければ履歴に残さない） */
  commit(): void {
    const t = this.txn;
    if (!t) return;
    this.txn = null;
    if (sameDoc(t.before, this._doc)) {
      this._doc = t.before;
      return;
    }
    this.pushUndo({ label: t.label, doc: t.before, selection: t.selection });
    this.emit({ doc: false, selection: false, history: true });
  }

  /** トランザクションを取り消して開始前に戻す */
  cancel(): void {
    const t = this.txn;
    if (!t) return;
    this.txn = null;
    this._doc = t.before;
    this.afterDocChange(false);
  }

  // ---- 選択 ----

  setSelection(ids: readonly string[]): void {
    const valid = ids.filter((id, i) => ids.indexOf(id) === i && this._doc.items.some((it) => it.id === id));
    if (valid.length === this._selection.length && valid.every((id, i) => id === this._selection[i])) return;
    this._selection = valid;
    this.emit({ doc: false, selection: true, history: false });
  }

  isSelected(id: string): boolean {
    return this._selection.includes(id);
  }

  // ---- 履歴 ----

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.txn !== null;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  undo(): void {
    if (this.txn) this.commit();
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ label: e.label, doc: this._doc, selection: [...this._selection] });
    this.restore(e);
  }

  redo(): void {
    if (this.txn) this.commit();
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ label: e.label, doc: this._doc, selection: [...this._selection] });
    this.restore(e);
  }

  /** ドキュメントを丸ごと差し替える（プロジェクト読み込みなど）。履歴はリセット */
  reset(doc: DocState): void {
    this.txn = null;
    this._doc = doc;
    this._selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ doc: true, selection: true, history: true });
  }

  // ---- 内部 ----

  private restore(e: HistoryEntry): void {
    this._doc = e.doc;
    this._selection = e.selection.filter((id) => e.doc.items.some((it) => it.id === id));
    this.emit({ doc: true, selection: true, history: true });
  }

  private pushUndo(e: HistoryEntry): void {
    this.undoStack.push(e);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private afterDocChange(history: boolean): void {
    // 消えたアイテムを選択から外す
    const before = this._selection.length;
    this._selection = this._selection.filter((id) => this._doc.items.some((it) => it.id === id));
    this.emit({ doc: true, selection: before !== this._selection.length, history });
  }

  private emit(e: ChangeEvent): void {
    this.changed.emit(e);
  }
}

function sameDoc(a: DocState, b: DocState): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
