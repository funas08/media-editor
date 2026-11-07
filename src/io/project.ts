// プロジェクトファイル（.json）：ドキュメントの状態と元画像を1つのファイルにまとめる。
// 元画像は data URL（base64）として埋め込む。ファイルはブラウザの中だけで作り・読み、外部には送らない。

import type { Asset, AssetStore } from '../core/AssetStore';
import type { DocState } from '../core/types';

export const PROJECT_APP = 'image-editor';
export const PROJECT_VERSION = 1;
export const PROJECT_EXT = '.json';

export interface ProjectAsset {
  id: string;
  name: string;
  /** data:image/...;base64,... */
  dataUrl: string;
}

export interface ProjectFile {
  app: typeof PROJECT_APP;
  version: number;
  savedAt: string;
  doc: DocState;
  assets: ProjectAsset[];
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('画像の変換に失敗しました'));
    r.readAsDataURL(blob);
  });
}

/** 保存用のデータを作る（使われている元画像だけを含める） */
export async function buildProject(doc: DocState, store: AssetStore): Promise<ProjectFile> {
  const used = new Set(doc.items.filter((it) => it.type === 'image').map((it) => it.assetId));
  const assets: ProjectAsset[] = [];
  for (const id of used) {
    const a = store.get(id);
    if (!a) continue;
    assets.push({ id: a.id, name: a.name, dataUrl: await blobToDataUrl(a.blob) });
  }
  return { app: PROJECT_APP, version: PROJECT_VERSION, savedAt: new Date().toISOString(), doc, assets };
}

/** JSON 文字列を読み、形式を確認する（問題があれば日本語のメッセージで例外） */
export function parseProject(text: string): ProjectFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON として読めません');
  }
  const p = data as Partial<ProjectFile> | null;
  if (!p || p.app !== PROJECT_APP) throw new Error('このアプリのプロジェクトファイルではありません');
  if (typeof p.version !== 'number' || p.version > PROJECT_VERSION) throw new Error('新しいバージョンで保存されたファイルのため読み込めません');
  const doc = p.doc;
  if (!doc || !doc.canvas || !Array.isArray(doc.items) || !(doc.canvas.width > 0) || !(doc.canvas.height > 0)) {
    throw new Error('プロジェクトの内容が壊れています');
  }
  if (!Array.isArray(p.assets)) throw new Error('画像データが見つかりません');
  return p as ProjectFile;
}

/**
 * 元画像をすべて読み込んでから AssetStore を入れ替える（途中で失敗しても今の状態を壊さない）。
 * 元画像が見つからないアイテムは取り除き、その数を返す
 */
export async function restoreProject(p: ProjectFile, store: AssetStore): Promise<{ doc: DocState; missing: number }> {
  const loaded: Asset[] = [];
  for (const a of p.assets) {
    if (!a.dataUrl.startsWith('data:image/')) continue;
    const blob = await (await fetch(a.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    loaded.push({ id: a.id, name: a.name, width: bitmap.width, height: bitmap.height, bitmap, blob });
  }
  const ids = new Set(loaded.map((a) => a.id));
  const doc = structuredClone(p.doc);
  const before = doc.items.length;
  doc.items = doc.items.filter((it) => it.type !== 'image' || ids.has(it.assetId));
  store.clear();
  for (const a of loaded) store.put(a);
  return { doc, missing: before - doc.items.length };
}
