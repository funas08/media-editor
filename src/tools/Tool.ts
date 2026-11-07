// ツールのインターフェース。
// 各ツールは「キャンバスでの操作」と「設定欄のUI」をセットで持つ。
// registerTool で登録するだけで、左パネルのボタンと設定欄が増える。

import type { Editor } from '../core/Editor';
import type { DocState, Point } from '../core/types';
import type { View } from '../render/view';

/** ツールから見たアプリ（UI・表示）の機能 */
export interface ToolHost {
  readonly editor: Editor;
  readonly view: View;
  /** 再描画を予約 */
  requestRender(): void;
  /** 設定欄・ステータスバーなどを最新の状態に更新 */
  refreshUI(): void;
  /** 全体表示 */
  fitView(): void;
  setTool(id: string): void;
  toast(message: string): void;
  /** ツールが一時的にカーソルを変えたいとき（null で既定に戻す） */
  setCursor(cursor: string | null): void;
}

export interface ToolPointerEvent {
  /** キャンバス座標 */
  doc: Point;
  /** 表示領域内の画面座標（CSS px） */
  screen: Point;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** 押されているボタン（PointerEvent.buttons） */
  buttons: number;
  original: PointerEvent;
}

export interface ToolSettings {
  el: HTMLElement;
  /** ドキュメント・選択が変わったときに呼ばれる */
  update?(): void;
  dispose?(): void;
}

export interface Tool {
  id: string;
  name: string;
  /** SVG 文字列 */
  icon: string;
  /** 切り替えキー（英大文字1文字） */
  shortcut: string;
  /** 左パネルでの並び順（小さいほど上） */
  order: number;
  /** キャンバス上の既定カーソル */
  cursor?: string;

  activate?(host: ToolHost): void;
  deactivate?(host: ToolHost): void;

  onPointerDown?(e: ToolPointerEvent, host: ToolHost): void;
  /** ボタンを押していないとき（ホバー）にも呼ばれる */
  onPointerMove?(e: ToolPointerEvent, host: ToolHost): void;
  onPointerUp?(e: ToolPointerEvent, host: ToolHost): void;
  onDoubleClick?(e: ToolPointerEvent, host: ToolHost): void;
  /** 処理した場合は true を返す（既定の動作を止める） */
  onKeyDown?(e: KeyboardEvent, host: ToolHost): boolean;
  onKeyUp?(e: KeyboardEvent, host: ToolHost): void;

  /** 画面座標でオーバーレイ（ハンドルなど）を描く */
  drawOverlay?(ctx: CanvasRenderingContext2D, host: ToolHost): void;
  /** 確定前の結果を表示したいとき、表示用のドキュメントを返す */
  getPreview?(doc: DocState, host: ToolHost): DocState | null;

  createSettings(host: ToolHost): ToolSettings;
}
