// ドキュメント・アイテムの生成と小さなユーティリティ

import { MAIN_TRACK, type Adjust, type ClipTiming, type CropShape, type DocState, type ImageItem, type Item, type MediaItem, type MediaItemBase, type Rect, type VideoItem } from './types';

export const DEFAULT_ADJUST: Readonly<Adjust> = {
  brightness: 100,
  contrast: 100,
  saturate: 100,
  hue: 0,
  grayscale: 0,
  blur: 0,
};

export const DEFAULT_CROP_SHAPE: Readonly<CropShape> = { kind: 'rect', radius: 0.12 };

export function newId(prefix = 'it'): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createDoc(width = 2560, height = 1440): DocState {
  return {
    version: 1,
    canvas: { width, height, background: '#ffffff', transparent: false, shape: { ...DEFAULT_CROP_SHAPE } },
    items: [],
    timeline: { overlays: [], music: [] },
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
    cropShape: { ...DEFAULT_CROP_SHAPE },
    scaleX: scale,
    scaleY: scale,
    adjust: { ...DEFAULT_ADJUST },
  };
}

/**
 * 古い形式のドキュメントを今の形式にそろえる（プロジェクト読み込み時）。
 * - cropShape がない画像、shape がないキャンバスは四角形として扱う
 */
export function normalizeDoc(doc: DocState): DocState {
  // タイムラインがない（V1 以前）・動画クリップに配置がない → メイントラック
  if (!doc.timeline) doc.timeline = { overlays: [], music: [] };
  doc.timeline.overlays ??= [];
  doc.timeline.music ??= [];
  for (const it of doc.items) {
    if (it.type === 'video') {
      it.srcDuration ??= it.outPoint;
      it.clip ??= newClipTiming(MAIN_TRACK, 0, it.outPoint - it.inPoint);
    }
  }
  const cs = (doc.canvas as Partial<DocState['canvas']>).shape;
  if (!cs || !['rect', 'roundRect', 'ellipse'].includes(cs.kind)) doc.canvas.shape = { ...DEFAULT_CROP_SHAPE };
  else if (typeof cs.radius !== 'number') cs.radius = DEFAULT_CROP_SHAPE.radius;
  for (const it of doc.items) {
    if (it.type !== 'image' && it.type !== 'video') continue;
    const shape = (it as Partial<MediaItemBase>).cropShape;
    if (!shape || !['rect', 'roundRect', 'ellipse'].includes(shape.kind)) it.cropShape = { ...DEFAULT_CROP_SHAPE };
    else if (typeof shape.radius !== 'number') shape.radius = DEFAULT_CROP_SHAPE.radius;
  }
  return doc;
}

export function cloneDoc(doc: DocState): DocState {
  return structuredClone(doc);
}

export function findItem(doc: DocState, id: string): Item | undefined {
  return doc.items.find((it) => it.id === id);
}

export interface VideoSource {
  id: string;
  name: string;
  width: number;
  height: number;
  duration: number;
}

/** 動画クリップを作る（元動画全体を使い、指定の中心・拡大率で置く） */
export function createVideoItem(src: VideoSource, cx: number, cy: number, scale = 1): VideoItem {
  return {
    id: newId('vid'),
    type: 'video',
    name: src.name,
    visible: true,
    locked: false,
    cx,
    cy,
    rotation: 0,
    flipX: false,
    flipY: false,
    mediaId: src.id,
    srcDuration: src.duration,
    srcWidth: src.width,
    srcHeight: src.height,
    crop: { x: 0, y: 0, w: src.width, h: src.height },
    userCrop: null,
    cropShape: { ...DEFAULT_CROP_SHAPE },
    scaleX: scale,
    scaleY: scale,
    adjust: { ...DEFAULT_ADJUST },
    inPoint: 0,
    outPoint: src.duration,
    speed: 1,
    volume: 1,
    muted: false,
    clip: newClipTiming(MAIN_TRACK, 0, src.duration),
  };
}

/** タイムライン上の配置の初期値 */
export function newClipTiming(track: string, start: number, duration: number): ClipTiming {
  return { track, start, duration, opacity: 1, fadeIn: 0, fadeOut: 0 };
}

/** 静止画クリップの既定の長さ（秒） */
export const DEFAULT_STILL_DURATION = 5;

/** 画像の「ユーザー指定の範囲」（なければ元画像全体） */
export function baseCrop(it: MediaItem): Rect {
  return it.userCrop ? { ...it.userCrop } : { x: 0, y: 0, w: it.srcWidth, h: it.srcHeight };
}

export function isImage(it: Item): it is ImageItem {
  return it.type === 'image';
}

export function isVideo(it: Item): it is VideoItem {
  return it.type === 'video';
}

/** 画像・動画（変形・色調補正の対象） */
export function isMedia(it: Item): it is MediaItem {
  return it.type === 'image' || it.type === 'video';
}
