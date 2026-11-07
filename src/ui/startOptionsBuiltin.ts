// 起動画面の標準の選択肢：画像を開く / 白紙から作成 / プロジェクトを開く

import { CANVAS_PRESETS, MAX_CANVAS_SIDE, findPreset } from '../features/canvasPresets';
import { button, checkbox, group, h, numberInput, row, selectInput, type Choice } from './controls';
import { icons } from './icons';
import { registerStartOption } from './startOptions';

registerStartOption({
  id: 'open-image',
  title: '画像を開く',
  description: 'キャンバスが画像のサイズになります。この画面に画像をドロップしても開けます',
  icon: icons.imagePlus,
  order: 10,
  activate: (ctx) => ctx.pickImage(),
});

registerStartOption({
  id: 'blank',
  title: '白紙から作成',
  description: 'サイズと背景を選んで、空のキャンバスを作ります（画像を並べるとき）',
  icon: icons.canvas,
  order: 20,
  activate(ctx) {
    const prefs = { width: 2560, height: 1440, background: '#ffffff', transparent: false };
    const choices: Choice<string>[] = [...CANVAS_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: '任意サイズ' }];
    const presetSel = selectInput(choices, 'wqhd', (id) => {
      const p = CANVAS_PRESETS.find((x) => x.id === id);
      if (p) {
        prefs.width = p.width;
        prefs.height = p.height;
        widthIn.set(p.width);
        heightIn.set(p.height);
      } else {
        widthIn.input.focus();
      }
    });
    const syncPreset = () => presetSel.set(findPreset(prefs.width, prefs.height)?.id ?? 'custom');
    const widthIn = numberInput({
      value: prefs.width,
      min: 1,
      max: MAX_CANVAS_SIDE,
      unit: 'px',
      onChange: (v) => {
        prefs.width = Math.round(v);
        syncPreset();
      },
    });
    const heightIn = numberInput({
      value: prefs.height,
      min: 1,
      max: MAX_CANVAS_SIDE,
      unit: 'px',
      onChange: (v) => {
        prefs.height = Math.round(v);
        syncPreset();
      },
    });
    const color = h('input', { type: 'color', class: 'color', value: prefs.background }) as HTMLInputElement;
    color.addEventListener('input', () => (prefs.background = color.value));
    const transparent = checkbox('透明', false, (v) => {
      prefs.transparent = v;
      color.disabled = v;
    });
    const createBtn = button(
      '作成',
      () => {
        ctx.newBlank({ ...prefs });
        ctx.close();
      },
      { primary: true },
    );
    createBtn.classList.add('block');
    return h(
      'div',
      { class: 'start-panel' },
      group('サイズ', presetSel.el, row('幅', widthIn.el), row('高さ', heightIn.el)),
      group('背景', row('背景色', color), transparent.el),
      createBtn,
    );
  },
});

registerStartOption({
  id: 'open-project',
  title: 'プロジェクトを開く',
  description: '保存したプロジェクト（.json）を開きます',
  icon: icons.open,
  order: 30,
  activate: (ctx) => ctx.openProject(),
});
