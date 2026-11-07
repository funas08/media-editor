// 動画の書き出しダイアログ：MP4（映像 H.264 / H.265 / AV1 + 音声 AAC）、倍率（WQHD×1.5 = 4K）、30 / 60fps、画質。
// 書き出す前に、この環境でエンコードできるかを確かめる。AAC が使えないときは理由を示し「音声なしで書き出す」を選べる。
// 画質は「元の動画に合わせる」（既定）/ 最高画質（品質固定）/ 高画質 / 標準 / 小さいファイル / ビットレートを指定。
// エンコーダーは自動（ハードウェア優先）/ ハードウェア / ソフトウェアから選べる（比べるため）。予想ファイルサイズも表示する。

import type { AssetStore } from '../core/AssetStore';
import { audioSegments, formatTime, totalDuration } from '../core/timeline';
import type { DocState } from '../core/types';
import {
  checkVideoSupport,
  chooseVideoTarget,
  exportBitrate,
  exportColorSpace,
  exportKeyFrameInterval,
  exportSource,
  exportVideo,
  videoExportSize,
  type HwAccel,
  type QualityPrefs,
} from '../media/browserExport';
import { describeCodec, parseCodec } from '../media/codecName';
import {
  AUDIO_BITRATE,
  BROWSER_ENCODER_FACTOR,
  ENCODER_PREF_LABEL,
  OUTPUT_CODEC_LABEL,
  QUALITY_MODE_LABEL,
  codecFamily,
  describeColorSpace,
  equivalentBitrate,
  estimateFileSize,
  formatBytes,
  formatMbps,
  scaledMainClips,
  type EncoderPref,
  type OutputCodec,
  type QualityMode,
} from '../media/encodeSettings';
import { ExportCanceledError } from '../media/exportPipeline';
import type { MediaStore } from '../media/MediaStore';
import { button, checkbox, group, h, hint, numberInput, segmented, selectInput, text } from './controls';
import { openDialog } from './Dialog';

const STORAGE_KEY = 'image-editor.videoExport';

function loadPrefs(): QualityPrefs {
  const def: QualityPrefs = { scale: 1, fps: 30, mode: 'source', customMbps: 20, codec: 'avc', encoder: 'auto' };
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<QualityPrefs> | null;
    return {
      scale: [1, 1.5, 2].includes(p?.scale ?? 0) ? p!.scale! : def.scale,
      fps: p?.fps === 60 ? 60 : 30,
      mode: p?.mode && p.mode in QUALITY_MODE_LABEL ? p.mode : def.mode,
      customMbps: typeof p?.customMbps === 'number' && p.customMbps > 0 ? p.customMbps : def.customMbps,
      codec: p?.codec && p.codec in OUTPUT_CODEC_LABEL ? p.codec : def.codec,
      encoder: p?.encoder && p.encoder in ENCODER_PREF_LABEL ? p.encoder : def.encoder,
    };
  } catch {
    return def;
  }
}

function sizeName(w: number, h: number): string {
  const names: Record<string, string> = { '1920x1080': 'FHD', '2560x1440': 'WQHD', '3840x2160': '4K', '1080x1920': 'FHD 縦', '1440x2560': 'WQHD 縦', '2160x3840': '4K 縦' };
  return names[`${w}x${h}`] ?? '';
}

const ACCEL_LABEL: Record<HwAccel, string> = { 'prefer-hardware': 'ハードウェア', 'prefer-software': 'ソフトウェア', 'no-preference': 'ブラウザに任せる（ハードウェアは使えませんでした）' };

