// 動画の書き出しダイアログ：MP4（H.264 + AAC）、倍率（WQHD×1.5 = 4K）、30 / 60fps、画質。
// 書き出す前に、この環境でエンコードできるかを確かめる。AAC が使えないときは理由を示し「音声なしで書き出す」を選べる。

import type { AssetStore } from '../core/AssetStore';
import { audioSegments, formatTime, totalDuration } from '../core/timeline';
import type { DocState } from '../core/types';
import { QUALITY_LABEL, checkVideoSupport, chooseVideoTarget, exportVideo, videoExportSize, type VideoExportOptions, type VideoQuality } from '../media/browserExport';
import { ExportCanceledError } from '../media/exportPipeline';
import type { MediaStore } from '../media/MediaStore';
import { button, checkbox, group, h, hint, segmented, text } from './controls';
import { openDialog } from './Dialog';

const STORAGE_KEY = 'image-editor.videoExport';

function loadPrefs(): Omit<VideoExportOptions, 'includeAudio'> {
  const def = { scale: 1, fps: 30 as const, quality: 'high' as VideoQuality };
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<VideoExportOptions> | null;
    return {
      scale: [1, 1.5, 2].includes(p?.scale ?? 0) ? p!.scale! : def.scale,
      fps: p?.fps === 60 ? 60 : 30,
      quality: p?.quality && p.quality in QUALITY_LABEL ? p.quality : def.quality,
    };
  } catch {
    return def;
  }
}

function sizeName(w: number, h: number): string {
  const names: Record<string, string> = { '1920x1080': 'FHD', '2560x1440': 'WQHD', '3840x2160': '4K', '1080x1920': 'FHD 縦', '1440x2560': 'WQHD 縦', '2160x3840': '4K 縦' };
  return names[`${w}x${h}`] ?? '';
}

export function openVideoExportDialog(doc: DocState, assets: AssetStore, media: MediaStore, toast: (m: string) => void): void {
  const duration = totalDuration(doc);
  const hasAudio = audioSegments(doc).some((s) => media.get(s.mediaId)?.audio);
  const prefs = loadPrefs();
  let aacOk = true;
  let videoOk = true;
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
  const qualitySeg = segmented<VideoQuality>(
    (Object.keys(QUALITY_LABEL) as VideoQuality[]).map((q) => ({ value: q, label: QUALITY_LABEL[q] })),
    prefs.quality,
    (v) => {
      prefs.quality = v;
      qualitySeg.set(v);
      void recheck();
    },
  );
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
    group('倍率（キャンバスに対して）', scaleSeg.el),
    group('書き出しサイズ', sizeText.el, sizeNote.el),
    group('フレームレート', fpsSeg.el),
    group('画質', qualitySeg.el),
    group('音声', noAudioCb.el),
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
    sizeNote.set(`長さ ${formatTime(duration)}・${prefs.fps}fps・約 ${Math.max(1, Math.round(duration * prefs.fps))} フレーム${adjusted ? '（H.264 の制約で幅・高さを偶数に切り下げ）' : ''}`);
    const lines: string[] = [];
    if (!videoOk) lines.push('⚠ この環境ではこのサイズ・設定の H.264 をエンコードできません。倍率・フレームレート・画質を下げてください');
    if (!aacOk && hasAudio) lines.push('⚠ この環境（ブラウザ／OS）では音声を AAC でエンコードできません。「音声なしで書き出す」を選ぶと書き出せます');
    if (!hasAudio) lines.push('音声の入ったクリップがないため、音声なしで書き出します');
    support.set(lines.join('\n') || '✓ この環境で書き出せます');
    support.el.classList.toggle('warn', !videoOk || (!aacOk && hasAudio));
    noAudioCb.input.disabled = !hasAudio || running;
    const withAudio = hasAudio && !noAudioCb.input.checked;
    exportBtn.disabled = running || duration <= 0 || !videoOk || (withAudio && !aacOk);
  }

  async function recheck(): Promise<void> {
    const seq = ++checkSeq;
    support.set('確認中…');
    exportBtn.disabled = true;
    const r = await checkVideoSupport(doc, { ...prefs, includeAudio: true });
    if (seq !== checkSeq) return;
    videoOk = r.video;
    aacOk = r.audio;
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
    for (const s of [scaleSeg, fpsSeg, qualitySeg]) s.el.classList.add('disabled');
    update();
    const startedAt = performance.now();
    try {
      await exportVideo(doc, assets, media, { ...prefs, includeAudio: hasAudio && !noAudioCb.input.checked }, dest.target, (r) => {
        progress.value = r;
        const elapsed = (performance.now() - startedAt) / 1000;
        const remain = r > 0.01 ? (elapsed / r) * (1 - r) : 0;
        progressText.set(`${Math.floor(r * 100)}%　経過 ${formatTime(elapsed, false)}${r > 0.01 ? `　残り約 ${formatTime(remain, false)}` : ''}`);
      }, controller.signal);
      await dest.finish();
      toast(`動画を書き出しました（${formatTime((performance.now() - startedAt) / 1000, false)}）`);
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
      for (const s of [scaleSeg, fpsSeg, qualitySeg]) s.el.classList.remove('disabled');
      update();
    }
  }

  update();
  void recheck();
}
