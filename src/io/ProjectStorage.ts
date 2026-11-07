// プロジェクトの保存先を抽象化するインターフェース。
// 今はローカルファイル（.json）だけだが、将来 IndexedDB などに差し替えられるようにしておく。

import { downloadBlob, pickFiles } from './files';
import { PROJECT_EXT, parseProject, type ProjectFile } from './project';

export interface ProjectStorage {
  /**
   * 保存する。saveAs=false なら前回と同じ保存先に上書き（できる場合）。
   * @returns 保存したファイル名。キャンセルされたら null
   */
  save(project: ProjectFile, opts: { suggestedName: string; saveAs: boolean }): Promise<string | null>;
  /** 読み込む。file を渡せばそれを、なければ選択ダイアログを出す。キャンセルなら null */
  load(file?: File): Promise<{ project: ProjectFile; name: string } | null>;
  /** 新しいドキュメントにしたときなど、上書き先を忘れる */
  forget(): void;
}

// File System Access API（Chrome / Edge）の最小限の型
interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileHandleLike {
  name: string;
  createWritable(): Promise<WritableLike>;
}
type SaveFilePicker = (opts: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileHandleLike>;

/** ローカルの .json ファイルに保存する実装 */
export class LocalFileProjectStorage implements ProjectStorage {
  private handle: FileHandleLike | null = null;

  async save(project: ProjectFile, opts: { suggestedName: string; saveAs: boolean }): Promise<string | null> {
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
    const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    if (!picker) {
      // 保存先を選べないブラウザではダウンロードとして保存
      const name = withExt(opts.suggestedName);
      downloadBlob(blob, name);
      return name;
    }
    if (!this.handle || opts.saveAs) {
      try {
        this.handle = await picker({
          suggestedName: withExt(opts.suggestedName),
          types: [{ description: '画像エディタのプロジェクト', accept: { 'application/json': [PROJECT_EXT] } }],
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return null;
        throw e;
      }
    }
    const w = await this.handle.createWritable();
    await w.write(blob);
    await w.close();
    return this.handle.name;
  }

  async load(file?: File): Promise<{ project: ProjectFile; name: string } | null> {
    const f = file ?? (await pickFiles(`${PROJECT_EXT},application/json`, false))[0];
    if (!f) return null;
    const project = parseProject(await f.text());
    // 読み込んだファイルには直接上書きできない（ブラウザの制限）ので、次回の保存では保存先を選んでもらう
    this.handle = null;
    return { project, name: f.name };
  }

  forget(): void {
    this.handle = null;
  }
}

function withExt(name: string): string {
  return name.toLowerCase().endsWith(PROJECT_EXT) ? name : `${name}${PROJECT_EXT}`;
}
