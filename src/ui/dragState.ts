// アプリ内のドラッグ&ドロップで運んでいるもの（素材パネルからのドラッグ）。
// dragover の間は dataTransfer の中身を読めないため、ここに置いて参照する。

import type { LibraryEntry } from './Library';

export const LIBRARY_DRAG_TYPE = 'application/x-image-editor-source';

let current: LibraryEntry[] | null = null;

export function setLibraryDrag(entries: LibraryEntry[] | null): void {
  current = entries;
}

/** 素材パネルからドラッグ中の素材（なければ null） */
export function getLibraryDrag(e: DragEvent): LibraryEntry[] | null {
  return e.dataTransfer?.types.includes(LIBRARY_DRAG_TYPE) ? current : null;
}

/** ドラッグにファイルが含まれているか */
export function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes('Files') ?? false;
}
