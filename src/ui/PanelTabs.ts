// 左パネル下段のタブ（素材 / レイヤー）。見出しのクリックで切り替え、選択中のタブをもう一度押すと折りたたむ

import { h } from './controls';

const STORAGE_KEY = 'image-editor.bottomTab';

export interface TabDef {
  id: string;
  title: string;
  el: HTMLElement;
  /** 件数の表示（任意） */
  count?: () => number;
}

export class PanelTabs {
  readonly el: HTMLElement;
  private tabs: TabDef[];
  private buttons: HTMLButtonElement[] = [];
  private body: HTMLElement;
  private active: string;
  private collapsed = false;

  constructor(tabs: TabDef[]) {
    this.tabs = tabs;
    const saved = load();
    this.active = tabs.some((t) => t.id === saved.tab) ? saved.tab : tabs[0].id;
    this.collapsed = saved.collapsed;
    this.buttons = tabs.map((t) => {
      const b = h('button', { class: 'panel-tab', type: 'button', onclick: () => this.select(t.id) }) as HTMLButtonElement;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      return b;
    });
    this.body = h('div', { class: 'panel-tabs-body' });
    this.el = h('section', { class: 'panel-tabs' }, h('div', { class: 'panel-tab-bar', role: 'tablist' }, ...this.buttons), this.body);
    this.apply();
  }

  /** 件数などの表示を更新 */
  update(): void {
    this.tabs.forEach((t, i) => {
      const n = t.count?.();
      const label = n === undefined ? t.title : `${t.title} ${n}`;
      if (this.buttons[i].textContent !== label) this.buttons[i].textContent = label;
    });
  }

  private select(id: string): void {
    if (id === this.active) this.collapsed = !this.collapsed;
    else {
      this.active = id;
      this.collapsed = false;
    }
    this.apply();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tab: this.active, collapsed: this.collapsed }));
    } catch {
      // 保存できなくても動作には影響しない
    }
  }

  private apply(): void {
    const t = this.tabs.find((x) => x.id === this.active)!;
    this.body.replaceChildren(t.el);
    this.body.hidden = this.collapsed;
    this.tabs.forEach((x, i) => {
      this.buttons[i].classList.toggle('active', x.id === this.active);
      this.buttons[i].setAttribute('aria-selected', String(x.id === this.active));
    });
    this.el.classList.toggle('collapsed', this.collapsed);
    this.update();
  }
}

function load(): { tab: string; collapsed: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { tab?: string; collapsed?: boolean } | null;
    return { tab: v?.tab ?? 'layers', collapsed: !!v?.collapsed };
  } catch {
    return { tab: 'layers', collapsed: false };
  }
}
