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
}

/** 画像アイテム。元画像は AssetStore にあり、ここでは参照とパラメータだけを持つ */
export interface ImageItem extends ItemBase {
  type: 'image';
  assetId: string;
  /** 元画像のサイズ（AssetStore を見なくても計算できるように保持） */
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

/** アイテムの種類を増やすときはここにユニオンで追加する */
export type Item = ImageItem;
export type ItemType = Item['type'];

export interface CanvasSettings {
  width: number;
  height: number;
  /** 背景色（#rrggbb） */
  background: string;
  /** true のとき背景は透明 */
  transparent: boolean;
}

export interface DocState {
  version: 1;
  canvas: CanvasSettings;
  /** 配列の先頭が一番下のレイヤー */
  items: Item[];
}
