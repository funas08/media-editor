// ファイルの選択・ダウンロード・クリップボードなど、ブラウザとの入出力

/** ファイル選択ダイアログを開く。キャンセル時は空配列 */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export const IMAGE_ACCEPT = 'image/*';

export function isImageFile(f: File): boolean {
  return f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(f.name);
}

/** Blob をファイルとしてダウンロードさせる（ブラウザ内で完結。外部送信なし） */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 貼り付けイベントから画像ファイルを取り出す（名前がない場合は付ける） */
export function imagesFromClipboard(e: ClipboardEvent): File[] {
  const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile);
  const stamp = new Date().toTimeString().slice(0, 8).replaceAll(':', '');
  return files.map((f, i) => {
    // クリップボードの画像は「image.png」のような名前になるので分かりやすく付け直す
    const ext = f.type.split('/')[1] ?? 'png';
    return new File([f], `貼り付け-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}`, { type: f.type });
  });
}

/** ドラッグ&ドロップされたファイルを取り出す */
export function filesFromDrop(e: DragEvent): File[] {
  return [...(e.dataTransfer?.files ?? [])];
}