/** 元動画のコーデックの短い名前（H.265 など） */
function sourceCodecName(codec: string | null): string {
  return parseCodec(codec)?.name ?? '不明';
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
  let checking = true;
  let accel: HwAccel = 'no-preference';
  /** 品質固定を使えるか（「最高画質」以外では null） */
  let quantizerOk: boolean | null = null;
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
  const codecSel = selectInput<OutputCodec>(
    (Object.keys(OUTPUT_CODEC_LABEL) as OutputCodec[]).map((c) => ({ value: c, label: OUTPUT_CODEC_LABEL[c] })),
    prefs.codec,
    (v) => {
      prefs.codec = v;
      void recheck();
    },
  );
  const encoderSel = selectInput<EncoderPref>(
    (Object.keys(ENCODER_PREF_LABEL) as EncoderPref[]).map((c) => ({ value: c, label: ENCODER_PREF_LABEL[c] })),
    prefs.encoder,
    (v) => {
      prefs.encoder = v;
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
  const codecNote = text('', 'hint pre-line');
  const encoderNote = text('', 'hint');
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
    group('形式', h('div', { class: 'value' }, 'MP4（音声 AAC）'), support.el),
    group('書き出す範囲', rangeSeg.el, rangeNote.el),
    group('倍率（キャンバスに対して）', scaleSeg.el),
    group('書き出しサイズ', sizeText.el, sizeNote.el, scaleWarn.el),
    group('フレームレート', fpsSeg.el),
    group('映像のコーデック', codecSel.el, codecNote.el),
    group('エンコーダー', encoderSel.el, encoderNote.el),
    group('画質', h('div', { class: 'row-inline' }, qualitySel.el, mbpsInput.el), bitrateText.el, bitrateNote.el),
    group('音声', noAudioCb.el),
    group('色空間', colorNote.el),
    progressWrap,
    hint('選んだファイルに少しずつ書き込みます。動画はこのパソコンの中だけで処理され、外部には送信されません。'),
  );
  const dlg = openDialog({ title: '動画の書き出し', body, actions: [cancelBtn, exportBtn], canClose: () => !running });

  let running = false;
  let controller: AbortController | null = null;
  const controls = [codecSel.el, encoderSel.el, qualitySel.el, mbpsInput.input];

  function update(): void {
    const { width, height, adjusted } = videoExportSize(doc, prefs.scale);
    const name = sizeName(width, height);
    sizeText.set(`${width} × ${height} px${name ? `（${name}）` : ''}`);
    sizeNote.set(`長さ ${formatTime(durationNow())}・${prefs.fps}fps・約 ${Math.max(1, Math.round(durationNow() * prefs.fps))} フレーム${adjusted ? '（幅・高さを偶数に切り下げ）' : ''}`);

    // この環境で書き出せるか
    const lines: string[] = [];
    if (!videoOk) {
      lines.push(
        prefs.encoder === 'auto'
          ? `⚠ この環境ではこのサイズ・設定の ${OUTPUT_CODEC_LABEL[prefs.codec]} をエンコードできません。コーデック・倍率・フレームレート・ビットレートを変えてください`
          : `⚠ ${ENCODER_PREF_LABEL[prefs.encoder]}エンコーダーでは、このサイズ・設定の ${OUTPUT_CODEC_LABEL[prefs.codec]} をエンコードできません。エンコーダーを「自動」にするか、設定を変えてください`,
      );
    }
    if (!aacOk && hasAudio) lines.push('⚠ この環境（ブラウザ／OS）では音声を AAC でエンコードできません。「音声なしで書き出す」を選ぶと書き出せます');
    if (!hasAudio) lines.push('音声の入ったクリップがないため、音声なしで書き出します');
    support.set(checking ? '確認中…' : lines.join('\n') || '✓ この環境で書き出せます');
    support.el.classList.toggle('warn', !checking && (!videoOk || (!aacOk && hasAudio)));

    // コーデック
    const codecNotes: string[] = [];
    if (prefs.codec === 'hevc') codecNotes.push('H.264 より小さいファイルで同じ画質になります。Windows の標準プレーヤーでは「HEVC ビデオ拡張機能」が必要なことがあります');
    if (prefs.codec === 'av1') codecNotes.push('H.264 の約半分のビットレートで同じ画質になります。古い機器・ソフトでは再生できないことがあります');
    const disabled = (Object.keys(OUTPUT_CODEC_LABEL) as OutputCodec[]).filter((c) => [...codecSel.el.options].find((o) => o.value === c)?.disabled);
    if (disabled.length) codecNotes.push(`この環境で使えないもの：${disabled.map((c) => OUTPUT_CODEC_LABEL[c]).join('、')}`);
    codecNote.set(codecNotes.join('\n'));
    encoderNote.set(checking || !videoOk ? '' : `使うエンコーダー：${ACCEL_LABEL[accel]}`);

    // 画質（ビットレートと予想ファイルサイズ）
    mbpsInput.el.hidden = prefs.mode !== 'custom';
    const choice = exportBitrate(doc, media, prefs);
    const withAudioNow = hasAudio && !noAudioCb.input.checked;
    const audioText = withAudioNow ? `＋音声 ${AUDIO_BITRATE / 1000} kbps` : '';
    const useQ = choice.quantizer !== null && quantizerOk === true;
    if (useQ) {
      bitrateText.set(`品質固定（QP ${choice.quantizer}）${audioText}・ファイルサイズは内容しだい（予想できません）`);
    } else {
      const bytes = estimateFileSize(choice.bitrate, withAudioNow ? AUDIO_BITRATE : 0, durationNow());
      bitrateText.set(`映像 ${formatMbps(choice.bitrate)}${audioText}・予想ファイルサイズ 約 ${formatBytes(bytes)}`);
    }
    const src = exportSource(doc, media, prefs.codec);
    const notes: string[] = [];
    if (prefs.mode === 'source') {
      if (choice.fellBack || !src) {
        notes.push('元の動画のビットレートが分からないため（メインに動画がないなど）、「標準」の値にしています');
      } else {
        const srcName = sourceCodecName(src.rate.codec);
        const same = codecFamily(src.rate.codec) === prefs.codec;
        const eq = equivalentBitrate(src.rate, prefs.codec);
        notes.push(
          `基準：${src.info.name}（${srcName}・${formatMbps(src.rate.bitrate)}）` +
            (same ? '' : ` → ${OUTPUT_CODEC_LABEL[prefs.codec]} 換算 ${formatMbps(eq)}`) +
            ` → 再エンコードの劣化を補うため ×${BROWSER_ENCODER_FACTOR}`,
        );
        if (choice.capped) notes.push('元のビットレートが非常に高いため、上限（標準の 4 倍）にしています');
      }
    } else if (prefs.mode === 'max') {
      if (quantizerOk === false) notes.push(`⚠ この環境・エンコーダーでは品質固定が使えないため、${formatMbps(choice.bitrate)}（標準の 2.5 倍）で書き出します`);
      else notes.push('ビットレートではなく画質を一定に保ちます（ほぼ見分けがつかない画質。ファイルは大きくなります）');
    } else if (src) {
      notes.push(`参考：メインの元動画 ${src.info.name}（${sourceCodecName(src.rate.codec)}・${formatMbps(src.rate.bitrate)}）`);
    }
    const kf = exportKeyFrameInterval(doc, media);
    notes.push(`可変ビットレート・画質優先・キーフレーム間隔 ${kf} 秒（元の動画に合わせる）${prefs.codec === 'avc' ? '・High プロファイル' : ''}`);
    bitrateNote.set(notes.join('\n'));
    bitrateNote.el.classList.toggle('warn', prefs.mode === 'max' && quantizerOk === false);

    // 拡大・縮小されるクリップ
    const scaled = scaledMainClips(doc, prefs.scale);
    scaleWarn.set(
      scaled.length
        ? `⚠ 拡大・縮小されます：${scaled.map((c) => `${c.srcW}×${c.srcH} → ${c.outW}×${c.outH}（${c.outW * c.outH > c.srcW * c.srcH ? '拡大' : '縮小'}）`).join('、')}。元の画質のまま書き出すには、キャンバスと倍率を元の動画と同じサイズにしてください`
        : '',
    );
    scaleWarn.el.classList.toggle('warn', scaled.length > 0);
    colorNote.set(`${describeColorSpace(exportColorSpace(doc, media))}（メインの最初の動画に合わせます）`);
    noAudioCb.input.disabled = !hasAudio || running;
    for (const c of controls) c.disabled = running;
    const withAudio = hasAudio && !noAudioCb.input.checked;
    exportBtn.disabled = running || checking || durationNow() <= 0 || !videoOk || (withAudio && !aacOk);
  }

  async function recheck(): Promise<void> {
    const seq = ++checkSeq;
    checking = true;
    update();
    const r = await checkVideoSupport(doc, media, prefs);
    if (seq !== checkSeq) return;
    checking = false;
    videoOk = r.video;
    aacOk = r.audio;
    accel = r.hardwareAcceleration;
    quantizerOk = r.quantizer;
    for (const o of codecSel.el.options) {
      const ok = r.codecs[o.value as OutputCodec];
      o.disabled = !ok && o.value !== prefs.codec;
      o.textContent = OUTPUT_CODEC_LABEL[o.value as OutputCodec] + (ok ? '' : '（この環境では使えません）');
    }
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
    update();
    const startedAt = performance.now();
    try {
      const used = await exportVideo(
        doc,
        assets,
        media,
        {
          ...prefs,
          includeAudio: hasAudio && !noAudioCb.input.checked,
          range: useRange && ioRange ? ioRange : null,
          hardwareAcceleration: accel,
          useQuantizer: quantizerOk === true,
        },
        dest.target,
        (r) => {
          progress.value = r;
          const elapsed = (performance.now() - startedAt) / 1000;
          const remain = r > 0.01 ? (elapsed / r) * (1 - r) : 0;
          progressText.set(`${Math.floor(r * 100)}%　経過 ${formatTime(elapsed, false)}${r > 0.01 ? `　残り約 ${formatTime(remain, false)}` : ''}`);
        },
        controller.signal,
      );
      await dest.finish();
      const rate = used.quantizer !== null ? `品質固定 QP ${used.quantizer}` : formatMbps(used.bitrate);
      toast(`動画を書き出しました（${formatTime((performance.now() - startedAt) / 1000, false)}・${describeCodec(used.codec)}・${rate}・${ACCEL_LABEL[used.hardwareAcceleration as HwAccel] ?? used.hardwareAcceleration}）`);
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
      update();
    }
  }

  update();
  void recheck();
}
