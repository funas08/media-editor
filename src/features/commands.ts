// よく使う編集コマンド（すべて Editor 経由で履歴に残す）

import type { Asset } from '../core/AssetStore';
import { createImageItem } from '../core/doc';
import type { Editor } from '../core/Editor';
import { hitTest } from '../core/geometry';
import type { Item, Point } from '../core/types';

/** 画像を読み込む。失敗したファイル名も返す */
export async function loadAssets(editor: Editor, files: File[]): Promise<{ assets: Asset[]; failed: string[] }> {
  const assets: Asset[] = [];
  const failed: string[] = [];
  for (const f of files) {
    try {
      assets.push(await editor.assets.add(f, f.name || '画像'));
    } catch {
      failed.push(f.name || '（名前なし）');
    }
  }
  return { assets, failed };
}

/** 画像をキャンバスに追加する。大きすぎる画像はキャンバスに収まるよう縮小する */
export function addImageItems(editor: Editor, assets: Asset[]): void {
  if (assets.length === 0) return;
  const ids: string[] = [];
  editor.update(assets.length > 1 ? `画像を追加（${assets.length}枚）` : '画像を追加', (d) => {
    const { width: W, height: H } = d.canvas;
    assets.forEach((a, i) => {
      const scale = Math.min(1, W / a.width, H / a.height);
      // 重ならないよう少しずつずらす
      const off = (i % 10) * 40;
      const item = createImageItem(a, W / 2 + off, H / 2 + off, scale);
      d.items.push(item);
      ids.push(item.id);
    });
  });
  editor.setSelection(ids);
}

/** 画像を1枚開き、キャンバスをその画像のサイズにする（単体の画像編集用） */
export function openAsDocument(editor: Editor, asset: Asset): void {
  let id = '';
  editor.update('画像として開く', (d) => {
    d.canvas.width = asset.width;
    d.canvas.height = asset.height;
    const item = createImageItem(asset, asset.width / 2, asset.height / 2, 1);
    d.items = [item];
    id = item.id;
  });
  editor.setSelection([id]);
}

export function deleteSelected(editor: Editor): void {
  const sel = editor.selection.filter((id) => !editor.doc.items.find((it) => it.id === id)?.locked);
  if (sel.length === 0) return;
  editor.update('削除', (d) => {
    d.items = d.items.filter((it) => !sel.includes(it.id));
  });
}

export function selectAll(editor: Editor): void {
  editor.setSelection(editor.doc.items.filter((it) => it.visible && !it.locked).map((it) => it.id));
}

/** 指定位置にある一番上のアイテム（非表示・ロック中は除く） */
export function topItemAt(items: readonly Item[], p: Point, includeLocked = false): Item | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.visible || (!includeLocked && it.locked)) continue;
    if (hitTest(it, p)) return it;
  }
  return undefined;
}
