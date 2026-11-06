// ドキュメント・アイテムの生成と小さなユーティリティ

import type { Adjust, DocState, ImageItem, Item, Rect } from './types';

export const DEFAULT_ADJUST: Readonly<Adjust> = {
  brightness: 100,
  contrast: 100,
  saturate: 100,
  hue: 0,
  grayscale: 0,
  blur: 0,
};

export function newId(prefix = 'it'): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createDoc(width = 2560, height = 1440): DocState {
  return {
    version: 1,
    canvas: { width, height, background: '#ffffff', transparent: false },
    items: [],
  };
}

export interface ImageSource {
  id: string;
  name: string;
  width: number;
  height: number;
}

export function createImageItem(src: ImageSource, cx: number, cy: number, scale = 1): ImageItem {
  return {
    id: newId('img'),
    type: 'image',
    name: src.name,
    visible: true,
    locked: false,
    cx,
    cy,
    rotation: 0,
    flipX: false,
    flipY: false,
    assetId: src.id,
    srcWidth: src.width,
    srcHeight: src.height,
    crop: { x: 0, y: 0, w: src.width, h: src.height },
    userCrop: null,
    scaleX: scale,
    scaleY: scale,
    adjust: { ...DEFAULT_ADJUST },
  };
}

export function cloneDoc(doc: DocState): DocState {
  return structuredClone(doc);
}

export function findItem(doc: DocState, id: string): Item | undefined {
  return doc.items.find((it) => it.id === id);
}

/** 画像の「ユーザー指定の範囲」（なければ元画像全体） */
export function baseCrop(it: ImageItem): Rect {
  return it.userCrop ? { ...it.userCrop } : { x: 0, y: 0, w: it.srcWidth, h: it.srcHeight };
}

export function isImage(it: Item): it is ImageItem {
  return it.type === 'image';
}
