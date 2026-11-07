// よく使う編集コマンド（すべて Editor 経由で履歴に残す）

import type { Asset } from '../core/AssetStore';
import { createImageItem, newId } from '../core/doc';
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

/** 選択中のアイテムを複製し、元の直上に置いて選択する */
export function duplicateSelected(editor: Editor): void {
  const sel = editor.selection;
  if (sel.length === 0) return;
  const newIds: string[] = [];
  editor.update('複製', (d) => {
    const out: Item[] = [];
    for (const it of d.items) {
      out.push(it);
      if (!sel.includes(it.id)) continue;
      const copy = structuredClone(it);
      copy.id = newId(it.type);
      copy.name = copyName(it.name);
      copy.cx += 20;
      copy.cy += 20;
      copy.locked = false;
      copy.visible = true;
      out.push(copy);
      newIds.push(copy.id);
    }
    d.items = out;
  });
  editor.setSelection(newIds);
}

function copyName(name: string): string {
  const m = /^(.*?)(?:\.([a-z0-9]+))?$/i.exec(name);
  const base = m?.[1] ?? name;
  const ext = m?.[2] ? `.${m[2]}` : '';
  return `${base} のコピー${ext}`;
}

/** 選択中のレイヤーを1つ上（前面）／下（背面）、または最前面／最背面へ */
export function moveLayers(editor: Editor, dir: 'up' | 'down' | 'top' | 'bottom'): void {
  const sel = editor.selection;
  if (sel.length === 0) return;
  const label = { up: '前面へ', down: '背面へ', top: '最前面へ', bottom: '最背面へ' }[dir];
  editor.update(label, (d) => {
    const items = d.items;
    const isSel = (it: Item) => sel.includes(it.id);
    if (dir === 'top' || dir === 'bottom') {
      const picked = items.filter(isSel);
      const rest = items.filter((it) => !isSel(it));
      d.items = dir === 'top' ? [...rest, ...picked] : [...picked, ...rest];
      return;
    }
    if (dir === 'up') {
      for (let i = items.length - 2; i >= 0; i--) {
        if (isSel(items[i]) && !isSel(items[i + 1])) [items[i], items[i + 1]] = [items[i + 1], items[i]];
      }
    } else {
      for (let i = 1; i < items.length; i++) {
        if (isSel(items[i]) && !isSel(items[i - 1])) [items[i], items[i - 1]] = [items[i - 1], items[i]];
      }
    }
  });
}

export function setItemProps(editor: Editor, id: string, label: string, props: Partial<Pick<Item, 'visible' | 'locked' | 'name'>>): void {
  editor.update(label, (d) => {
    const it = d.items.find((x) => x.id === id);
    if (it) Object.assign(it, props);
  });
}

/** 操作対象：選択中で、表示中かつロックされていないアイテム */
export function editableSelection(editor: Editor): Item[] {
  return editor.doc.items.filter((it) => editor.selection.includes(it.id) && it.visible && !it.locked);
}
