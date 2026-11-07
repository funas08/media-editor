// モーダルダイアログ（<dialog> 要素を使用。Esc・背景クリックで閉じる）

import { h } from './controls';

export interface DialogHandle {
  el: HTMLDialogElement;
  close(): void;
}

export function openDialog(opts: {
  title: string;
  body: HTMLElement;
  actions?: HTMLElement[];
  wide?: boolean;
  onClose?: () => void;
  /** false を返す間は閉じない（書き出し中など） */
  canClose?: () => boolean;
}): DialogHandle {
  const closeBtn = h('button', { class: 'icon-btn dialog-close', type: 'button', 'aria-label': '閉じる', html: '&times;' });
  const dlg = h(
    'dialog',
    { class: opts.wide ? 'dialog wide' : 'dialog' },
    h('header', { class: 'dialog-header' }, h('h2', {}, opts.title), closeBtn),
    h('div', { class: 'dialog-body' }, opts.body),
    opts.actions?.length ? h('footer', { class: 'dialog-actions' }, ...opts.actions) : null,
  ) as HTMLDialogElement;
  const close = () => {
    if (opts.canClose && !opts.canClose()) return;
    if (dlg.open) dlg.close();
  };
  closeBtn.addEventListener('click', close);
  // 背景（ダイアログの外側）のクリックで閉じる
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  // Esc で閉じるときも canClose を確認する
  dlg.addEventListener('cancel', (e) => {
    if (opts.canClose && !opts.canClose()) e.preventDefault();
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    opts.onClose?.();
  });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close };
}

export function isDialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}
