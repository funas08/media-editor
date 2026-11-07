// 素材の一覧（読み込んだ画像・動画・音楽）。タイムラインに置くかどうかとは別に、読み込んだものをここに集める。
// ドキュメント（履歴）には入れない。新しいドキュメントにしたときは、使っているものだけ残す。

import type { AssetStore } from '../core/AssetStore';
import { Emitter } from '../core/emitter';
import type { SourceInfo } from '../features/clips';
import { isImageFile } from '../io/files';
import { MediaLoadError, isAudioFile, isVideoFile, type MediaStore } from '../media/MediaStore';

export interface LibraryEntry extends SourceInfo {
  /** サムネイル（data URL）。音楽は null */
  thumb: string | null;
}

export class Library {
  readonly changed = new Emitter<void>();
  private assets: AssetStore;
  private media: MediaStore;
  private list: LibraryEntry[] = [];

  constructor(assets: AssetStore, media: MediaStore) {
    this.assets = assets;
    this.media = media;
  }

  entries(): readonly LibraryEntry[] {
    return this.list;
  }

  get(id: string): LibraryEntry | undefined {
    return this.list.find((e) => e.id === id);
  }

  /** ファイルを読み込んで素材にする（読めなかったものは onError に理由を渡す） */
  async importFiles(files: File[], onError: (message: string) => void): Promise<LibraryEntry[]> {
    const added: LibraryEntry[] = [];
    for (const f of files) {
      try {
        if (isVideoFile(f) || isAudioFile(f)) {
          const m = await this.media.add(f);
          const i = m.info;
          added.push(this.register({ kind: i.kind, id: i.id, name: i.name, width: i.width, height: i.height, duration: i.duration, thumb: await this.media.thumbnail(i.id).catch(() => null) }));
        } else if (isImageFile(f)) {
          const a = await this.assets.add(f, f.name || '画像');
          added.push(this.register({ kind: 'image', id: a.id, name: a.name, width: a.width, height: a.height, duration: 0, thumb: imageThumb(a.bitmap) }));
        } else {
          onError(`${f.name}：対応していないファイルです`);
        }
      } catch (e) {
        onError(`${f.name}：${e instanceof MediaLoadError ? e.message : '読み込めませんでした'}`);
      }
    }
    return added;
  }

  /** 読み込み済みの画像・動画を素材として登録する（すでにあれば何もしない） */
  register(e: LibraryEntry): LibraryEntry {
    const existing = this.get(e.id);
    if (existing) return existing;
    this.list.push(e);
    this.changed.emit();
    return e;
  }

  /** 画像（AssetStore にあるもの）を素材として登録する */
  registerImage(id: string): void {
    const a = this.assets.get(id);
    if (!a || this.get(id)) return;
    this.register({ kind: 'image', id: a.id, name: a.name, width: a.width, height: a.height, duration: 0, thumb: imageThumb(a.bitmap) });
  }

  /** 動画・音楽（MediaStore にあるもの）を素材として登録する */
  async registerMedia(id: string): Promise<void> {
    const m = this.media.get(id);
    if (!m || this.get(id)) return;
    const i = m.info;
    this.register({ kind: i.kind, id: i.id, name: i.name, width: i.width, height: i.height, duration: i.duration, thumb: await this.media.thumbnail(i.id).catch(() => null) });
  }

  remove(id: string): void {
    this.list = this.list.filter((e) => e.id !== id);
    this.changed.emit();
  }

  /** 指定した ID 以外を一覧から外す（新しいドキュメント） */
  retainOnly(ids: ReadonlySet<string>): void {
    this.list = this.list.filter((e) => ids.has(e.id));
    this.changed.emit();
  }
}

function imageThumb(bitmap: ImageBitmap, maxSide = 96): string {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * k));
  c.height = Math.max(1, Math.round(bitmap.height * k));
  c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
