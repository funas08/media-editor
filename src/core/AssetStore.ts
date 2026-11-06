// 元画像の保管庫。アイテムは assetId で参照するだけで、画像データは持たない。
// 履歴（Undo）で消えたアイテムが復活できるよう、セッション中は原則として削除しない。

import { newId } from './doc';

export interface Asset {
  id: string;
  name: string;
  width: number;
  height: number;
  bitmap: ImageBitmap;
  /** 元のファイルデータ（プロジェクト保存用） */
  blob: Blob;
}

export class AssetStore {
  private assets = new Map<string, Asset>();

  /** Blob を読み込んで登録する。読めない形式なら例外 */
  async add(blob: Blob, name: string, id: string = newId('asset')): Promise<Asset> {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const asset: Asset = { id, name, width: bitmap.width, height: bitmap.height, bitmap, blob };
    this.assets.set(id, asset);
    return asset;
  }

  get(id: string): Asset | undefined {
    return this.assets.get(id);
  }

  all(): Asset[] {
    return [...this.assets.values()];
  }

  clear(): void {
    for (const a of this.assets.values()) a.bitmap.close();
    this.assets.clear();
  }
}
