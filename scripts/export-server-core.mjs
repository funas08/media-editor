// 高画質書き出しのためのローカル専用サーバ（本体）。
// ブラウザで合成したフレーム（I420）・音声（f32）を受け取り、そのまま ffmpeg（x264 / x265 / AAC）に渡して、
// 圧縮したデータ（映像：MPEG-TS、音声：ADTS）をブラウザへ返す。MP4 へのまとめと保存はブラウザが行う。
//
// - 127.0.0.1 だけで待ち受ける。Host ヘッダが 127.0.0.1 / localhost 以外の要求は断る（DNS リバインディング対策）
// - 起動時に作ったトークン（X-Export-Token ヘッダ）がない要求は断る（ほかの Web サイトから使われないように）
// - ファイルは保存しない。受け取ったデータは ffmpeg の標準入力へ、ffmpeg の標準出力はそのまま応答へ流すだけ
// - ffmpeg の引数は決まった値（数値・選択肢）からだけ組み立てる。シェルは通さない

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';

export const SERVER_VERSION = 1;
const MAX_JOBS = 4;
/** 何も届かないまま放置されたジョブを止めるまでの時間 */
const IDLE_MS = 120_000;
/** 終わったジョブの結果を残しておく時間 */
const KEEP_MS = 60_000;

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
const MATRIX = { bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'smpte170m' };
const PRIMARIES = { bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'smpte170m' };
const TRANSFER = { bt709: 'bt709', smpte170m: 'smpte170m', 'iec61966-2-1': 'iec61966-2-1' };
const H264_PROFILES = ['baseline', 'main', 'high'];

/** 標準入力が書き込めるようになるか、ffmpeg が終わるまで待つ（待ち受けは毎回片付ける） */
function drainOrExit(proc) {
  return new Promise((resolve) => {
    const done = () => {
      proc.stdin.off('drain', done);
      proc.off('close', done);
      resolve();
    };
    proc.stdin.on('drain', done);
    proc.on('close', done);
  });
}

export function newToken() {
  return randomBytes(24).toString('base64url');
}

function int(v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`範囲外の値：${v}`);
  return n;
}

function pick(v, list) {
  if (!list.includes(v)) throw new Error(`使えない値：${v}`);
  return v;
}

/** 映像のジョブの ffmpeg の引数（受け取る値はすべて確かめる） */
export function videoArgs(p) {
  const codec = pick(p.codec, ['h264', 'h265']);
  const width = int(p.width, 2, 8192);
  const height = int(p.height, 2, 8192);
  if (width % 2 || height % 2) throw new Error('幅・高さは偶数にしてください');
  const fpsNum = int(p.fpsNum, 1, 240000);
  const fpsDen = int(p.fpsDen, 1, 100000);
  const crf = int(p.crf, 0, 51);
  const preset = pick(p.preset, PRESETS);
  const keyint = int(p.keyint, 1, 1000);
  const cs = p.colorSpace ?? {};
  const matrix = MATRIX[cs.matrix] ?? 'bt709';
  const primaries = PRIMARIES[cs.primaries] ?? 'bt709';
  const transfer = TRANSFER[cs.transfer] ?? 'bt709';
  const range = cs.fullRange === true ? 'pc' : 'tv';
  const color = ['-colorspace', matrix, '-color_primaries', primaries, '-color_trc', transfer, '-color_range', range];
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-framerate', `${fpsNum}/${fpsDen}`, ...color, '-i', 'pipe:0'];
  if (codec === 'h264') {
    const profile = p.profile == null ? 'high' : pick(p.profile, H264_PROFILES);
    args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', profile);
    if (p.level != null) args.push('-level:v', String(int(p.level, 10, 62) / 10));
    // repeat-headers：キーフレームごとに SPS / PPS を入れる（無劣化コピーした区間とつなぐため）
    args.push('-x264-params', `keyint=${keyint}:min-keyint=1:repeat-headers=1`);
  } else {
    args.push('-c:v', 'libx265', '-preset', preset, '-crf', String(crf), '-profile:v', 'main', '-tag:v', 'hvc1');
    args.push('-x265-params', `keyint=${keyint}:min-keyint=1:repeat-headers=1:log-level=error`);
  }
  args.push('-pix_fmt', 'yuv420p', ...color, '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1');
  return args;
}

/** 音声のジョブの ffmpeg の引数 */
export function audioArgs(p) {
  const sampleRate = pick(Number(p.sampleRate), [44100, 48000]);
  const channels = int(p.channels, 1, 2);
  const bitrate = int(p.bitrate, 64_000, 512_000);
  return ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0', '-c:a', 'aac', '-b:a', String(bitrate), '-f', 'adts', 'pipe:1'];
}

/** ffmpeg の版と、使えるエンコーダー */
export async function ffmpegInfo(ffmpegPath) {
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(out));
    });
  const version = (await run(['-hide_banner', '-version'])).split('\n')[0] ?? '';
  const enc = await run(['-hide_banner', '-encoders']);
  return { version, encoders: { libx264: /\blibx264\b/.test(enc), libx265: /\blibx265\b/.test(enc), aac: /\baac\b/.test(enc) } };
}

