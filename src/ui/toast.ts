// 画面下に短いメッセージを出す

import { h } from './controls';

export class Toaster {
  readonly el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });

  show(message: string, ms = 2600): void {
    const t = h('div', { class: 'toast' }, message);
    this.el.append(t);
    // 多すぎる場合は古いものから消す
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    setTimeout(() => {
      t.classList.add('hide');
      setTimeout(() => t.remove(), 300);
    }, ms);
  }
}
