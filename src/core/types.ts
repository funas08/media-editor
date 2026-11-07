// ドキュメントの状態を表す型定義（描画やUIには依存しない純粋なデータ）

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 色調補正パラメータ（非破壊。描画時にだけ適用する） */
export interface Adjust {
  /** 明るさ（%）100 = そのまま */
  brightness: number;
  /** コントラスト（%）100 = そのまま */
  contrast: number;
  /** 彩度（%）100 = そのまま */
  saturate: number;
  /** 色相（度）0 = そのまま */
  hue: number;
  /** グレースケール（%）0 = そのまま */
  grayscale: number;
  /** ぼかし（ドキュメント上の px）0 = なし */
  blur: number;
}

/** 切り抜きの形 */
export type CropShapeKind = 'rect' | 'roundRect' | 'ellipse';

export interface CropShape {
  kind: CropShapeKind;
  /** 角丸の半径（表示上の短い辺に対する割合 0〜0.5）。roundRect のときだけ使う */
  radius: number;
}

/** メイン動画トラックの ID */
export const MAIN_TRACK = 'main';

/**
 * タイムライン上の配置（動画モード）。これがないアイテムは時刻に関係なく常に表示する（画像モードの作品）
 */
export interface ClipTiming {
  /** 置いているトラック：MAIN_TRACK またはオーバーレイトラックの ID */
  track: string;
  /** 開始時刻（秒）。オーバーレイのみ。メインは並び順で決まるので使わない */
  start: number;
  /** 表示時間（秒）。画像のみ。動画は使う範囲と再生速度で決まる */
  duration: number;
  /** 不透明度（0〜1） */
  opacity: number;
  /** フェードイン・フェードアウトの秒数 */
  fadeIn: number;
  fadeOut: number;
}

/** オーバーレイトラック（画像・動画を好きな時刻に置ける） */
export interface OverlayTrack {
  id: string;
  visible: boolean;
  locked: boolean;
}

/** 音楽クリップ（音楽トラック） */
export interface MusicClip {
  id: string;
  mediaId: string;
  name: string;
  /** タイムライン上の開始時刻（秒） */
  start: number;
  /** 元の音声で使う範囲（秒） */
  inPoint: number;
  outPoint: number;
  /** 元の音声の長さ（秒） */
  srcDuration: number;
  volume: number;
}

export interface TimelineState {
  /** オーバーレイトラック（先頭が一番上＝手前） */
  overlays: OverlayTrack[];
  music: MusicClip[];
}

/** すべてのアイテムに共通の属性 */
export interface ItemBase {
  id: string;
  type: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 中心のX座標（キャンバス座標） */
  cx: number;
  /** 中心のY座標（キャンバス座標） */
  cy: number;
  /** 回転（度、時計回り） */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  /** タイムライン上の配置（動画モード）。なければ常に表示 */
  clip?: ClipTiming;
}

/** 画像・動画に共通の属性（変形・切り抜き・色調補正。画像モードのツールをそのまま使えるようにする） */
export interface MediaItemBase extends ItemBase {
  /** 元の画像・動画のサイズ（表示上のピクセル数） */
  srcWidth: number;
  srcHeight: number;
  /** 実際に描画する元画像上の範囲 */
  crop: Rect;
  /**
   * ユーザーがトリミングツールで指定した範囲（null = 指定なし = 全体）。
   * 「並べる」の「埋める」は crop をこの範囲の中から自動で決めるので、ユーザーの指定と区別して持つ
   */
  userCrop: Rect | null;
  /** 切り抜きの形（crop の矩形に内接する形でクリップする） */
  cropShape: CropShape;
  /** 拡大率（crop の 1px がキャンバス上で何 px になるか） */
  scaleX: number;
  scaleY: number;
  adjust: Adjust;
}

/** 画像アイテム。元画像は AssetStore にあり、ここでは参照とパラメータだけを持つ */
export interface ImageItem extends MediaItemBase {
  type: 'image';
  assetId: string;
}

/**
 * 動画クリップ。元動画は MediaStore（ブラウザの中のファイル参照）にあり、ここでは参照と使う範囲だけを持つ。
 * 動画トラックの並び順は items の中での動画クリップの並び順で、先頭から隙間なく順に再生する
 */
export interface VideoItem extends MediaItemBase {
  type: 'video';
  mediaId: string;
  /** 元動画の長さ（秒）。トリムで広げられる上限 */
  srcDuration: number;
  /** 元動画で使う範囲の開始（秒） */
  inPoint: number;
  /** 元動画で使う範囲の終了（秒） */
  outPoint: number;
  /** 再生速度（1 = 等速） */
  speed: number;
  /** 元の音声の音量（1 = そのまま） */
  volume: number;
  /** 元の音声をミュート */
  muted: boolean;
}

/** アイテムの種類を増やすときはここにユニオンで追加する */
export type Item = ImageItem | VideoItem;
export type MediaItem = ImageItem | VideoItem;
export type ItemType = Item['type'];

export interface CanvasSettings {
  width: number;
  height: number;
  /** 背景色（#rrggbb） */
  background: string;
  /** true のとき背景は透明 */
  transparent: boolean;
  /** キャンバスの形（角丸・楕円のときは形の外側が透明になる） */
  shape: CropShape;
}

export interface DocState {
  version: 1;
  canvas: CanvasSettings;
  /** 配列の先頭が一番下のレイヤー（動画モードで clip を持つアイテムはトラックの順で描く） */
  items: Item[];
  /** 動画モードのタイムライン */
  timeline: TimelineState;
}
