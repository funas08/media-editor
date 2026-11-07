// 動画の書き出しダイアログ：MP4（H.264 + AAC）、倍率（WQHD×1.5 = 4K）、30 / 60fps、画質（ビットレート）。
// 書き出す前に、この環境でエンコードできるかを確かめる。AAC が使えないときは理由を示し「音声なしで書き出す」を選べる。
// 画質は「元の動画に合わせる」（既定）/ 高画質 / 標準 / 小さいファイル / ビットレートを指定。予想ファイルサイズも表示する。

import type { AssetStore } from '../core/AssetStore';
import { audioSegments, formatTime, totalDuration } from '../core/timeline';
import type { DocState } from '../core/types';
import { checkVideoSupport, chooseVideoTarget, exportBitrate, exportColorSpace, exportVideo, sourceMaxBitrate, videoExportSize, type VideoExportOptions } from '../media/browserExport';
import { describeCodec } from '../media/codecName';
import { AUDIO_BITRATE, QUALITY_MODE_LABEL, describeColorSpace, estimateFileSize, formatBytes, formatMbps, scaledMainClips, type QualityMode } from '../media/encodeSettings';
import { ExportCanceledError } from '../media/exportPipeline';
import type { MediaStore } from '../media/MediaStore';
import { button, checkbox, group, h, hint, numberInput, segmented, selectInput, text } from './controls';
import { openDialog } from './Dialog';

const STORAGE_KEY = 'image-editor.videoExport';

type Prefs = Pick<VideoExportOptions, 'scale' | 'fps' | 'mode' | 'customMbps'>;

function loadPrefs(): Prefs {
  const def: Prefs = { scale: 1, fps: 30, mode: 'source', customMbps: 20 };
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Prefs> | null;
    return {
      scale: [1, 1.5, 2].includes(p?.scale ?? 0) ? p!.scale! : def.scale,
      fps: p?.fps === 60 ? 60 : 30,
      mode: p?.mode && p.mode in QUALITY_MODE_LABEL ? p.mode : def.mode,
      customMbps: typeof p?.customMbps === 'number' && p.customMbps > 0 ? p.customMbps : def.customMbps,
    };
  } catch {
    return def;
  }
}

function sizeName(w: number, h: number): string {
  const names: Record<string, string> = { '1920x1080': 'FHD', '2560x1440': 'WQHD', '3840x2160': '4K', '1080x1920': 'FHD 縦', '1440x2560': 'WQHD 縦', '2160x3840': '4K 縦' };
  return names[`${w}x${h}`] ?? '';
}

