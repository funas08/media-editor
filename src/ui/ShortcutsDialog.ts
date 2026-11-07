// ショートカット一覧（? キー）

import { getTools } from '../tools/registry';
import { h } from './controls';
import { openDialog } from './Dialog';

type Entry = [keys: string, desc: string];

const SECTIONS: { title: string; entries: Entry[] }[] = [
  {
    title: 'ファイル',
    entries: [
      ['Alt+N / Ctrl+N', '新規作成（Ctrl+N はアプリとしてインストールした場合など）'],
      ['Ctrl+O', '開く（画像を開く／プロジェクト）'],
      ['Ctrl+S', 'プロジェクトを保存'],
      ['Ctrl+Shift+S', '名前を付けて保存'],
      ['Ctrl+Shift+E', '書き出し'],
      ['Ctrl+V', '画像を貼り付けて追加'],
    ],
  },
  {
    title: '編集',
    entries: [
      ['Ctrl+Z', '元に戻す'],
      ['Ctrl+Shift+Z / Ctrl+Y', 'やり直し'],
      ['Ctrl+A', 'すべて選択'],
      ['Esc', '選択解除（トリミング中は確定）'],
      ['Delete', '削除'],
      ['Ctrl+D', '複製'],
      ['Ctrl+] / Ctrl+[', '前面へ／背面へ（Shift で最前面／最背面）'],
      ['矢印 / Shift+矢印', '1px / 10px 移動（選択・移動ツール）'],
      ['Enter', '確定（トリミング・並べる）'],
    ],
  },
  {
    title: '表示',
    entries: [
      ['ホイール', 'ズーム（カーソル位置を基準）'],
      ['Space+ドラッグ / 中ボタンドラッグ', '表示位置を移動'],
      ['Ctrl+0', '全体表示'],
      ['Ctrl+1', '100% 表示'],
      ['Ctrl++ / Ctrl+-', '拡大／縮小'],
    ],
  },
  {
    title: 'ドラッグ中の修飾キー',
    entries: [
      ['Shift（移動）', '水平・垂直に固定'],
      ['Alt（移動）', 'スナップを一時的に無効'],
      ['Shift（サイズ変更の角）', '縦横比の固定を解除'],
      ['Shift（回転）', '15° 刻み'],
    ],
  },
];

function table(entries: Entry[]): HTMLElement {
  return h(
    'table',
    { class: 'shortcut-table' },
    h('tbody', {}, ...entries.map(([k, d]) => h('tr', {}, h('td', {}, ...k.split(' / ').flatMap((x, i) => [i > 0 ? ' / ' : '', h('kbd', {}, x)])), h('td', {}, d)))),
  );
}

export function openShortcutsDialog(): void {
  const tools: Entry[] = getTools().map((t) => [t.shortcut, t.name]);
  const body = h(
    'div',
    { class: 'shortcut-grid' },
    h('section', {}, h('h3', {}, 'ツール'), table(tools)),
    ...SECTIONS.map((s) => h('section', {}, h('h3', {}, s.title), table(s.entries))),
  );
  openDialog({ title: 'ショートカット一覧', body, wide: true });
}
