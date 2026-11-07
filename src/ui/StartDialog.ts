// 起動画面（新規作成）：登録された選択肢を並べる。画像・プロジェクトのドロップにも対応

import { isImageFile } from '../io/files';
import { isVideoFile } from '../media/MediaStore';
import { PROJECT_EXT } from '../io/project';
import { button, h } from './controls';
import { openDialog } from './Dialog';
import { getStartOptions, type StartContext } from './startOptions';
import './startOptionsBuiltin';

/** 起動画面を開く（ctx の close は、このダイアログを閉じる処理に差し替える） */
export function openStartDialog(ctx: Omit<StartContext, 'close'>): void {
  const body = h('div', { class: 'start' });
  const dlg = openDialog({ title: '新規作成', body, wide: true });
  const full: StartContext = { ...ctx, close: () => dlg.close() };

  /** 開く処理の結果を待ち、新しいドキュメントになったら閉じる（ファイル選択のキャンセルなら開いたまま） */
  const finish = async (p: Promise<boolean>) => {
    if (await p) dlg.close();
  };

  const showList = () => {
    const cards = getStartOptions().map((opt) =>
      h(
        'button',
        {
          class: 'start-card',
          type: 'button',
          onclick: () => {
            const result = opt.activate(full);
            if (result instanceof HTMLElement) showPanel(opt.title, result);
            else void finish(result);
          },
        },
        h('span', { class: 'start-icon', html: opt.icon }),
        h('span', { class: 'start-title' }, opt.title),
        h('span', { class: 'start-desc' }, opt.description),
      ),
    );
    body.replaceChildren(
      h('div', { class: 'start-cards' }, ...cards),
      h('p', { class: 'hint start-drop' }, '画像（複数可）・動画・プロジェクト（.json）をこの画面にドロップしても開けます。閉じると今のキャンバスのまま続けます'),
    );
  };

  const showPanel = (title: string, panel: HTMLElement) => {
    body.replaceChildren(h('div', { class: 'start-panel-head' }, button('← 戻る', showList), h('strong', {}, title)), panel);
  };

  // ドロップ：.json ならプロジェクト、画像なら「画像を開く」
  dlg.el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dlg.el.classList.add('drag-over');
  });
  dlg.el.addEventListener('dragleave', (e) => {
    if (e.target === dlg.el) dlg.el.classList.remove('drag-over');
  });
  dlg.el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dlg.el.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files ?? [])];
    const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXT));
    if (project) void finish(ctx.openProject(project));
    else if (files.some(isVideoFile)) void finish(ctx.openVideos(files));
    else if (files.some(isImageFile)) void finish(ctx.openImages(files));
  });

  showList();
}