/**
 * サーバを作る（listen は呼び出し側）。
 * @param {{ ffmpegPath: string, token: string, info: object, log?: (m: string) => void }} o
 */
export function createExportServer(o) {
  const log = o.log ?? (() => {});
  const tokenBuf = Buffer.from(o.token);
  /** @type {Map<string, any>} */
  const jobs = new Map();
  let port = 0;

  const tokenOk = (req) => {
    const t = req.headers['x-export-token'];
    if (typeof t !== 'string') return false;
    const b = Buffer.from(t);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };
  const hostOk = (req) => {
    const host = String(req.headers.host ?? '');
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };
  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'X-Export-Token, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  };
  const send = (res, code, body) => {
    if (res.headersSent) return res.end();
    if (body === undefined) {
      res.writeHead(code).end();
      return;
    }
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  };
  const readJson = async (req) => {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new Error('大きすぎます');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };

  const touch = (job) => {
    clearTimeout(job.idle);
    job.idle = setTimeout(() => {
      log(`ジョブ ${job.id} は応答がないため停止しました`);
      kill(job);
    }, IDLE_MS);
  };
  const kill = (job) => {
    clearTimeout(job.idle);
    if (job.exit === null) job.proc.kill('SIGKILL');
  };
  const forget = (job) => setTimeout(() => jobs.delete(job.id), KEEP_MS).unref();

  const startJob = (params) => {
    if ([...jobs.values()].filter((j) => j.exit === null).length >= MAX_JOBS) throw new Error('同時に実行できる書き出しの数を超えました');
    const args = params.type === 'audio' ? audioArgs(params) : params.type === 'video' ? videoArgs(params) : null;
    if (!args) throw new Error('種類（video / audio）を指定してください');
    const id = randomBytes(8).toString('hex');
    const proc = spawn(o.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const job = { id, type: params.type, proc, exit: null, stderr: '', idle: null, reading: false, startedAt: Date.now() };
    proc.stderr.on('data', (d) => {
      job.stderr = (job.stderr + d).slice(-4000);
    });
    // 入力を閉じたあとに ffmpeg が終わった場合など、書き込みのエラーは結果（終了コード）で伝える
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => {
      job.stderr += `\n${e.message}`;
      job.exit = -1;
    });
    proc.on('close', (code, signal) => {
      job.exit = code ?? (signal ? -1 : 0);
      clearTimeout(job.idle);
      log(`ジョブ ${id}（${params.type}）終了：${job.exit}（${((Date.now() - job.startedAt) / 1000).toFixed(1)} 秒）`);
      forget(job);
    });
    jobs.set(id, job);
    touch(job);
    log(`ジョブ ${id}（${params.type}）開始`);
    return job;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return send(res, 403, { error: 'host' });
      cors(req, res);
      if (req.method === 'OPTIONS') return send(res, 204);
      if (!tokenOk(req)) return send(res, 401, { error: 'トークンが違います' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/info') return send(res, 200, { app: 'image-editor-export-server', serverVersion: SERVER_VERSION, ffmpeg: o.info.version, encoders: o.info.encoders });
      if (req.method === 'POST' && url.pathname === '/jobs') {
        let job;
        try {
          job = startJob(await readJson(req));
        } catch (e) {
          return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
        return send(res, 200, { id: job.id });
      }
      if (parts[0] !== 'jobs' || !parts[1]) return send(res, 404, { error: 'not found' });
      const job = jobs.get(parts[1]);
      if (!job) return send(res, 404, { error: 'ジョブがありません' });
      const action = parts[2] ?? '';
      if (req.method === 'POST' && action === 'input') {
        touch(job);
        for await (const chunk of req) {
          if (job.exit !== null) break;
          if (!job.proc.stdin.write(chunk)) await drainOrExit(job.proc);
          touch(job);
        }
        if (job.exit !== null) return send(res, 409, { error: 'ffmpeg が終了しています', code: job.exit, stderr: job.stderr });
        return send(res, 204);
      }
      if (req.method === 'POST' && action === 'end') {
        touch(job);
        job.proc.stdin.end();
        return send(res, 204);
      }
      if (req.method === 'GET' && action === 'output') {
        if (job.reading) return send(res, 409, { error: '出力はすでに読まれています' });
        job.reading = true;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
        job.proc.stdout.on('data', () => touch(job));
        job.proc.stdout.pipe(res);
        // 受け取り側が切れたら ffmpeg も止める
        res.on('close', () => {
          if (!res.writableFinished) kill(job);
        });
        return;
      }
      if (req.method === 'GET' && action === 'result') {
        if (job.exit === null) await once(job.proc, 'close');
        return send(res, 200, { code: job.exit, stderr: job.stderr });
      }
      if (req.method === 'DELETE' && action === '') {
        kill(job);
        return send(res, 204);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log(`エラー：${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) send(res, 500, { error: 'server error' });
      else res.destroy();
    }
  });
  server.on('listening', () => {
    const a = server.address();
    if (a && typeof a === 'object') port = a.port;
  });
  server.on('close', () => {
    for (const j of jobs.values()) kill(j);
  });
  return server;
}
