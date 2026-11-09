// 動画の書き出しダイアログ：MP4（映像 H.264 / H.265 / AV1 + 音声 AAC）、倍率（WQHD×1.5 = 4K）、30 / 60fps、画質。
// 書き出す前に、この環境でエンコードできるかを確かめる。AAC が使えないときは理由を示し「音声なしで書き出す」を選べる。
// 画質は「元の画質を優先（可能な区間は無劣化コピー）」（既定）/「元の動画に合わせる」/ 最高画質（品質固定）/ 高画質 / 標準 / 小さいファイル / ビットレートを指定。
// エンコーダーは自動（ハードウェア優先）/ ハードウェア / ソフトウェアから選べる（比べるため）。予想ファイルサイズも表示する。
// 「高画質書き出し（ローカルサーバ）」では、npm run export-server で起動したサーバの ffmpeg（x264 / x265）で圧縮する。

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
  exportVideoFfmpeg,
  ffmpegPlanFor,
  smartPlanFor,
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
import { formatSeconds, type SmartPlan } from '../media/smartCopy';
import { DEFAULT_SERVER_PORT, ExportServerClient, FFMPEG_AUDIO_BITRATE, FFMPEG_QUALITY, type FfmpegQuality, type ServerInfo } from '../media/exportServer';
import { mainVideoMediaIds } from '../media/encodeSettings';
import { button, checkbox, group, h, hint, numberInput, segmented, selectInput, text } from './controls';
import { openDialog } from './Dialog';

const STORAGE_KEY = 'image-editor.videoExport';

/** 保存する設定の版。2：「元の画質を優先」を追加して既定にした（それより前に保存した画質の選択は引き継がない） */
const PREFS_VERSION = 2;

function loadPrefs(): QualityPrefs {
  const def: QualityPrefs = { scale: 1, fps: 30, mode: 'smart', customMbps: 20, codec: 'avc', encoder: 'auto' };
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as (Partial<QualityPrefs> & { v?: number }) | null;
    return {
      scale: [1, 1.5, 2].includes(p?.scale ?? 0) ? p!.scale! : def.scale,
      fps: p?.fps === 60 ? 60 : 30,
      mode: p?.v === PREFS_VERSION && p.mode && p.mode in QUALITY_MODE_LABEL ? p.mode : def.mode,
      customMbps: typeof p?.customMbps === 'number' && p.customMbps > 0 ? p.customMbps : def.customMbps,
      codec: p?.codec && p.codec in OUTPUT_CODEC_LABEL ? p.codec : def.codec,
      encoder: p?.encoder && p.encoder in ENCODER_PREF_LABEL ? p.encoder : def.encoder,
    };
  } catch {
    return def;
  }
}

const SERVER_KEY = 'image-editor.videoExport.server';
const TOKEN_KEY = 'image-editor.exportServer.token';

/** 高画質書き出し（ローカルサーバ）の設定 */
interface ServerPrefs {
  method: 'browser' | 'server';
  port: number;
  quality: FfmpegQuality;
  codec: 'avc' | 'hevc';
  smartCopy: boolean;
}

function loadServerPrefs(): ServerPrefs {
  const def: ServerPrefs = { method: 'browser', port: DEFAULT_SERVER_PORT, quality: 'best', codec: 'avc', smartCopy: true };
  try {
    const p = JSON.parse(localStorage.getItem(SERVER_KEY) ?? 'null') as Partial<ServerPrefs> | null;
    return {
      method: p?.method === 'server' ? 'server' : 'browser',
      port: Number.isInteger(p?.port) && p!.port! >= 1024 && p!.port! <= 65535 ? p!.port! : def.port,
      quality: p?.quality && p.quality in FFMPEG_QUALITY ? p.quality : def.quality,
      codec: p?.codec === 'hevc' ? 'hevc' : 'avc',
      smartCopy: p?.smartCopy !== false,
    };
  } catch {
    return def;
  }
}

