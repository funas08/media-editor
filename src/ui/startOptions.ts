// 起動画面（新規作成）の選択肢の登録。
// registerStartOption で登録するだけで起動画面に並ぶ（将来、動画モードの「動画を編集」などを足せる）。

/** 起動画面から呼べるアプリの操作。開く系は「新しいドキュメントになったか」を返す（キャンセルなら false） */
export interface StartContext {
  /** 画像を開く：1枚目でキャンバスのサイズを決め、2枚目以降は追加の画像として置く */
  openImages(files: File[]): Promise<boolean>;
  /** 画像を選ぶダイアログを出して開く */
  pickImage(): Promise<boolean>;
  /** プロジェクト（.json）を開く。file がなければ選択ダイアログ */
  openProject(file?: File): Promise<boolean>;
  /** 白紙のキャンバスを作る */
  newBlank(opts: { width: number; height: number; background: string; transparent: boolean }): void;
  /** 起動画面を閉じる */
  close(): void;
}

export interface StartOption {
  id: string;
  title: string;
  description: string;
  /** SVG 文字列 */
  icon: string;
  /** 並び順（小さいほど先） */
  order: number;
  /**
   * 選んだときの動作。要素を返すと起動画面の中に設定パネルとして表示する（「白紙から作成」のサイズ選択など）。
   * Promise を返した場合は、結果が false（キャンセル）でなければ起動画面を閉じる
   */
  activate(ctx: StartContext): HTMLElement | Promise<boolean>;
}

const options: StartOption[] = [];

export function registerStartOption(opt: StartOption): void {
  if (options.some((o) => o.id === opt.id)) throw new Error(`起動画面の選択肢 ${opt.id} は登録済みです`);
  options.push(opt);
  options.sort((a, b) => a.order - b.order);
}

export function getStartOptions(): readonly StartOption[] {
  return options;
}
