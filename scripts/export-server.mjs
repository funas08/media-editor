// 高画質書き出しのためのローカル専用サーバを起動する：npm run export-server [-- --port 8765]
// ffmpeg はプロジェクトの node_modules の中のもの（ffmpeg-static）だけを使う。
// このサーバはなくてもアプリの全機能が動く（ブラウザだけの書き出しも選べる）。

import ffmpegPath from 'ffmpeg-static';
import { existsSync } from 'node:fs';
import { createExportServer, ffmpegInfo, newToken } from './export-server-core.mjs';

const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 8765;
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('ポート番号は 1024〜65535 で指定してください');
  process.exit(1);
}
if (!ffmpegPath || !existsSync(ffmpegPath)) {
  console.error('ffmpeg が見つかりません。プロジェクトで npm install を実行してください（ffmpeg-static）');
  process.exit(1);
}

const info = await ffmpegInfo(ffmpegPath);
const token = newToken();
const time = () => new Date().toLocaleTimeString('ja-JP');
const server = createExportServer({ ffmpegPath, token, info, log: (m) => console.log(`[${time()}] ${m}`) });
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `ポート ${port} は使用中です。--port で別の番号を指定してください` : e);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log('高画質書き出しサーバを起動しました（このパソコンの中だけで使えます）');
  console.log(`  ffmpeg：${info.version}`);
  console.log(`  エンコーダー：x264 ${info.encoders.libx264 ? '○' : '×'} / x265 ${info.encoders.libx265 ? '○' : '×'} / AAC ${info.encoders.aac ? '○' : '×'}`);
  console.log('');
  console.log(`  接続先  ：http://127.0.0.1:${port}`);
  console.log(`  トークン：${token}`);
  console.log('');
  console.log('  書き出しダイアログの「高画質書き出し（ローカルサーバ）」にトークンを貼り付けてください。');
  console.log('  ファイルは保存しません（受け取ったデータを ffmpeg に渡して返すだけ）。終了は Ctrl+C');
});
const stop = () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
