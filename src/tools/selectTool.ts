// 選択・移動(V)
// Phase 0：クリック選択・Shift+クリックのみ（移動・範囲選択・スナップ・整列は Phase 1）

import { deleteSelected, selectAll, topItemAt } from '../features/commands';
import { button, group, h, hint, text } from '../ui/controls';
import { icons } from '../ui/icons';
import { registerTool } from './registry';

registerTool({
  id: 'select',
  name: '選択・移動',
  icon: icons.select,
  shortcut: 'V',
  order: 10,
  cursor: 'default',

  onPointerDown(e, host) {
    const { editor } = host;
    const hit = topItemAt(editor.doc.items, e.doc);
    if (e.shift) {
      if (!hit) return;
      const sel = editor.selection;
      editor.setSelection(sel.includes(hit.id) ? sel.filter((id) => id !== hit.id) : [...sel, hit.id]);
      return;
    }
    editor.setSelection(hit ? [hit.id] : []);
  },

  createSettings(host) {
    const { editor } = host;
    const info = text('', 'value strong');
    const el = h(
      'div',
      {},
      group('選択', info.el),
      h(
        'div',
        { class: 'btn-row' },
        button('すべて選択', () => selectAll(editor), { title: 'Ctrl+A' }),
        button('選択解除', () => editor.setSelection([])),
      ),
      button('削除', () => deleteSelected(editor), { icon: icons.trash, danger: true, title: 'Delete' }),
      hint('クリックで選択、Shift+クリックで追加・解除します。'),
    );
    const update = () => {
      const n = editor.selection.length;
      info.set(n === 0 ? '選択なし' : `${n}枚を選択中（全${editor.doc.items.length}枚）`);
    };
    update();
    return { el, update };
  },
});