/** トークンはサーバを起動するたびに変わるので、このタブの間だけ覚えておく */
function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
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
  // 元の画質を優先するときは、コーデックとフレームレートをメインの最初の動画に合わせておく（無劣化コピーの条件）
  if (prefs.mode === 'smart') matchSource();
  let smartPlan: SmartPlan | null = null;
  const sp = loadServerPrefs();
  let token = loadToken();
  /** サーバの確認結果（未確認・接続できない場合は null） */
  let serverInfo: ServerInfo | null = null;
  let serverError = '';
  const isServer = () => sp.method === 'server';
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
      if (v === 'smart') {
        matchSource();
        codecSel.set(prefs.codec);
        fpsSeg.set(String(prefs.fps));
      }
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
  const smartText = text('', 'value');
  const smartNote = text('', 'hint pre-line');
  const smartGroup = group('無劣化コピー', smartText.el, smartNote.el);
  // ---- 高画質書き出し（ローカルサーバ） ----
  const methodSeg = segmented<ServerPrefs['method']>(
    [
      { value: 'browser', label: 'ブラウザで書き出し' },
      { value: 'server', label: '高画質書き出し（ローカルサーバ）' },
    ],
    sp.method,
    (v) => {
      sp.method = v;
      methodSeg.set(v);
      void recheck();
    },
  );
  const portInput = numberInput({
    value: sp.port,
    min: 1024,
    max: 65535,
    step: 1,
    digits: 0,
    onChange: (v) => {
      sp.port = Math.round(v);
      void recheck();
    },
  });
  const tokenInput = h('input', { type: 'password', class: 'num token-input', placeholder: 'サーバに表示されたトークンを貼り付け', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  tokenInput.value = token;
  tokenInput.addEventListener('change', () => {
    token = tokenInput.value.trim();
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // 覚えられなくても書き出しには影響しない
    }
    void recheck();
  });
  const connectBtn = button('接続を確認', () => {
    tokenInput.dispatchEvent(new Event('change'));
  });
  const serverStatus = text('', 'hint pre-line');
  const ffQualitySel = selectInput<FfmpegQuality>(
    (Object.keys(FFMPEG_QUALITY) as FfmpegQuality[]).map((q) => ({ value: q, label: FFMPEG_QUALITY[q].label })),
    sp.quality,
    (v) => {
      sp.quality = v;
      update();
    },
  );
  const ffCodecSel = selectInput<ServerPrefs['codec']>(
    [
      { value: 'avc', label: 'H.264（x264）' },
      { value: 'hevc', label: 'H.265（x265）' },
    ],
    sp.codec,
    (v) => {
      sp.codec = v;
      void recheck();
    },
  );
  const ffCodecNote = text('', 'hint');
  const ffSmartCb = checkbox('可能な区間は無劣化コピー（編集した区間だけを ffmpeg で圧縮）', sp.smartCopy, (v) => {
    sp.smartCopy = v;
    void recheck();
  });
  const serverGroups = [
    group('ローカルサーバ', h('div', { class: 'row-inline' }, h('span', { class: 'hint' }, 'ポート'), portInput.el, tokenInput, connectBtn), serverStatus.el),
    group('画質（ffmpeg）', ffQualitySel.el, hint(`CRF（画質を一定に保つ方式）。数字が小さいほど高画質・大きいファイルになります。音声は AAC ${FFMPEG_AUDIO_BITRATE / 1000}kbps`)),
    group('映像のコーデック（ffmpeg）', ffCodecSel.el, ffCodecNote.el),
    group('無劣化コピー（ffmpeg）', ffSmartCb.el),
  ];

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
      void recheck();
    },
  );
  const rangeNote = text(ioRange ? `I〜O：${formatTime(ioRange.from)} 〜 ${formatTime(ioRange.to)}` : 'I〜O の範囲は未指定です（タイムラインで I / O キー）', 'hint');
  const sizeText = text('', 'export-size');
  const sizeNote = text('', 'hint');
  const support = text('確認中…', 'hint');
  const noAudioCb = checkbox('音声なしで書き出す', !hasAudio, () => void recheck());
  const progress = h('progress', { class: 'progress', max: 1, value: 0 }) as HTMLProgressElement;
  const progressText = text('', 'hint');
  const progressWrap = h('div', { class: 'progress-wrap' }, progress, progressText.el);
  progressWrap.hidden = true;

  const cancelBtn = button('閉じる', () => (running ? controller?.abort() : dlg.close()));
  const exportBtn = button('書き出し', () => void run(), { primary: true });
  const browserGroups = [
    group('映像のコーデック', codecSel.el, codecNote.el),
    group('エンコーダー', encoderSel.el, encoderNote.el),
    group('画質', h('div', { class: 'row-inline' }, qualitySel.el, mbpsInput.el), bitrateText.el, bitrateNote.el),
  ];
  const body = h(
    'div',
    { class: 'export-form' },
    group('書き出し方法', methodSeg.el),
    group('形式', h('div', { class: 'value' }, 'MP4（音声 AAC）'), support.el),
    ...serverGroups,
    group('書き出す範囲', rangeSeg.el, rangeNote.el),
    group('倍率（キャンバスに対して）', scaleSeg.el),
    group('書き出しサイズ', sizeText.el, sizeNote.el, scaleWarn.el),
    group('フレームレート', fpsSeg.el),
    ...browserGroups,
    smartGroup,
    group('音声', noAudioCb.el),
    group('色空間', colorNote.el),
    progressWrap,
    hint('選んだファイルに少しずつ書き込みます。動画はこのパソコンの中だけで処理され、外部には送信されません（ローカルサーバもこのパソコンの中で動きます）。'),
  );
  const dlg = openDialog({ title: '動画の書き出し', body, actions: [cancelBtn, exportBtn], canClose: () => !running });

  let running = false;
  let controller: AbortController | null = null;
  const controls = [codecSel.el, encoderSel.el, qualitySel.el, mbpsInput.input, portInput.input, tokenInput, connectBtn, ffQualitySel.el, ffCodecSel.el, ffSmartCb.input];

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
    for (const g of browserGroups) g.hidden = isServer();
    for (const g of serverGroups) g.hidden = !isServer();
    if (isServer()) {
      updateServer();
      support.set(hasAudio ? '' : '音声の入ったクリップがないため、音声なしで書き出します');
      support.el.classList.remove('warn');
    } else {
      support.set(checking ? '確認中…' : lines.join('\n') || '✓ この環境で書き出せます');
      support.el.classList.toggle('warn', !checking && (!videoOk || (!aacOk && hasAudio)));
    }

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
    if (prefs.mode === 'smart') notes.push('無劣化コピーできない区間は、下の基準のビットレートで再エンコードします');
    if (prefs.mode === 'source' || prefs.mode === 'smart') {
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
    updateSmart();
    colorNote.set(`${describeColorSpace(exportColorSpace(doc, media))}（メインの最初の動画に合わせます）`);
    noAudioCb.input.disabled = !hasAudio || running;
    for (const c of controls) c.disabled = running;
    const withAudio = hasAudio && !noAudioCb.input.checked;
    exportBtn.disabled = isServer()
      ? running || checking || durationNow() <= 0 || !serverReady()
      : running || checking || durationNow() <= 0 || !videoOk || (withAudio && !aacOk);
  }

  /** サーバで書き出せる状態か */
  function serverReady(): boolean {
    if (!serverInfo) return false;
    return sp.codec === 'avc' ? serverInfo.encoders.libx264 : serverInfo.encoders.libx265;
  }

  /** ローカルサーバの状態の表示 */
  function updateServer(): void {
    const lines: string[] = [];
    if (checking) lines.push('確認中…');
    else if (serverInfo) {
      lines.push(`✓ 接続しました（${serverInfo.ffmpeg.replace(/ Copyright.*$/, '')}）`);
      if (!serverReady()) lines.push(`⚠ この ffmpeg には ${sp.codec === 'avc' ? 'x264' : 'x265'} が入っていません`);
    } else {
      if (serverError) lines.push(`⚠ ${serverError}`);
      lines.push(
        '起動のしかた：プロジェクトのフォルダで npm run export-server を実行し、表示されたトークンを貼り付けて「接続を確認」を押してください。',
        `（ポートを変えた場合は上の番号も合わせてください）。サーバがなくても「ブラウザで書き出し」を選べば書き出せます。`,
      );
    }
    serverStatus.set(lines.join('\n'));
    serverStatus.el.classList.toggle('warn', !checking && !serverReady());
    ffCodecNote.set(sp.codec === 'hevc' ? 'H.265 は Windows 標準の再生ソフト（メディアプレーヤー・フォト）では再生できない場合があります（「HEVC ビデオ拡張機能」が必要）' : '');
  }

  /** コーデックとフレームレートを、メインの最初の動画に合わせる */
  function matchSource(): void {
    const id = mainVideoMediaIds(doc)[0];
    const info = id ? media.get(id)?.info : undefined;
    if (!info) return;
    const fam = codecFamily(info.codecString ?? info.videoCodec);
    if (fam === 'avc' || fam === 'hevc') prefs.codec = fam;
    if (Math.abs(info.fps - 60) / 60 < 0.01) prefs.fps = 60;
    else if (Math.abs(info.fps - 30) / 30 < 0.01) prefs.fps = 30;
  }

  /** 無劣化コピーの表示 */
  function updateSmart(): void {
    const show = isServer() ? sp.smartCopy : prefs.mode === 'smart';
    smartGroup.hidden = !show;
    if (!show) return;
    const p = smartPlan;
    if (checking || !p) {
      smartText.set('確認中…');
      smartNote.set('');
      return;
    }
    smartText.set(`無劣化コピーできる区間：${formatSeconds(p.copySeconds)} / 全体 ${formatSeconds(p.totalSeconds)}`);
    const lines: string[] = [];
    if (!isServer() && prefs.codec !== 'avc' && prefs.codec !== 'hevc') lines.push('⚠ 無劣化コピーは H.264 / H.265 のみです。コーデックを元の動画に合わせてください');
    if (p.copySeconds < p.totalSeconds - 1e-3 && p.reasons.length) lines.push('コピーできない区間の理由（その区間は再エンコード）：', ...p.reasons.map((r) => `・${r}`));
    if (p.copySeconds === 0) lines.push(isServer() ? 'コピーできる区間がないため、全体を ffmpeg で圧縮します' : 'コピーできる区間がないため、全体を「元の動画に合わせる」と同じ設定で書き出します');
    const withAudio = hasAudio && !noAudioCb.input.checked;
    if (withAudio) lines.push(p.audio.copy ? '音声：元の音声をそのままコピー' : `音声：再エンコード（${p.audio.reason ?? ''}）`);
    smartNote.set(lines.join('\n'));
  }

  async function recheck(): Promise<void> {
    const seq = ++checkSeq;
    checking = true;
    update();
    if (isServer()) {
      serverInfo = null;
      serverError = '';
      if (token) {
        try {
          serverInfo = await new ExportServerClient(sp.port, token).info();
        } catch (e) {
          serverError = e instanceof Error ? e.message : String(e);
        }
      }
      if (seq !== checkSeq) return;
      smartPlan = sp.smartCopy ? await ffmpegPlanFor(doc, media, ffmpegOptions()) : null;
      if (seq !== checkSeq) return;
      checking = false;
      update();
      return;
    }
    const r = await checkVideoSupport(doc, media, prefs);
    if (seq !== checkSeq) return;
    if (prefs.mode === 'smart') {
      smartPlan = await smartPlanFor(doc, media, { prefs, range: useRange && ioRange ? ioRange : null, includeAudio: hasAudio && !noAudioCb.input.checked, hardwareAcceleration: r.hardwareAcceleration });
      if (seq !== checkSeq) return;
    }
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

  function ffmpegOptions() {
    return { scale: prefs.scale, fps: prefs.fps, codec: sp.codec, quality: sp.quality, smartCopy: sp.smartCopy, includeAudio: hasAudio && !noAudioCb.input.checked, range: useRange && ioRange ? ioRange : null };
  }

  async function run(): Promise<void> {
    if (exportBtn.disabled) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prefs, v: PREFS_VERSION }));
      localStorage.setItem(SERVER_KEY, JSON.stringify(sp));
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
    const onProgress = (r: number) => {
      progress.value = r;
      const elapsed = (performance.now() - startedAt) / 1000;
      const remain = r > 0.01 ? (elapsed / r) * (1 - r) : 0;
      progressText.set(`${Math.floor(r * 100)}%　経過 ${formatTime(elapsed, false)}${r > 0.01 ? `　残り約 ${formatTime(remain, false)}` : ''}`);
    };
    try {
      if (isServer()) {
        const client = new ExportServerClient(sp.port, token);
        const r = await exportVideoFfmpeg(doc, assets, media, client, ffmpegOptions(), dest.target, onProgress, controller.signal);
        await dest.finish();
        const q = FFMPEG_QUALITY[sp.quality];
        const copied = r.smart.copiedSeconds > 0 ? `・無劣化コピー ${formatSeconds(r.smart.copiedSeconds)}／ffmpeg ${formatSeconds(r.smart.encodedSeconds)}` : '';
        toast(`動画を書き出しました（${formatTime((performance.now() - startedAt) / 1000, false)}・${sp.codec === 'avc' ? 'x264' : 'x265'} CRF ${q.crf} ${q.preset}${copied}${r.audioCopied ? '・音声はコピー' : ''}）`);
        running = false;
        dlg.close();
        return;
      }
      const result = await exportVideo(
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
        onProgress,
        controller.signal,
      );
      await dest.finish();
      const used = result.used;
      const rate = used.quantizer !== null ? `品質固定 QP ${used.quantizer}` : formatMbps(used.bitrate);
      const sm = result.smart;
      const smartText = sm
        ? `・無劣化コピー ${formatSeconds(sm.copiedSeconds)}／再エンコード ${formatSeconds(sm.encodedSeconds)}${result.audioCopied ? '・音声はコピー' : ''}`
        : '';
      toast(`動画を書き出しました（${formatTime((performance.now() - startedAt) / 1000, false)}・${describeCodec(used.codec)}・${rate}・${ACCEL_LABEL[used.hardwareAcceleration as HwAccel] ?? used.hardwareAcceleration}${smartText}）`);
      running = false;
      dlg.close();
    } catch (e) {
      await dest.abort();
      if (e instanceof ExportCanceledError || controller?.signal.aborted) {
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
