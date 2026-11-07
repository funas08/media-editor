// 色調補正(A)：明るさ・コントラスト・彩度・色相・グレースケール・ぼかし（非破壊、画像ごと）

import { DEFAULT_ADJUST, isImage } from '../core/doc';
import type { Adjust } from '../core/types';
import { editableSelection } from '../features/commands';
import { button, group, h, hint, slider, text } from '../ui/controls';
import { icons } from '../ui/icons';
import { selectAt } from './common';
import { registerTool } from './registry';
import type { ToolHost } from './Tool';

interface SliderDef {
  key: keyof Adjust;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const SLIDERS: SliderDef[] = [
  { key: 'brightness', label: '明るさ', min: 0, max: 200, step: 1, unit: '%' },
  { key: 'contrast', label: 'コントラスト', min: 0, max: 200, step: 1, unit: '%' },
  { key: 'saturate', label: '彩度', min: 0, max: 200, step: 1, unit: '%' },
  { key: 'hue', label: '色相', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'grayscale', label: 'グレースケール', min: 0, max: 100, step: 1, unit: '%' },
  { key: 'blur', label: 'ぼかし', min: 0, max: 50, step: 0.5, unit: 'px' },
];

function targetIds(host: ToolHost): string[] {
  return editableSelection(host.editor)
    .filter(isImage)
    .map((it) => it.id);
}

/** スライダーを動かしている間はプレビューし、離したら1回分として履歴に残す */
function setValue(host: ToolHost, key: keyof Adjust, v: number, final: boolean): void {
  const { editor } = host;
  const ids = targetIds(host);
  if (ids.length === 0) return;
  if (!editor.inTransaction) editor.begin('色調補正');
  editor.preview((d) => {
    for (const it of d.items) if (ids.includes(it.id) && isImage(it)) it.adjust[key] = v;
  });
  if (final) editor.commit();
}

registerTool({
  id: 'adjust',
  name: '色調補正',
  icon: icons.adjust,
  shortcut: 'A',
  order: 50,
  cursor: 'default',

  onPointerDown(e, host) {
    selectAt(e, host);
  },

  deactivate(host) {
    host.editor.commit();
  },

  createSettings(host) {
    const { editor } = host;
    const info = text('', 'value strong');
    const sliders = SLIDERS.map((def) => ({
      def,
      ctl: slider({
        label: def.label,
        min: def.min,
        max: def.max,
        step: def.step,
        unit: def.unit,
        value: DEFAULT_ADJUST[def.key],
        defaultValue: DEFAULT_ADJUST[def.key],
        onInput: (v) => setValue(host, def.key, v, false),
        onChange: (v) => setValue(host, def.key, v, true),
      }),
    }));
    const resetBtn = button(
      'すべてリセット',
      () => {
        const ids = targetIds(host);
        editor.update('色調補正をリセット', (d) => {
          for (const it of d.items) if (ids.includes(it.id) && isImage(it)) it.adjust = { ...DEFAULT_ADJUST };
        });
      },
      { icon: icons.undo },
    );

    const el = h(
      'div',
      {},
      group('対象', info.el),
      group('補正', ...sliders.map((s) => s.ctl.el)),
      resetBtn,
      hint('元画像は変更されません（表示と書き出し時にだけ反映）。項目名をダブルクリックするとその項目だけ元に戻ります。'),
      hint('複数の画像を選択していると、動かした項目がすべての画像に同じ値で反映されます。'),
    );

    const update = () => {
      const items = editableSelection(editor).filter(isImage);
      const first = items[0];
      info.set(items.length === 0 ? '画像を選択してください' : items.length === 1 ? first.name : `${items.length}枚（表示は1枚目の値）`);
      resetBtn.disabled = !first;
      for (const s of sliders) {
        s.ctl.setDisabled(!first);
        s.ctl.set(first ? first.adjust[s.def.key] : DEFAULT_ADJUST[s.def.key]);
      }
    };
    update();
    return { el, update };
  },
});
