// キャンバス(K)：キャンバスのサイズと背景

import { DEFAULT_CROP_SHAPE } from '../core/doc';
import { CANVAS_PRESETS, MAX_CANVAS_SIDE, findPreset } from '../features/canvasPresets';
import { fitCanvasToItems } from '../features/transform';
import { button, checkbox, group, h, hint, numberInput, row, selectInput, text, type Choice } from '../ui/controls';
import { icons } from '../ui/icons';
import { registerTool } from './registry';
import type { ToolHost } from './Tool';

function setSize(host: ToolHost, width: number, height: number): void {
  const w = Math.round(width);
  const hgt = Math.round(height);
  const c = host.editor.doc.canvas;
  if (c.width === w && c.height === hgt) return;
  host.editor.update('キャンバスサイズ', (d) => {
    d.canvas.width = w;
    d.canvas.height = hgt;
  });
  host.fitView();
}

registerTool({
  id: 'canvas',
  name: 'キャンバス',
  icon: icons.canvas,
  shortcut: 'K',
  order: 70,
  cursor: 'default',

  createSettings(host) {
    const { editor } = host;
    const choices: Choice<string>[] = [...CANVAS_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: '任意サイズ' }];
    const presetSel = selectInput(choices, 'custom', (id) => {
      const p = CANVAS_PRESETS.find((x) => x.id === id);
      if (p) setSize(host, p.width, p.height);
      else widthIn.input.focus();
    });
    const widthIn = numberInput({
      value: editor.doc.canvas.width,
      min: 1,
      max: MAX_CANVAS_SIDE,
      unit: 'px',
      onChange: (v) => setSize(host, v, editor.doc.canvas.height),
    });
    const heightIn = numberInput({
      value: editor.doc.canvas.height,
      min: 1,
      max: MAX_CANVAS_SIDE,
      unit: 'px',
      onChange: (v) => setSize(host, editor.doc.canvas.width, v),
    });
    const fitBtn = button(
      'キャンバスを選択した画像に合わせる',
      () => {
        let ok = false;
        editor.update('キャンバスを画像に合わせる', (d) => {
          ok = fitCanvasToItems(d, editor.selection);
        });
        if (!ok) {
          host.toast('合わせる画像を選択してください');
          return;
        }
        host.fitView();
        const c = editor.doc.canvas;
        host.toast(`キャンバスを ${c.width}×${c.height} にしました`);
      },
      { title: '選択した画像がちょうど収まる大きさにする（アイコン用の丸い画像づくりなどに）' },
    );
    fitBtn.classList.add('block-left');
    const shapeText = text('', 'value');
    const unshapeBtn = button('形を解除', () =>
      editor.update('キャンバスの形を解除', (d) => {
        d.canvas.shape = { ...DEFAULT_CROP_SHAPE };
      }),
    );
    const swapBtn = button('縦横を入れ替え', () => setSize(host, editor.doc.canvas.height, editor.doc.canvas.width), { icon: icons.rotateRight });

    // 背景色：ドラッグ中はプレビュー、閉じたら1回分として履歴に残す
    const color = h('input', { type: 'color', class: 'color' }) as HTMLInputElement;
    color.addEventListener('input', () => {
      if (!editor.inTransaction) editor.begin('背景色');
      editor.preview((d) => {
        d.canvas.background = color.value;
      });
    });
    color.addEventListener('change', () => editor.commit());
    const transparentCb = checkbox('透明', editor.doc.canvas.transparent, (v) => {
      editor.update(v ? '背景を透明に' : '背景を不透明に', (d) => {
        d.canvas.transparent = v;
      });
    });

    const el = h(
      'div',
      {},
      group('サイズ', presetSel.el, row('幅', widthIn.el), row('高さ', heightIn.el), swapBtn, fitBtn),
      group('背景', row('背景色', color), transparentCb.el),
      group('形', shapeText.el, unshapeBtn, hint('角丸・楕円の形はトリミングツール（対象：キャンバス）で設定します。形の外側は透明（JPEG では背景色）になります。')),
      hint('サイズを変えても画像の位置はそのままです。並べ直すには「並べる(G)」を使います。'),
      hint('丸いアイコン画像の作り方：トリミング（対象：キャンバス）で「正円」→ 確定 → PNG で書き出し。画像を丸く切り抜いた場合は「キャンバスを選択した画像に合わせる」→「透明」→ PNG'),
    );

    const update = () => {
      const c = editor.doc.canvas;
      presetSel.set(findPreset(c.width, c.height)?.id ?? 'custom');
      widthIn.set(c.width);
      heightIn.set(c.height);
      if (document.activeElement !== color) color.value = c.background;
      color.disabled = c.transparent;
      transparentCb.set(c.transparent);
      fitBtn.disabled = editor.selection.length === 0;
      const shapeNames = { rect: '四角形', roundRect: `角丸（半径 ${Math.round(c.shape.radius * 100)}%）`, ellipse: '楕円' };
      shapeText.set(`現在：${shapeNames[c.shape.kind]}`);
      unshapeBtn.disabled = c.shape.kind === 'rect';
    };
    update();
    return { el, update };
  },
});
