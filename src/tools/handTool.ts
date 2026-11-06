// 手のひら(H)：ドラッグで表示位置を移動

import type { Point } from '../core/types';
import { h, hint } from '../ui/controls';
import { icons } from '../ui/icons';
import { registerTool } from './registry';

let last: Point | null = null;

registerTool({
  id: 'hand',
  name: '手のひら',
  icon: icons.hand,
  shortcut: 'H',
  order: 80,
  cursor: 'grab',

  onPointerDown(e, host) {
    last = e.screen;
    host.setCursor('grabbing');
  },
  onPointerMove(e, host) {
    if (!last || !(e.buttons & 1)) return;
    host.view.panX += e.screen.x - last.x;
    host.view.panY += e.screen.y - last.y;
    last = e.screen;
    host.requestRender();
  },
  onPointerUp(_e, host) {
    last = null;
    host.setCursor(null);
  },
  deactivate() {
    last = null;
  },

  createSettings() {
    return {
      el: h(
        'div',
        {},
        hint('キャンバスをドラッグすると表示位置を移動できます。'),
        hint('どのツールでも Space＋ドラッグ（または中ボタンドラッグ）で同じ操作ができます。ホイールでズームします。'),
      ),
    };
  },
});