export function openVideoExportDialog(
  doc: DocState,
  assets: AssetStore,
  media: MediaStore,
  toast: (m: string) => void,
  ioRange: { from: number; to: number } | null,
): void {
  let useRange = false;
  const fullDuration = totalDuration(doc);
  const durationNow = () => (useRange && ioRange ? ioRange.to - ioRange.from : fullDuration);
  const hasAudio = audioSegments(doc).some((s) => media.get(s.mediaId)?.audio);
  const prefs = loadPrefs();
  let aacOk = true;
  let videoOk = true;
  let hardware = false;
  let checkSeq = 0;

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
      void recheck();
    },
  );
  const fpsSeg = segmented<string>(
    [
      { value: '30', label: '30fps' },
      { value: '60', label: '60fps' },
    ],
    String(prefs.fps),
    (v) => {
      prefs.fps = v === '60' ? 60 : 30;
      fpsSeg.set(v);
      void recheck();
    },
  );
  const qualitySel = selectInput<QualityMode>(
    (Object.keys(QUALITY_MODE_LABEL) as QualityMode[]).map((q) => ({ value: q, label: QUALITY_MODE_LABEL[q] })),
    prefs.mode,
    (v) => {
      prefs.mode = v;
      void recheck();
    },
  );
  const mbpsInput = numberInput({
    value: prefs.customMbps,
    min: 1,
    max: 500,
    step: 1,
    digits: 1,
    unit: 'Mbps',
    onChange: (v) => {
      prefs.customMbps = v;
      void recheck();
    },
  });
  const bitrateText = text('', 'value');
  const bitrateNote = text('', 'hint pre-line');
  const scaleWarn = text('', 'hint');
  const colorNote = text('', 'hint');
  const rangeSeg = segmented<string>(
    [
      { value: 'all', label: 'タイムライン全体' },
      { value: 'io', label: 'I〜O の範囲', title: ioRange ? '' : 'タイムラインで I と O を指定すると選べます' },
    ],
    'all',
    (v) => {
      if (v === 'io' && !ioRange) return;
      useRange = v === 'io';
      rangeSeg.set(v);
      update();
    },
  );
  const rangeNote = text(ioRange ? `I〜O：${formatTime(ioRange.from)} 〜 ${formatTime(ioRange.to)}` : 'I〜O の範囲は未指定です（タイムラインで I / O キー）', 'hint');
  const sizeText = text('', 'export-size');
  const sizeNote = text('', 'hint');
  const support = text('確認中…', 'hint');
  const noAudioCb = checkbox('音声なしで書き出す', !hasAudio, () => update());
  const progress = h('progress', { class: 'progress', max: 1, value: 0 }) as HTMLProgressElement;
  const progressText = text('', 'hint');
  const progressWrap = h('div', { class: 'progress-wrap' }, progress, progressText.el);
  progressWrap.hidden = true;

  const cancelBtn = button('閉じる', () => (running ? controller?.abort() : dlg.close()));
  const exportBtn = button('書き出し', () => void run(), { primary: true });
  const body = h(
    'div',
    { class: 'export-form' },
    group('形式', h('div', { class: 'value' }, 'MP4（映像 H.264 / 音声 AAC）'), support.el),
    group('書き出す範囲', rangeSeg.el, rangeNote.el),
    group('倍率（キャンバスに対して）', scaleSeg.el),
    group('書き出しサイズ', sizeText.el, sizeNote.el, scaleWarn.el),
    group('フレームレート', fpsSeg.el),
    group('画質', h('div', { class: 'row-inline' }, qualitySel.el, mbpsInput.el), bitrateText.el, bitrateNote.el),
    group('音声', noAudioCb.el),
    group('色空間', colorNote.el),
    progressWrap,
    hint('選んだファイルに少しずつ書き込みます。動画はこのパソコンの中だけで処理され、外部には送信されません。'),
  );
  const dlg = openDialog({ title: '動画の書き出し', body, actions: [cancelBtn, exportBtn], canClose: () => !running });

  let running = false;
  let controller: AbortController | null = null;

  function update(): void {
    const { width, height, adjusted } = videoExportSize(doc, prefs.scale);
    const name = sizeName(width, height);
    sizeText.set(`${width} × ${height} px${name ? `（${name}）` : ''}`);
    sizeNote.set(`長さ ${formatTime(durationNow())}・${prefs.fps}fps・約 ${Math.max(1, Math.round(durationNow() * prefs.fps))} フレーム${adjusted ? '（H.264 の制約で幅・高さを偶数に切り下げ）' : ''}`);
    const lines: string[] = [];
    if (!videoOk) lines.push('⚠ この環境ではこのサイズ・設定の H.264 をエンコードできません。倍率・フレームレート・ビットレートを下げてください');
    if (!aacOk && hasAudio) lines.push('⚠ この環境（ブラウザ／OS）では音声を AAC でエンコードできません。「音声なしで書き出す」を選ぶと書き出せます');
    if (!hasAudio) lines.push('音声の入ったクリップがないため、音声なしで書き出します');
    support.set(lines.join('\n') || `✓ この環境で書き出せます（${hardware ? 'ハードウェアエンコーダーを優先' : 'ハードウェアエンコーダーが使えないため、ブラウザに任せます'}）`);
    // 画質（ビットレートと予想ファイルサイズ）
    mbpsInput.el.hidden = prefs.mode !== 'custom';
    const choice = exportBitrate(doc, media, prefs);
    const withAudioNow = hasAudio && !noAudioCb.input.checked;
    const bytes = estimateFileSize(choice.bitrate, withAudioNow ? AUDIO_BITRATE : 0, durationNow());
    bitrateText.set(`映像 ${formatMbps(choice.bitrate)}${withAudioNow ? `＋音声 ${AUDIO_BITRATE / 1000} kbps` : ''}・予想ファイルサイズ 約 ${formatBytes(bytes)}`);
    const src = sourceMaxBitrate(doc, media);
    const notes: string[] = [];
    if (prefs.mode === 'source') {
      notes.push(choice.fellBack ? '元の動画のビットレートが分からないため（メインに動画がないなど）、「標準」の値にしています' : `メインの元動画のうち最も高いビットレート（${formatMbps(src ?? 0)}）に合わせます`);
    } else if (src) {
      notes.push(`参考：メインの元動画の最高 ${formatMbps(src)}`);
    }
    notes.push('H.264 High プロファイル・可変ビットレート・画質優先。実際のサイズは映像の内容で前後します');
    bitrateNote.set(notes.join('\n'));
    // 拡大・縮小されるクリップ
    const scaled = scaledMainClips(doc, prefs.scale);
    scaleWarn.set(
      scaled.length
        ? `⚠ 拡大・縮小されます：${scaled.map((c) => `${c.srcW}×${c.srcH} → ${c.outW}×${c.outH}（${c.outW * c.outH > c.srcW * c.srcH ? '拡大' : '縮小'}）`).join('、')}。元の画質のまま書き出すには、キャンバスと倍率を元の動画と同じサイズにしてください`
        : '',
    );
    scaleWarn.el.classList.toggle('warn', scaled.length > 0);
    colorNote.set(`${describeColorSpace(exportColorSpace(doc, media))}（メインの最初の動画に合わせます）`);
    support.el.classList.toggle('warn', !videoOk || (!aacOk && hasAudio));
    noAudioCb.input.disabled = !hasAudio || running;
    const withAudio = hasAudio && !noAudioCb.input.checked;
    exportBtn.disabled = running || durationNow() <= 0 || !videoOk || (withAudio && !aacOk);
  }

  async function recheck(): Promise<void> {
    const seq = ++checkSeq;
    support.set('確認中…');
    exportBtn.disabled = true;
    const r = await checkVideoSupport(doc, media, prefs);
    if (seq !== checkSeq) return;
    videoOk = r.video;
    aacOk = r.audio;
    hardware = r.hardware;
    if (!aacOk && hasAudio) noAudioCb.set(true);
    update();
  }

  async function run(): Promise<void> {
    if (exportBtn.disabled) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // 保存できなくても書き出しには影響しない
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
    const dest = await chooseVideoTarget(`video-${stamp}.mp4`);
    if (!dest) return;
    running = true;
    controller = new AbortController();
    progressWrap.hidden = false;
    cancelBtn.textContent = 'キャンセル';
    for (const s of [scaleSeg, fpsSeg, rangeSeg]) s.el.classList.add('disabled');
    qualitySel.el.disabled = true;
    mbpsInput.input.disabled = true;
    update();
    const startedAt = performance.now();
    try {
      const used = await exportVideo(doc, assets, media, { ...prefs, includeAudio: hasAudio && !noAudioCb.input.checked, range: useRange && ioRange ? ioRange : null, preferHardware: hardware }, dest.target, (r) => {
        progress.value = r;
        const elapsed = (performance.now() - startedAt) / 1000;
        const remain = r > 0.01 ? (elapsed / r) * (1 - r) : 0;
        progressText.set(`${Math.floor(r * 100)}%　経過 ${formatTime(elapsed, false)}${r > 0.01 ? `　残り約 ${formatTime(remain, false)}` : ''}`);
      }, controller.signal);
      await dest.finish();
      toast(`動画を書き出しました（${formatTime((performance.now() - startedAt) / 1000, false)}・${describeCodec(used.codec)}・${formatMbps(used.bitrate)}）`);
      running = false;
      dlg.close();
    } catch (e) {
      await dest.abort();
      if (e instanceof ExportCanceledError) {
        toast('書き出しをキャンセルしました');
      } else {
        console.error(e);
        toast(`書き出しに失敗しました：${e instanceof Error ? e.message : String(e)}`);
      }
      running = false;
      progressWrap.hidden = true;
      cancelBtn.textContent = '閉じる';
      for (const s of [scaleSeg, fpsSeg, rangeSeg]) s.el.classList.remove('disabled');
      qualitySel.el.disabled = false;
      mbpsInput.input.disabled = false;
      update();
    }
  }

  update();
  void recheck();
}
