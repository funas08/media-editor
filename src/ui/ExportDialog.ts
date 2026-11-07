// 書き出しダイアログ：形式（PNG / JPEG / WebP）、品質、倍率、書き出しサイズの事前表示

import type { Editor } from '../core/Editor';
import { FORMAT_INFO, defaultExportName, exportSize, renderToBlob, type ExportFormat } from '../features/export';
import { downloadBlob } from '../io/files';
import { button, group, h, hint, segmented, slider, text } from './controls';
import { openDialog } from './Dialog';

const STORAGE_KEY = 'image-editor.export';
/** Chrome の Canvas の上限（面積と1辺） */
const MAX_AREA = 268_435_456;
const MAX_SIDE = 32_767;

interface Prefs {
  format: ExportFormat;
  quality: number;
  scale: number;
}

function loadPrefs(): Prefs {
  const def: Prefs = { format: 'png', quality: 92, scale: 1 };
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Prefs> | null;
    if (!p) return def;
    return {
      format: p.format && p.format in FORMAT_INFO ? p.format : def.format,
      quality: typeof p.quality === 'number' ? p.quality : def.quality,
      scale: [1, 1.5, 2].includes(p.scale ?? 0) ? (p.scale as number) : def.scale,
    };
  } catch {
    return def;
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // 保存できなくても書き出しには影響しない
  }
}

/** よく使うサイズに名前を付けて表示 */
function sizeName(w: number, h: number): string {
  const names: Record<string, string> = {
    '1920x1080': 'FHD',
    '2560x1440': 'WQHD',
    '3840x2160': '4K',
    '5120x2880': '5K',
    '7680x4320': '8K',
    '1080x1920': 'FHD 縦',
    '1440x2560': 'WQHD 縦',
    '2160x3840': '4K 縦',
  };
  return names[`${w}x${h}`] ?? '';
}

export function openExportDialog(editor: Editor, toast: (m: string) => void): void {
  const prefs = loadPrefs();
  const doc = editor.doc;
  const base = defaultExportName('png').replace(/\.png$/, '');

  const formatSeg = segmented<ExportFormat>(
    (Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => ({ value: f, label: FORMAT_INFO[f].label })),
    prefs.format,
    (v) => {
      prefs.format = v;
      formatSeg.set(v);
      update();
    },
  );
  const quality = slider({
    label: '品質',
    min: 1,
    max: 100,
    value: prefs.quality,
    defaultValue: 92,
    unit: '%',
    onInput: (v) => {
      prefs.quality = v;
    },
    onChange: (v) => {
      prefs.quality = v;
    },
  });
  const scaleSeg = segmented<string>(
    [
      { value: '1', label: '1x' },
      { value: '1.5', label: '1.5x' },
      { value: '2', label: '2x' },
    ],
    String(prefs.scale),
    (v) => {
      prefs.scale = Number(v);
      scaleSeg.set(v);
      update();
    },
  );
  const sizeText = text('', 'export-size');
  const sizeNote = text('', 'hint');
  const formatNote = text('', 'hint');
  const nameInput = h('input', { class: 'num name-input', value: base, spellcheck: false }) as HTMLInputElement;
  const extLabel = text('', 'unit');

  const cancelBtn = button('キャンセル', () => dlg.close());
  const exportBtn = button('書き出し', () => void run(), { primary: true });

  const body = h(
    'div',
    { class: 'export-form' },
    group('形式', formatSeg.el, formatNote.el),
    group('品質', quality.el),
    group('倍率', scaleSeg.el),
    group('書き出しサイズ', sizeText.el, sizeNote.el),
    group('ファイル名', h('div', { class: 'name-row' }, nameInput, extLabel.el)),
    hint('書き出しは表示とは別に原寸（×倍率）で描画します。画像はこのパソコンに保存され、外部には送信されません。'),
  );
  const dlg = openDialog({ title: '書き出し', body, actions: [cancelBtn, exportBtn] });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void run();
  });

  function update(): void {
    const info = FORMAT_INFO[prefs.format];
    quality.setDisabled(!info.lossy);
    formatNote.set(
      prefs.format === 'png'
        ? '劣化なし（ファイルは大きめ）。透明を保持します'
        : prefs.format === 'jpeg'
          ? `写真向き。透明は扱えません${doc.canvas.transparent ? '（透明部分は白になります）' : ''}`
          : '小さく高画質。透明を保持します',
    );
    const { width, height } = exportSize(doc, prefs.scale);
    const name = sizeName(width, height);
    sizeText.set(`${width} × ${height} px${name ? `（${name}）` : ''}`);
    const tooBig = width * height > MAX_AREA || Math.max(width, height) > MAX_SIDE;
    sizeNote.set(
      tooBig
        ? 'ブラウザの上限を超えるため書き出せません。倍率を下げてください'
        : `キャンバス ${doc.canvas.width} × ${doc.canvas.height} の ${prefs.scale} 倍`,
    );
    sizeNote.el.classList.toggle('warn', tooBig);
    exportBtn.disabled = tooBig;
    extLabel.set(`.${info.ext}`);
  }

  async function run(): Promise<void> {
    if (exportBtn.disabled) return;
    savePrefs(prefs);
    exportBtn.disabled = cancelBtn.disabled = true;
    exportBtn.textContent = '書き出し中…';
    try {
      const blob = await renderToBlob(doc, editor.assets, { format: prefs.format, quality: prefs.quality / 100, scale: prefs.scale });
      const fileName = `${nameInput.value.trim() || base}.${FORMAT_INFO[prefs.format].ext}`;
      downloadBlob(blob, fileName);
      const { width, height } = exportSize(doc, prefs.scale);
      toast(`${fileName} を書き出しました（${width}×${height}、${formatBytes(blob.size)}）`);
      dlg.close();
    } catch (err) {
      console.error(err);
      toast('書き出しに失敗しました');
      exportBtn.disabled = cancelBtn.disabled = false;
      exportBtn.textContent = '書き出し';
    }
  }

  update();
  exportBtn.focus();
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
