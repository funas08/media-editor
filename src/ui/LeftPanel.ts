// 左パネル：上からツールボタン／選んだツールの設定欄／レイヤー一覧

import { getTools } from '../tools/registry';
import type { Tool, ToolHost, ToolSettings } from '../tools/Tool';
import { h } from './controls';

export class LeftPanel {
  readonly el: HTMLElement;
  private toolList: HTMLElement;
  private settingsTitle: HTMLElement;
  private settingsBody: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private settings: ToolSettings | null = null;
  /** レイヤー一覧などを差し込む場所 */
  readonly bottom: HTMLElement;
  /** 設定欄の下に追加で表示する場所（動画モードの「クリップ」など） */
  readonly extra: HTMLElement;

  constructor(host: ToolHost) {
    this.toolList = h('nav', { class: 'tool-list', 'aria-label': 'ツール' });
    for (const tool of getTools()) {
      const b = h(
        'button',
        {
          class: 'tool-btn',
          type: 'button',
          title: `${tool.name}（${tool.shortcut}）`,
          onclick: () => host.setTool(tool.id),
        },
        h('span', { class: 'icon', html: tool.icon }),
        h('span', { class: 'tool-name' }, tool.name),
        h('kbd', {}, tool.shortcut),
      ) as HTMLButtonElement;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      this.buttons.set(tool.id, b);
      this.toolList.append(b);
    }
    this.settingsTitle = h('div', { class: 'panel-title' });
    this.settingsBody = h('div', { class: 'settings-body' });
    this.bottom = h('div', { class: 'panel-bottom' });
    this.extra = h('div', { class: 'settings-extra' });
    this.el = h(
      'aside',
      { class: 'left-panel' },
      this.toolList,
      h('section', { class: 'settings' }, this.settingsTitle, this.settingsBody, this.extra),
      this.bottom,
    );
  }

  /** ツールの切り替え：ボタンの強調と設定欄の差し替え */
  showTool(tool: Tool, host: ToolHost): void {
    for (const [id, b] of this.buttons) {
      b.classList.toggle('active', id === tool.id);
      b.setAttribute('aria-pressed', String(id === tool.id));
    }
    this.settings?.dispose?.();
    this.settingsTitle.textContent = `${tool.name} の設定`;
    this.settings = tool.createSettings(host);
    this.settingsBody.replaceChildren(this.settings.el);
  }

  update(): void {
    this.settings?.update?.();
  }
}
